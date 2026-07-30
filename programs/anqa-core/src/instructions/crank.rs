//! Advance the risk engine: mark price and funding.
//!
//! Cadence is a solvency parameter, not an ops detail. The kernel refuses any
//! configuration where maintenance margin cannot cover the worst case between
//! accruals, which is why Anqa's 20x launch cap pins the mark to at most 1%
//! movement per crank. Miss cranks during a fast move and the shortfall becomes
//! bad debt against the vault rather than the trader's collateral.
//!
//! `mark_price` is supplied by the caller today; it becomes a Pyth Lazer read
//! with confidence gating before mainnet — a venue must never let the crank
//! choose its own truth.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

#[derive(Accounts)]
pub struct Crank<'info> {
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
}

pub fn handler(
    ctx: Context<Crank>,
    asset_index: u32,
    mark_price: u64,
    funding_rate_e9: i128,
) -> Result<()> {
    require!(
        (asset_index as usize) < crate::constants::MAX_ASSETS,
        AnqaError::BadAssetIndex
    );

    let slot = Clock::get()?.slot;
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut view = MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

    map_risk(view.accrue_asset_to_not_atomic(
        asset_index as usize,
        slot,
        mark_price,
        funding_rate_e9,
        true,
    ))?;

    msg!("anqa: crank -> mark {} funding {}", mark_price, funding_rate_e9);
    Ok(())
}

/// Settle one account against the latest accrual: funding paid or received,
/// losses booked, health certificate refreshed.
#[derive(Accounts)]
pub struct RefreshPortfolio<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn refresh_handler(ctx: Context<RefreshPortfolio>) -> Result<()> {
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut portfolio = ctx.accounts.portfolio.load_mut()?;

    let mut view = MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());
    map_risk(view.full_account_refresh_not_atomic(&mut pv))?;

    Ok(())
}
