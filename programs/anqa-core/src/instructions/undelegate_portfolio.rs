//! Rollup: commit and hand the portfolio back to base layer.
//!
//! Shares `CommitPortfolio`'s accounts — same state, same authority; the only
//! difference is whether the rollup keeps the account afterwards.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::instructions::commit_portfolio::CommitPortfolio;

/// Commit and hand the portfolio back. The trader's state is fully on base layer
/// afterwards, and they can withdraw without the rollup being involved at all.
pub fn handler(ctx: Context<CommitPortfolio>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.portfolio.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: portfolio committed and returned to base layer");
    Ok(())
}
