//! Cancel a resting order.
//!
//! Ownership is enforced inside the book: only the trader who placed an order can
//! remove it, and the lookup never reveals whether an order exists to anyone else.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED, PORTFOLIO_SEED};
use crate::errors::AnqaError;
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::events::OrderCancelled;
use crate::state::{Book, Market, Portfolio, Side};

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
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<CancelOrder>, side: Side, client_order_id: u64) -> Result<()> {
    let trader_key = ctx.accounts.trader.key();

    let (price_in_ticks, base_lots) = {
        let mut book = ctx.accounts.book.load_mut()?;
        book.side_mut(side).cancel(&trader_key, client_order_id)?
    };

    // Give back the margin this order was holding.
    let notional = ctx
        .accounts
        .market
        .quote_notional(price_in_ticks, base_lots)
        .ok_or(AnqaError::MathOverflow)? as u128;
    let freed = notional
        .checked_mul(INITIAL_MARGIN_BPS as u128)
        .ok_or(AnqaError::MathOverflow)?
        / 10_000u128;
    ctx.accounts.portfolio.load_mut()?.release(freed);

    emit!(OrderCancelled {
        market_id: ctx.accounts.market.market_id,
        client_order_id,
    });

    Ok(())
}
