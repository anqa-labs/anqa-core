//! Settle one account against the latest accrual: funding paid or received,
//! losses booked, health certificate refreshed.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::map_risk;
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

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

pub fn handler(ctx: Context<RefreshPortfolio>) -> Result<()> {
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut portfolio = ctx.accounts.portfolio.load_mut()?;

    let mut view = MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());
    map_risk(view.full_account_refresh_not_atomic(&mut pv))?;

    Ok(())
}
