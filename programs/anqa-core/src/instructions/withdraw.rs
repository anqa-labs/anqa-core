//! Withdraw collateral.
//!
//! The second and last instruction where tokens move. Custody flows out only
//! after the kernel proves the money is actually the trader's.
//!
//! ## What the kernel enforces, and what it means for users
//!
//! `withdraw_not_atomic` is deliberately strict:
//!
//! - **The account must be flat.** An open position anywhere blocks withdrawal
//!   (`active_bitmap` must be empty). You cannot pull collateral out from under
//!   a live position, not even "excess" margin.
//! - **Negative PnL settles first**, out of principal, before anything leaves.
//! - **Wins must be realised, not merely on paper**: `pnl < 0` blocks, the
//!   amount cannot exceed booked capital, and equity after the withdrawal must
//!   still be non-negative.
//!
//! This is the visible end of "losses are senior, wins are junior" — a trader
//! cannot withdraw money the system has not proven it holds on their behalf.
//! It is more conservative than venues that let you withdraw free margin while
//! positioned; revisit only with a very good reason.
//!
//! Anqa adds one rule of its own: resting orders must be cancelled first, since
//! their reserved margin is Anqa-side bookkeeping the kernel cannot see.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ASSET_SLOTS_SEED, MARKET_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED, VAULT_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    #[account(mut)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, AnqaError::InvalidSize);

    let market_id = ctx.accounts.market.market_id;

    // 1. Ask the kernel. It settles losses, checks the account is flat and
    //    solvent, and debits capital — or refuses.
    {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut portfolio = ctx.accounts.portfolio.load_mut()?;

        require!(
            portfolio.reserved() == 0,
            AnqaError::WithdrawWithRestingOrders
        );

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());

        map_risk(view.full_account_refresh_not_atomic(&mut pv))?;
        map_risk(view.withdraw_not_atomic(&mut pv, amount as u128))?;
    }

    // 2. Only now do the tokens move. The vault is its own authority, so no
    //    human key can move collateral out of band.
    let market_id_bytes = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[VAULT_SEED, &market_id_bytes, &[ctx.bumps.vault]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.trader_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    msg!("anqa: withdrew {} collateral", amount);
    Ok(())
}
