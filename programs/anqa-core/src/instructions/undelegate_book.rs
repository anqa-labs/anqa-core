//! Rollup: commit the book and return it to base chain entirely — the escape
//! hatch that keeps the venue non-custodial even if the rollup stops.
//!
//! Shares `CommitBook`'s accounts; the only difference is whether the rollup
//! keeps the account afterwards.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::instructions::commit_book::CommitBook;

pub fn handler(ctx: Context<CommitBook>) -> Result<()> {
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
