//! Deposit collateral.
//!
//! One of exactly two instructions where tokens actually move (the other is
//! `settle_withdraw`). Trades never transfer tokens — a fill mints a long/short
//! pair in two margin accounts and nothing is delivered.
//!
//! This runs on **base layer only** and does two things: move the tokens into
//! the vault, and record them on the trader's ledger. It deliberately does NOT
//! credit the risk engine, because the basket it would credit may be delegated
//! to a rollup and unwritable from here. `claim_deposit` does that from
//! whichever side the basket currently lives on, reading the ledger's monotonic
//! total against the basket's high-water mark.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{LEDGER_SEED, MARKET_SEED, VAULT_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, UserDepositLedger};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Must already exist — see `initialize_ledger`. The ledger is a permanent
    /// record, not something a deposit conjures into being.
    #[account(
        mut,
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump = ledger.bump,
        constraint = ledger.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub ledger: Account<'info, UserDepositLedger>,

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
    pub system_program: Program<'info, System>,
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

    // 2. Record it on the ledger. The basket is credited later by
    //    `claim_deposit`, which may run in a rollup this instruction cannot
    //    reach.
    ctx.accounts.ledger.credit_deposit(amount)?;

    msg!("anqa: deposited {} to the vault and ledger", amount);
    Ok(())
}
