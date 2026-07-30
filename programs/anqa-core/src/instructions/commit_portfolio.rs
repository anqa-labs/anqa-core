//! Rollup: checkpoint the portfolio to base layer without giving up the rollup.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::AnqaError;
use crate::state::Portfolio;

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
/// Worth doing often: every commit is a state a forced exit could settle
/// against, so the gap between commits is the window in which a stalled rollup
/// could strand a trader.
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
