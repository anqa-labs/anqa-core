//! Create a market and its (empty) order book on base layer.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED};
use crate::state::{Book, Market};

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,

    /// Zero-copy: the book is far too large to deserialize onto the BPF stack.
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<Book>(),
        seeds = [BOOK_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub book: AccountLoader<'info, Book>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    market_id: u64,
    tick_size: u64,
    base_lot_size: u64,
    base_decimals: u8,
    quote_decimals: u8,
    taker_fee_bps: u16,
    maker_rebate_bps: u16,
    pyth_feed_id: [u8; 32],
    max_price_age_secs: u64,
    max_conf_bps: u16,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.market_id = market_id;
    market.authority = ctx.accounts.authority.key();
    market.tick_size = tick_size;
    market.base_lot_size = base_lot_size;
    market.base_decimals = base_decimals;
    market.quote_decimals = quote_decimals;
    market.taker_fee_bps = taker_fee_bps;
    market.maker_rebate_bps = maker_rebate_bps;
    market.paused = false;
    market.seat_count = 0;
    market.asset_index = 0;
    market.pyth_feed_id = pyth_feed_id;
    market.max_price_age_secs = max_price_age_secs;
    market.max_conf_bps = max_conf_bps;
    market.bump = ctx.bumps.market;

    let mut book = ctx.accounts.book.load_init()?;
    book.init(market_id, ctx.bumps.book);

    msg!("anqa: market {} initialized", market_id);
    Ok(())
}
