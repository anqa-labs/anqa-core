//! Rollup: checkpoint the portfolio to base layer without giving up the rollup.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::AnqaError;
use crate::state::Portfolio;

/// Permissionless checkpoint — **only while the portfolio is flat**.
///
/// A commit writes the account to base layer in plaintext, and base layer is
/// public Solana: no permission record reaches it, because there is nowhere to
/// install a filter. So a commit taken while a position is open publishes that
/// position — size, entry, margin, and therefore the liquidation price — to
/// anyone willing to call `getAccountInfo`.
///
/// Leaving this open to any signer therefore handed every trader's position to
/// any adversary on demand: call it on somebody's portfolio, read base a second
/// later. The old reasoning here — "a commit can only help the owner" — was
/// written when portfolios were public. For a dark venue it is exactly
/// backwards; a commit is the one operation that destroys the owner's privacy.
///
/// The guard keeps the useful half. Anyone may still snapshot a **flat**
/// portfolio, which is what liveness actually needs — it discloses nothing base
/// does not already know from the deposit ledger, and it keeps `forced_exit`
/// with a truthful state to settle against. What it costs is unrealised PnL if
/// the rollup dies mid-position: the trader exits against their last flat
/// commit and keeps their collateral. That is the trade a dark venue makes, and
/// it is stated rather than discovered.
#[commit]
#[derive(Accounts)]
pub struct CheckpointPortfolio<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn checkpoint_handler(ctx: Context<CheckpointPortfolio>) -> Result<()> {
    require!(
        ctx.accounts.portfolio.load()?.is_flat(),
        AnqaError::PositionOpen
    );

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.portfolio.to_account_info()])
    .build_and_invoke()?;
    msg!("anqa: portfolio checkpointed");
    Ok(())
}

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

/// Checkpoint the portfolio to base layer without giving up the rollup.
///
/// Owner-gated and deliberately **not** flat-guarded: the owner is the one
/// party entitled to trade their own privacy for freshness, and the session-
/// ending path needs to commit a live position on its way out.
///
/// But be clear about what it does. Every commit is a state a forced exit could
/// settle against, so the gap between commits is the window a stalled rollup
/// could strand — and it is equally a plaintext publication of the position to
/// public base layer, permanent and readable by anyone. Call it while flat and
/// it costs nothing; call it holding a position and that position is no longer
/// private, then or ever after.
pub fn handler(ctx: Context<CommitPortfolio>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.portfolio.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: portfolio committed");
    Ok(())
}
