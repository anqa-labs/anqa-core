//! Hand the book to the ephemeral rollup validator.
//!
//! After delegation the book's contents stop being readable from base chain.
//! Inside a *private* ER the validator runs in a TEE, so resting depth is not
//! visible to the operator either — only permitted readers see their own state.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::BOOK_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ownership transfers to the delegation program; validated by seeds.
    #[account(mut, del, seeds = [BOOK_SEED, &market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateBook>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_book(
        &ctx.accounts.payer,
        &[BOOK_SEED, &market_id.to_le_bytes()],
        DelegateConfig::default(),
    )?;
    msg!("anqa: book for market {} delegated", market_id);
    Ok(())
}
