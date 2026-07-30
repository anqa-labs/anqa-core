//! Base layer: flip a market between lit and dark matching.
//!
//! Dark means fills queue on the book and settle through `settle_fill`
//! instead of inline — the mode the private rollup requires, because a taker
//! there cannot name the makers it crosses. Admin-gated and base-only (the
//! market config is never delegated). Flip it while the book is empty and the
//! pending queue drained; the handler enforces the queue half.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED};
use crate::errors::AnqaError;
use crate::state::{Book, Market};

#[derive(Accounts)]
pub struct SetDark<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ AnqaError::Unauthorized
    )]
    pub market: Account<'info, Market>,

    /// CHECK: read manually — the book may be delegated (owned by the
    /// delegation program on base) when this flips; only its pending-queue
    /// bytes are inspected, nothing is written.
    #[account(seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,
}

pub fn handler(ctx: Context<SetDark>, dark: bool) -> Result<()> {
    // Never flip modes over unsettled fills: their settlement path is decided
    // by the mode that queued them.
    {
        let data = ctx.accounts.book.try_borrow_data()?;
        if data.len() >= 8 + core::mem::size_of::<Book>() {
            let book: &Book = bytemuck::from_bytes(&data[8..8 + core::mem::size_of::<Book>()]);
            require!(book.pending_count == 0, AnqaError::PendingFillsFull);
        }
    }
    ctx.accounts.market.dark = dark;
    msg!(
        "anqa: market {} is now {}",
        ctx.accounts.market.market_id,
        if dark { "DARK" } else { "lit" }
    );
    Ok(())
}
