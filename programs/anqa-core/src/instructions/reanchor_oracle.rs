//! Re-anchor an asset's accrual clock — run once inside the rollup, right
//! after delegation, before the first trade.
//!
//! ## Why this exists
//!
//! The risk group is initialized on base layer, so its accrual clock
//! (`slot_last`) is anchored to **base-chain slots**. The rollup runs its own,
//! much faster slot stream — on devnet it reads ~28 million slots ahead. The
//! kernel accrues bounded segments per crank (that bound *is* the leverage
//! cadence guarantee), so it can never walk across a 28M-slot gap: every crank
//! leaves `slot_last < now`, `loss_stale_active` stays armed, and every fill
//! is refused with `LockActive`. Found live on devnet.
//!
//! ## Why it is safe to expose permissionlessly
//!
//! The kernel refuses the re-anchor unless the market is *empty* — no
//! positions, no loss state anywhere in the group (its
//! `group_has_position_or_loss_state_for_oracle_reset` gate). An empty market
//! has no funding to skip and no losses to hide, so jumping its clock forfeits
//! nothing. The price comes from the validated relay, never the caller. Once
//! trading begins the gate closes and the clock advances only by cranks.
//!
//! One per asset, in the same session-start sequence:
//! `sync relay (ER) → reanchor (ER) → crank (ER) → trade`.

use anchor_lang::prelude::*;
use percolator::MarketGroupV16ViewMut;

use crate::constants::{
    ASSET_SLOTS_SEED, INTERNAL_ORACLE_SEED, MARKET_SEED, ORACLE_STATE_SEED, RISK_GROUP_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::state::{
    accept_mark, read_internal, AssetSlots, InternalOracle, Market, OracleState, RiskGroup,
};

#[derive(Accounts)]
pub struct ReanchorOracle<'info> {
    /// Permissionless — the kernel's empty-market gate is the authority.
    pub cranker: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(mut, seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    /// The relayed price — same trust path as the crank.
    #[account(seeds = [INTERNAL_ORACLE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub internal_oracle: Account<'info, InternalOracle>,
}

pub fn handler(ctx: Context<ReanchorOracle>, asset_index: u32) -> Result<()> {
    require!(
        (asset_index as usize) < crate::constants::MAX_ASSETS,
        AnqaError::BadAssetIndex
    );

    let market = &ctx.accounts.market;
    let primary = read_internal(
        &ctx.accounts.internal_oracle,
        &market.oracle.feed_id,
        market.oracle.max_age_secs,
        market.oracle.max_conf_bps,
    )?;
    let mark_price = accept_mark(
        &mut ctx.accounts.oracle_state,
        &market.oracle,
        primary,
        None,
        market.quote_decimals,
    )?;

    let slot = Clock::get()?.slot;
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

    map_risk(view.reset_empty_asset_oracle_anchor_not_atomic(
        asset_index as usize,
        mark_price,
        slot,
    ))?;

    msg!(
        "anqa: asset {} re-anchored to slot {} at mark {}",
        asset_index,
        slot,
        mark_price
    );
    Ok(())
}
