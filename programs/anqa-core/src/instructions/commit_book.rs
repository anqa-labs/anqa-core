//! Commit book state from the rollup back to base chain.
//!
//! `commit_book` checkpoints without giving up the rollup; `commit_and_undelegate`
//! returns the account to base chain entirely — the escape hatch that keeps the
//! venue non-custodial even if the rollup stops.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::state::Book;

#[commit]
#[derive(Accounts)]
pub struct CommitBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Zero-copy; see `state::book`.
    #[account(mut)]
    pub book: AccountLoader<'info, Book>,
}

pub fn commit_handler(ctx: Context<CommitBook>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.book.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: book committed");
    Ok(())
}

pub fn commit_and_undelegate_handler(ctx: Context<CommitBook>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.book.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: book committed and undelegated");
    Ok(())
}
