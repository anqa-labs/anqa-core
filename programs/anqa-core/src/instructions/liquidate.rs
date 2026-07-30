//! Liquidate an unhealthy account.
//!
//! The kernel does not liquidate on its own — it exposes a transition that
//! refuses (`NonProgress`) while an account is healthy. So the liquidation
//! *policy* is simply: attempt this every crank tick and treat refusal as a
//! no-op. Timing is entirely ours, and it is the single biggest driver of vault
//! losses. Measured on the kernel spike, same trader and same crash:
//!
//!   on time  -> 16% of the position closed, zero bad debt
//!   two ticks late -> 100% closed and real residual bad debt
//!
//! Partial liquidation is native: the kernel closes the minimum needed to
//! restore health, so a punctual crank leaves the trader most of their position.

use anchor_lang::prelude::*;
use percolator::{LiquidationRequestV16, MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

#[event]
pub struct Liquidation {
    pub market_id: u64,
    pub closed_q: u128,
    pub insurance_used: u128,
    pub residual_booked: u128,
    pub fee_charged: u128,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    /// Permissionless — anyone may keep the book solvent.
    pub liquidator: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// The account under water.
    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<Liquidate>, asset_index: u32) -> Result<()> {
    require!(
        (asset_index as usize) < crate::constants::MAX_ASSETS,
        AnqaError::BadAssetIndex
    );

    let market_id = ctx.accounts.market.market_id;
    let outcome = {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut portfolio = ctx.accounts.portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());

        map_risk(view.liquidate_account_not_atomic(
            &mut pv,
            LiquidationRequestV16 {
                asset_index: asset_index as usize,
            },
        ))?
    };

    // If the liquidation closed the position entirely, its triggers go too —
    // an orphaned stop attaches to the trader's next position.
    if ctx
        .accounts
        .portfolio
        .load()?
        .current_position(asset_index)
        .is_none()
    {
        ctx.accounts
            .portfolio
            .load_mut()?
            .clear_asset_triggers(asset_index as u8);
    }

    emit!(Liquidation {
        market_id,
        closed_q: outcome.closed_q,
        insurance_used: outcome.insurance_used,
        residual_booked: outcome.residual_booked,
        fee_charged: outcome.fee_charged,
    });

    msg!(
        "anqa: liquidated — closed {} insurance {} bad debt {}",
        outcome.closed_q,
        outcome.insurance_used,
        outcome.residual_booked
    );
    Ok(())
}
