//! Rollup: checkpoint book state back to base chain without giving up the
//! rollup. `undelegate_book` is the variant that also returns the account.

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

pub fn handler(ctx: Context<CommitBook>) -> Result<()> {
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
