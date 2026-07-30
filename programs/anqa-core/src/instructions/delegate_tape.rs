//! Delegate the fill tape into the ephemeral rollup.
//!
//! Goes in with the trading set (`settle_fill` writes it on every dark
//! print), but — unlike the book — it is deliberately **never permissioned**:
//! the tape is the public face of a dark market. See `delegate_book.rs` for
//! the full delegated set.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::TAPE_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateTape<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the public fill tape.
    #[account(mut, del, seeds = [TAPE_SEED, &market_id.to_le_bytes()], bump)]
    pub tape: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateTape>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_tape(
        &ctx.accounts.payer,
        &[TAPE_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: fill tape delegated for market {}", market_id);
    Ok(())
}
