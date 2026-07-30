//! Deposit collateral.
//!
//! One of exactly two instructions in this program where tokens actually move
//! (the other is `withdraw`). Trades never transfer tokens — a fill mints a
//! long/short pair in two margin accounts and nothing is delivered. Value only
//! crosses the custody boundary here.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ASSET_SLOTS_SEED, MARKET_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED, VAULT_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(
        mut,
        seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    /// Trader's USDC account.
    #[account(mut)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,

    /// Protocol custody. Holds every trader's collateral; never delegated to the
    /// rollup, so collateral stays outside the enclave's trust boundary.
    #[account(
        mut,
        seeds = [VAULT_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, AnqaError::InvalidSize);

    // 1. Move the tokens.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. Tell the kernel. It owns the accounting; we only own custody.
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut portfolio = ctx.accounts.portfolio.load_mut()?;

    let mut view = MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());
    map_risk(view.deposit_not_atomic(&mut pv, amount as u128))?;

    msg!("anqa: deposited {} collateral", amount);
    Ok(())
}
