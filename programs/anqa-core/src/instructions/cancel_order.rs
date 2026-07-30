//! Cancel a resting order.
//!
//! Ownership is enforced inside the book: only the trader who placed an order can
//! remove it, and the lookup never reveals whether an order exists to anyone else.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED, SEAT_SEED};
use crate::errors::AnqaError;
use crate::events::OrderCancelled;
use crate::state::{Book, Market, Seat, Side};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Zero-copy; see `state::book`.
    #[account(mut, seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    #[account(
        mut,
        seeds = [SEAT_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump = seat.bump,
        constraint = seat.market_id == market.market_id @ AnqaError::WrongMarket
    )]
    pub seat: Account<'info, Seat>,
}

pub fn handler(ctx: Context<CancelOrder>, side: Side, client_order_id: u64) -> Result<()> {
    let trader_key = ctx.accounts.trader.key();
    {
        let mut book = ctx.accounts.book.load_mut()?;
        book.side_mut(side).cancel(&trader_key, client_order_id)?;
    }

    let seat = &mut ctx.accounts.seat;
    seat.open_orders = seat.open_orders.saturating_sub(1);

    emit!(OrderCancelled {
        market_id: ctx.accounts.market.market_id,
        client_order_id,
    });

    Ok(())
}
