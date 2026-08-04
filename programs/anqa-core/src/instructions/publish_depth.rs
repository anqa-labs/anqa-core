//! Publish the book's aggregate depth.
//!
//! Two instructions: one to create the account on base, one to refresh it
//! inside the rollup where the book lives.
//!
//! Refreshing is permissionless and deliberately separate from trading. The
//! book is permissioned — only the owner and the engine may read it — so the
//! mirror cannot be built by a client; it has to be built by the program,
//! from inside, by someone who is allowed to look. Anyone may drive it,
//! because publishing totals can only make the venue more legible and never
//! reveals whose orders compose them.
//!
//! The keeper calls it on the settle tick, which is the moment the book has
//! just changed.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, DEPTH_SEED, MARKET_SEED};
use crate::state::{Book, BookDepth, Market};

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeDepth<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<BookDepth>(),
        seeds = [DEPTH_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub depth: AccountLoader<'info, BookDepth>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(ctx: Context<InitializeDepth>, market_id: u64) -> Result<()> {
    ctx.accounts
        .depth
        .load_init()?
        .init(market_id, ctx.bumps.depth);
    msg!("anqa: depth mirror ready for market {}", market_id);
    Ok(())
}

#[derive(Accounts)]
pub struct PublishDepth<'info> {
    /// Permissionless — a public total is nobody's secret.
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    #[account(mut, seeds = [DEPTH_SEED, &market.market_id.to_le_bytes()], bump)]
    pub depth: AccountLoader<'info, BookDepth>,
}

pub fn publish_handler(ctx: Context<PublishDepth>) -> Result<()> {
    let book = ctx.accounts.book.load()?;
    let mut depth = ctx.accounts.depth.load_mut()?;

    let (mut bids, mut bid_levels, mut total_bid) = (depth.bids, depth.bid_levels, depth.total_bid_lots);
    BookDepth::rebuild_side(
        &mut bids,
        &mut bid_levels,
        &mut total_bid,
        book.bids.walk_prices(),
    );
    let (mut asks, mut ask_levels, mut total_ask) = (depth.asks, depth.ask_levels, depth.total_ask_lots);
    BookDepth::rebuild_side(
        &mut asks,
        &mut ask_levels,
        &mut total_ask,
        book.asks.walk_prices(),
    );

    depth.bids = bids;
    depth.asks = asks;
    depth.bid_levels = bid_levels;
    depth.ask_levels = ask_levels;
    depth.total_bid_lots = total_bid;
    depth.total_ask_lots = total_ask;
    depth.seq = depth.seq.wrapping_add(1);
    Ok(())
}
