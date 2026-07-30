//! Claim a trading seat.
//!
//! A seat is per-trader, per-market. It accrues fills and — once the book is
//! delegated into a private ephemeral rollup — it is the unit of read
//! permission: a trader may be granted sight of their own seat and nothing else.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, SEAT_SEED};
use crate::state::{Market, Seat};

#[derive(Accounts)]
pub struct ClaimSeat<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = trader,
        space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub seat: Account<'info, Seat>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimSeat>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let seat = &mut ctx.accounts.seat;

    seat.market_id = market.market_id;
    seat.trader = ctx.accounts.trader.key();
    seat.base_lots_filled = 0;
    seat.quote_atoms_filled = 0;
    seat.fees_paid = 0;
    seat.open_orders = 0;
    seat.bump = ctx.bumps.seat;

    market.seat_count = market.seat_count.saturating_add(1);

    msg!("anqa: seat claimed on market {}", market.market_id);
    Ok(())
}
