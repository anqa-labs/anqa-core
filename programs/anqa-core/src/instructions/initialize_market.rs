//! Create a market and its (empty) order book on base layer.

use anchor_lang::prelude::*;

use crate::errors::AnqaError;
use crate::constants::{BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED};
use crate::state::{Book, Market, OracleKind, OracleParams, OracleState};

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

    #[account(
        init,
        payer = authority,
        space = 8 + OracleState::INIT_SPACE,
        seeds = [ORACLE_STATE_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub oracle_state: Account<'info, OracleState>,

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
    oracle_kind: OracleKind,
    oracle: OracleParams,
) -> Result<()> {
    require!(tick_size > 0 && base_lot_size > 0, AnqaError::InvalidTickSize);

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
    market.asset_index = 0;
    market.oracle = oracle;
    market.oracle_kind = oracle_kind;
    market.bump = ctx.bumps.market;

    let mut book = ctx.accounts.book.load_init()?;
    book.init(market_id, ctx.bumps.book);

    let os = &mut ctx.accounts.oracle_state;
    os.market_id = market_id;
    os.bump = ctx.bumps.oracle_state;

    msg!("anqa: market {} initialized", market_id);
    Ok(())
}
