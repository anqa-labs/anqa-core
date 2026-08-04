//! Delegate the depth mirror into the ephemeral rollup.
//!
//! It has to live beside the book it mirrors: the book is only readable from
//! inside the rollup, so that is the only place the aggregate can be built.
//! Unlike the book, it is deliberately **never permissioned** — totals per
//! price level are the public face of a dark market. See `delegate_book.rs`
//! for the full delegated set.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::DEPTH_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateDepth<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the public depth mirror.
    #[account(mut, del, seeds = [DEPTH_SEED, &market_id.to_le_bytes()], bump)]
    pub depth: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateDepth>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_depth(
        &ctx.accounts.payer,
        &[DEPTH_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: fill depth delegated for market {}", market_id);
    Ok(())
}
