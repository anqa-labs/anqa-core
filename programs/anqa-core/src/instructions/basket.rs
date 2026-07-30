//! The basket — a trader's account, and moving it into the rollup.
//!
//! `Portfolio` is Anqa's basket: **one account per trader** holding the balance
//! available to trade and every position across every asset in the market
//! group. One account, so delegation is one operation rather than one per
//! market — that aggregation is the whole reason a basket exists.
//!
//! It differs from a pool venue's basket in one way: **orders are not in it.**
//! On a CLOB, resting orders live in the shared book where they can be matched
//! against other people's. A pool venue has no shared book, so every user's
//! pending orders have to be carried in their own account.
//!
//! ## Lifecycle
//!
//! ```text
//!   open_portfolio        create the basket, empty              (base layer)
//!   initialize_ledger     create the deposit record, empty      (base layer)
//!   deposit               tokens -> vault, ledger records it    (base layer)
//!   delegate_portfolio    basket moves into the rollup
//!   claim_deposit         basket credited from the ledger       (rollup)
//!   ... trade ...                                               (rollup)
//!   undelegate_portfolio  basket returns, state committed       (base layer)
//! ```
//!
//! Delegation is session-based on purpose. A trader decides when their state is
//! inside a rollup and when it comes home; nobody is parked there by default.
//! It also keeps the forced-exit story simple — there is always a committed
//! state on base layer to settle against.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{LEDGER_SEED, MARKET_SEED, PORTFOLIO_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, Portfolio, UserDepositLedger};

#[event]
pub struct LedgerInitialized {
    pub market_id: u64,
    pub owner: Pubkey,
}

#[event]
pub struct BasketDelegated {
    pub market_id: u64,
    pub owner: Pubkey,
}

// ───────────────────────── ledger, created empty ─────────────────────────

#[derive(Accounts)]
pub struct InitializeLedger<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = trader,
        space = 8 + UserDepositLedger::INIT_SPACE,
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    pub system_program: Program<'info, System>,
}

/// Create the deposit ledger with no balance.
///
/// Separate from `deposit` on purpose: the ledger is a permanent base-layer
/// record of everything a trader ever pays in or takes out, and it must exist
/// independently of whether a deposit happens to be in flight. It is also the
/// account the rollup reads, so it cannot be conjured mid-transaction from
/// inside one.
pub fn initialize_ledger(ctx: Context<InitializeLedger>) -> Result<()> {
    let l = &mut ctx.accounts.ledger;
    l.owner = ctx.accounts.trader.key();
    l.market_id = ctx.accounts.market.market_id;
    l.deposited = 0;
    l.withdrawn = 0;
    l.reserved = 0;
    l.bump = ctx.bumps.ledger;

    emit!(LedgerInitialized {
        market_id: l.market_id,
        owner: l.owner,
    });
    msg!("anqa: deposit ledger opened, empty");
    Ok(())
}

// ─────────────────────── basket into the rollup ───────────────────────

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegatePortfolio<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    /// CHECK: ownership transfers to the delegation program; seeds bind it to
    /// this trader and market, so nobody can delegate somebody else's basket.
    #[account(
        mut,
        del,
        seeds = [PORTFOLIO_SEED, &market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub portfolio: AccountInfo<'info>,
}

pub fn delegate_portfolio(ctx: Context<DelegatePortfolio>, market_id: u64) -> Result<()> {
    let trader = ctx.accounts.trader.key();
    ctx.accounts.delegate_portfolio(
        &ctx.accounts.trader,
        &[PORTFOLIO_SEED, &market_id.to_le_bytes(), trader.as_ref()],
        DelegateConfig::default(),
    )?;

    emit!(BasketDelegated {
        market_id,
        owner: trader,
    });
    msg!("anqa: basket delegated to the rollup");
    Ok(())
}

// ─────────────────────── basket back to base layer ───────────────────────

#[commit]
#[derive(Accounts)]
pub struct CommitPortfolio<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

/// Checkpoint the basket to base layer without giving up the rollup.
///
/// Worth doing often: every commit is a state a forced exit could settle
/// against, so the gap between commits is the window in which a stalled rollup
/// could strand a trader.
pub fn commit_portfolio(ctx: Context<CommitPortfolio>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.portfolio.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: basket committed");
    Ok(())
}

/// Commit and hand the basket back. The trader's state is fully on base layer
/// afterwards, and they can withdraw without the rollup being involved at all.
pub fn undelegate_portfolio(ctx: Context<CommitPortfolio>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.portfolio.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: basket committed and returned to base layer");
    Ok(())
}
