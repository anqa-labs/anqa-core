//! Bulk cancellation.
//!
//! A market maker quoting a ladder cannot pull it one order at a time — by the
//! time the fifth transaction lands the mark has moved again. These are the two
//! instructions that decide whether anyone will quote your book:
//!
//! - `cancel_all_orders` — pull everything, both sides. The panic button.
//! - `cancel_up_to` — pull only quotes *more aggressive* than a price, keeping
//!   the passive rest of the ladder alive. This is the everyday risk tool: the
//!   mark moves against you, so you retreat the near side and leave the far side
//!   working.
//!
//! "More aggressive" means closer to crossing — a higher bid, a lower ask.
//!
//! Both release the initial margin those orders had reserved, which is Anqa-side
//! bookkeeping the risk kernel never sees.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED, PORTFOLIO_SEED};
use crate::errors::AnqaError;
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::state::{Book, Market, Portfolio, Side};

#[event]
pub struct OrdersCancelled {
    pub market_id: u64,
    pub count: u32,
}

#[derive(Accounts)]
pub struct CancelBulk<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

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

/// Release the margin held by `price_x_lots` worth of cancelled orders.
fn release_margin(
    market: &Market,
    portfolio: &AccountLoader<Portfolio>,
    price_x_lots: u128,
) -> Result<()> {
    if price_x_lots == 0 {
        return Ok(());
    }
    let notional = price_x_lots
        .checked_mul(market.tick_size as u128)
        .ok_or(AnqaError::MathOverflow)?;
    let freed = notional
        .checked_mul(INITIAL_MARGIN_BPS as u128)
        .ok_or(AnqaError::MathOverflow)?
        / 10_000u128;
    portfolio.load_mut()?.release(freed);
    Ok(())
}

/// Pull every resting order this trader has, on both sides.
///
/// Deliberately allowed while the market is paused: a pause must never trap a
/// trader's orders or the margin they hold.
pub fn cancel_all(ctx: Context<CancelBulk>) -> Result<()> {
    let trader = ctx.accounts.trader.key();
    let (count, price_x_lots) = {
        let mut book = ctx.accounts.book.load_mut()?;
        let (nb, fb) = book.bids.cancel_matching(&trader, Side::Bid, None);
        let (na, fa) = book.asks.cancel_matching(&trader, Side::Ask, None);
        (nb + na, fb.saturating_add(fa))
    };

    release_margin(&ctx.accounts.market, &ctx.accounts.portfolio, price_x_lots)?;

    emit!(OrdersCancelled {
        market_id: ctx.accounts.market.market_id,
        count,
    });
    msg!("anqa: cancelled {} order(s)", count);
    Ok(())
}

/// Pull this trader's orders on `side` that are at or more aggressive than
/// `price_in_ticks`, leaving the passive remainder working.
pub fn cancel_up_to(ctx: Context<CancelBulk>, side: Side, price_in_ticks: u64) -> Result<()> {
    let trader = ctx.accounts.trader.key();
    let (count, price_x_lots) = {
        let mut book = ctx.accounts.book.load_mut()?;
        book.side_mut(side)
            .cancel_matching(&trader, side, Some(price_in_ticks))
    };

    release_margin(&ctx.accounts.market, &ctx.accounts.portfolio, price_x_lots)?;

    emit!(OrdersCancelled {
        market_id: ctx.accounts.market.market_id,
        count,
    });
    msg!(
        "anqa: cancelled {} order(s) at or beyond {}",
        count,
        price_in_ticks
    );
    Ok(())
}
