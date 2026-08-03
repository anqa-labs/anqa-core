//! Promote proven-backed profit into withdrawable capital.
//!
//! This is the other half of the haircut, and without it the venue is broken in
//! a way that only shows up once somebody wins.
//!
//! The kernel keeps two separate pots on an account:
//!
//! - `capital` — money that is definitely yours. Withdrawal is bounded by this.
//! - `pnl` — profit that is **junior**: real, but only spendable to the extent
//!   the engine can prove someone actually funded it.
//!
//! That distinction is the whole "losses are senior, wins are junior" design. A
//! loser's debit lands immediately; a winner's credit waits until the engine can
//! point at the collateral backing it. It is also what the haircut impairs when
//! a bankruptcy outruns insurance — the shortfall is taken out of junior claims
//! rather than paid from money that does not exist.
//!
//! But junior profit has to become senior eventually, or nobody can ever take
//! winnings home. `convert_released_pnl_to_capital` is that promotion: it moves
//! whatever portion of `pnl` the kernel can now prove is backed into `capital`,
//! where `withdraw` can reach it.
//!
//! Permissionless, because it can only ever help the account it touches — it
//! moves value from a restricted pot into a less restricted one belonging to the
//! same owner, and the kernel decides how much qualifies.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::map_risk;
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

#[event]
pub struct PnlRealized {
    pub market_id: u64,
    pub account: Pubkey,
    pub converted: u128,
}

#[derive(Accounts)]
pub struct RealizePnl<'info> {
    /// Permissionless — anyone may promote anyone's proven profit.
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.group_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.group_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<RealizePnl>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let account_key = ctx.accounts.portfolio.key();

    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut pf = ctx.accounts.portfolio.load_mut()?;

    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    let mut pv = PortfolioV16ViewMut::new(pf.account_mut());

    // Settle against the latest accrual first, so the conversion is measured
    // against a current view of what is backed rather than a stale one.
    map_risk(view.full_account_refresh_not_atomic(&mut pv))?;
    let converted = map_risk(view.convert_released_pnl_to_capital_not_atomic(&mut pv))?;

    emit!(PnlRealized {
        market_id,
        account: account_key,
        converted,
    });
    msg!("anqa: promoted {} of junior pnl to capital", converted);
    Ok(())
}
