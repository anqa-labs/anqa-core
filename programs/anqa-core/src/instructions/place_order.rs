//! Place an order.
//!
//! Crankless: the taker crosses the resting book inside this instruction, so a
//! fill is final when the transaction lands. Runs inside the ephemeral rollup,
//! where the book it reads and writes is invisible to everyone outside.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED, SEAT_SEED};
use crate::errors::AnqaError;
use crate::events::{Fill, OrderAccepted};
use crate::state::{Book, Market, OrderType, Seat, Side};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Zero-copy; see `state::book` for why this is not a borsh account.
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

pub fn handler(
    ctx: Context<PlaceOrder>,
    side: Side,
    order_type: OrderType,
    price_in_ticks: u64,
    base_lots: u64,
    client_order_id: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.paused, AnqaError::MarketPaused);

    let trader_key = ctx.accounts.trader.key();

    let (fills, resting, fill_count_after) = {
        let mut book = ctx.accounts.book.load_mut()?;
        let (fills, resting) = book.place(
            side,
            order_type,
            price_in_ticks,
            base_lots,
            trader_key,
            client_order_id,
        )?;
        let fill_count_after = book.fill_count;
        (fills, resting, fill_count_after)
    };

    let now = Clock::get()?.unix_timestamp;
    let market_id = market.market_id;
    let mut taker_base: u64 = 0;
    let mut taker_quote: u64 = 0;
    let mut fill_seq = fill_count_after - fills.len() as u64;

    for f in fills.iter() {
        let notional = market
            .quote_notional(f.price_in_ticks, f.base_lots)
            .ok_or(AnqaError::MathOverflow)?;
        taker_base = taker_base
            .checked_add(f.base_lots)
            .ok_or(AnqaError::MathOverflow)?;
        taker_quote = taker_quote
            .checked_add(notional)
            .ok_or(AnqaError::MathOverflow)?;

        fill_seq += 1;
        // The public tape. Price, size, sequence, time — nothing else.
        emit!(Fill {
            market_id,
            price_in_ticks: f.price_in_ticks,
            base_lots: f.base_lots,
            fill_seq,
            timestamp: now,
        });
    }

    let seat = &mut ctx.accounts.seat;
    seat.base_lots_filled = seat.base_lots_filled.saturating_add(taker_base);
    seat.quote_atoms_filled = seat.quote_atoms_filled.saturating_add(taker_quote);

    if taker_quote > 0 {
        let fee = (taker_quote as u128)
            .checked_mul(market.taker_fee_bps as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128;
        seat.fees_paid = seat.fees_paid.saturating_add(fee as i64);
    }
    if resting > 0 {
        seat.open_orders = seat.open_orders.saturating_add(1);
    }

    // Carries no price, size, or side — only the caller's own nonce back to them.
    emit!(OrderAccepted {
        market_id,
        client_order_id,
    });

    Ok(())
}
