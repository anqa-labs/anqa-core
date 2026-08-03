//! Stand up the risk engine for a market group.
//!
//! Creates the Percolator market-group header and the per-asset engine slots,
//! then activates one asset per market at its opening mark.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use percolator::{
    EngineAssetSlotV16Account, Market as PercMarket, MarketGroupV16HeaderAccount,
    MarketGroupV16ViewMut, V16Config,
};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, MAX_ASSETS, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{read_pyth, AssetSlots, AssetTag, Market, RiskGroup};

/// Anqa's launch risk parameters.
///
/// The two margin numbers are not free: the kernel refuses any configuration
/// where maintenance margin cannot cover the worst case between accruals
/// (price move + funding + liquidation fee), and rejects it at construction.
/// Measured envelope: `max_price_move_bps <= ~MM_bps / 2.5`. So 20x leverage
/// (MM 250bps) permits at most a 1% mark move per accrual — which makes crank
/// cadence a solvency parameter, not an ops detail.
pub const INITIAL_MARGIN_BPS: u64 = 500; // 20x
pub const MAINTENANCE_MARGIN_BPS: u64 = 250; // 2.5%
pub const MAX_FUNDING_E9_PER_SLOT: u64 = 10_000;
pub const LIQUIDATION_FEE_BPS: u64 = 0;

/// How far one crank may carry the accrual clock, in slots.
///
/// **This has to be sized against the rollup, not base chain.** Measured on
/// MagicBlock devnet: the rollup produces ~20 slots/sec against base chain's
/// ~2.7 — roughly 7x. The kernel advances `slot_last` by at most this many
/// slots per accrual, so a value of 1 (which is fine on a slow chain) leaves
/// the clock permanently behind a rollup: it can never converge, loss
/// staleness stays armed, and every fill is refused with `LockActive`.
///
/// Worse than the liveness failure is the quiet one: funding accrues over
/// `segment_dt`, so a clamped clock under-accrues funding by the same factor
/// it is behind. Traders would pay ~20x too little.
///
/// 100 slots is five seconds of rollup time, or thirty-seven of base — enough
/// headroom for a keeper cranking every second or two to miss a few ticks and
/// still catch up.
pub const MAX_ACCRUAL_DT_SLOTS: u64 = 100;

/// Permitted mark movement per slot, in basis points.
///
/// The kernel's safety check is `price_move <= move_bps_per_slot * dt`, so the
/// bound that matters is the **product**: 1 bps x 100 slots = 1% per full
/// accrual, exactly the envelope 20x leverage allows (`max_price_move_bps <=
/// ~MM_bps / 2.5`). Expressing it per-slot rather than per-crank is also more
/// honest than the old constant: a crank that arrives promptly now permits a
/// proportionally smaller jump, instead of allowing a full 1% however little
/// time has passed.
pub const MAX_PRICE_MOVE_BPS_PER_SLOT: u64 = 1;

pub fn anqa_risk_config(asset_count: u32) -> V16Config {
    // Two different capacities: `max_market_slots` is how many assets the
    // venue lists (this group's slot count); `max_portfolio_assets` is how
    // many of them one trader may hold positions in at once, and the kernel
    // hard-caps it at `V16_MAX_PORTFOLIO_ASSETS_N` (its legs are sparse —
    // each records its asset index — so listings can exceed it).
    let mut cfg = V16Config::public_user_fund_with_market_slots(
        (percolator::V16_MAX_PORTFOLIO_ASSETS_N as u16).min(asset_count as u16),
        asset_count,
        0,
        10,
    );
    cfg.initial_margin_bps = INITIAL_MARGIN_BPS;
    cfg.maintenance_margin_bps = MAINTENANCE_MARGIN_BPS;
    cfg.max_price_move_bps_per_slot = MAX_PRICE_MOVE_BPS_PER_SLOT;
    cfg.max_accrual_dt_slots = MAX_ACCRUAL_DT_SLOTS;
    // A funding epoch must outlive a whole accrual window, or the kernel
    // could accrue across an epoch it has already retired.
    cfg.min_funding_lifetime_slots = MAX_ACCRUAL_DT_SLOTS;
    cfg.max_abs_funding_e9_per_slot = MAX_FUNDING_E9_PER_SLOT;
    cfg.liquidation_fee_bps = LIQUIDATION_FEE_BPS;
    cfg
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeRisk<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<RiskGroup>(),
        seeds = [RISK_GROUP_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    /// Pre-created and pre-sized by `prepare_asset_slots` — at `MAX_ASSETS`
    /// slots the account exceeds the 10,240-byte CPI allocation limit, so it
    /// cannot be `init`ed here. `zero` verifies it is program-owned and never
    /// initialized; the seeds pin it to this group's PDA.
    #[account(
        zero,
        seeds = [ASSET_SLOTS_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// The opening mark comes from Pyth too — not even the authority should be
    /// able to seed a market at a price of its choosing.
    pub price_update: Account<'info, PriceUpdateV2>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeRisk>,
    market_id: u64,
    asset_count: u32,
) -> Result<()> {
    require!(
        asset_count > 0 && asset_count as usize <= MAX_ASSETS,
        AnqaError::BadAssetIndex
    );
    // `zero` checked ownership and the untouched discriminator; the size is
    // still `prepare_asset_slots`'s responsibility, so verify it got there.
    require!(
        ctx.accounts.asset_slots.to_account_info().data_len()
            == 8 + std::mem::size_of::<AssetSlots>(),
        AnqaError::AssetSlotsNotPrepared
    );

    let m = &ctx.accounts.market;
    let opening_mark = read_pyth(
        &ctx.accounts.price_update,
        &m.oracle.feed_id,
        m.oracle.max_age_secs,
        m.oracle.max_conf_bps,
    )?
    .to_quote_atoms(m.quote_decimals)?;

    let cfg = anqa_risk_config(asset_count);
    let slot = Clock::get()?.slot;

    let mut group = ctx.accounts.risk_group.load_init()?;
    let mut slots = ctx.accounts.asset_slots.load_init()?;

    // The kernel validates the whole solvency envelope here and refuses
    // configurations it cannot prove safe.
    *group.header_mut() = map_risk(MarketGroupV16HeaderAccount::new_dynamic(
        market_id.to_le_bytes()
            .iter()
            .chain(core::iter::repeat(&0u8))
            .take(32)
            .copied()
            .collect::<Vec<u8>>()
            .try_into()
            .map_err(|_| AnqaError::MathOverflow)?,
        cfg,
        asset_count,
        slot,
    ))?;

    for i in 0..asset_count as usize {
        slots.markets_mut()[i] = PercMarket::new(
            (i as u64).to_le_bytes() as AssetTag,
            EngineAssetSlotV16Account::default(),
        );
    }

    // Only the first asset activates here: the kernel enforces a one-slot
    // cooldown between activations, so the rest arrive via `activate_asset`
    // in their own transactions — each priced by its own market's feed.
    {
        let header = group.header_mut();
        let engine = &mut slots.markets_mut()[0].engine;
        map_risk(header.activate_empty_asset_slot_not_atomic(0, engine, opening_mark, slot))?;
    }

    {
        let view = MarketGroupV16ViewMut::new(
            group.header_mut(),
            &mut slots.markets_mut()[..asset_count as usize],
        );
        map_risk(view.validate_shape())?;
    }

    msg!(
        "anqa: risk engine live for market {} — {} asset(s), {}x max leverage, mark {}",
        market_id,
        asset_count,
        10_000 / INITIAL_MARGIN_BPS,
        opening_mark
    );
    Ok(())
}
