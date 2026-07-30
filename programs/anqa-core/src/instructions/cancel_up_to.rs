//! Pull only quotes *more aggressive* than a price, keeping the passive rest
//! of the ladder alive.
//!
//! This is the everyday risk tool: the mark moves against you, so you retreat
//! the near side and leave the far side working. "More aggressive" means closer
//! to crossing — a higher bid, a lower ask. Shares `CancelBulk`'s accounts with
//! `cancel_all`, and like it releases the initial margin the cancelled orders
//! had reserved.

use anchor_lang::prelude::*;

use crate::instructions::cancel_all::{release_margin, CancelBulk, OrdersCancelled};
use crate::state::Side;

/// Pull this trader's orders on `side` that are at or more aggressive than
/// `price_in_ticks`, leaving the passive remainder working.
pub fn handler(ctx: Context<CancelBulk>, side: Side, price_in_ticks: u64) -> Result<()> {
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
