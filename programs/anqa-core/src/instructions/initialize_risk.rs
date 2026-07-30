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
pub const MAX_PRICE_MOVE_BPS_PER_SLOT: u64 = 100; // 1% per accrual — see above
pub const MAX_FUNDING_E9_PER_SLOT: u64 = 10_000;
pub const LIQUIDATION_FEE_BPS: u64 = 0;

pub fn anqa_risk_config(asset_count: u32) -> V16Config {
    let mut cfg = V16Config::public_user_fund_with_market_slots(
        asset_count as u16,
        asset_count,
        0,
        10,
    );
    cfg.initial_margin_bps = INITIAL_MARGIN_BPS;
    cfg.maintenance_margin_bps = MAINTENANCE_MARGIN_BPS;
    cfg.max_price_move_bps_per_slot = MAX_PRICE_MOVE_BPS_PER_SLOT;
    cfg.max_accrual_dt_slots = 1;
    cfg.min_funding_lifetime_slots = 1;
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

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<AssetSlots>(),
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

    for i in 0..asset_count as usize {
        let header = group.header_mut();
        let engine = &mut slots.markets_mut()[i].engine;
        map_risk(header.activate_empty_asset_slot_not_atomic(
            i as u32,
            engine,
            opening_mark,
            slot,
        ))?;
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
