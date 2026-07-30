//! Amend a resting order.
//!
//! Cancel-and-replace would work, but it costs the thing a maker most wants to
//! keep: **queue position**. Two orders at the same price are ranked by arrival,
//! so cancelling and re-posting sends you to the back of that price level behind
//! everyone who was already there.
//!
//! So the rule here mirrors how real venues treat amendments:
//!
//! - **Reducing size at the same price keeps priority.** You are asking for
//!   less, which cannot disadvantage anyone behind you.
//! - **Raising size, or changing price, loses it.** Both are new claims on the
//!   book, and letting them keep an old timestamp would let a maker sit at the
//!   front of a queue with a one-lot order and inflate it the moment flow
//!   arrives — jumping everyone who queued honestly.
//!
//! That asymmetry is not a nicety. Without it, time priority is decorative.

use anchor_lang::prelude::*;

use crate::constants::{BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED, PORTFOLIO_SEED};
use crate::errors::AnqaError;
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::state::{Book, Market, OracleState, OrderType, Portfolio, Side};

#[event]
pub struct OrderModified {
    pub market_id: u64,
    pub client_order_id: u64,
    pub kept_priority: bool,
}

#[derive(Accounts)]
pub struct ModifyOrder<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(
    ctx: Context<ModifyOrder>,
    side: Side,
    client_order_id: u64,
    new_price_in_ticks: u64,
    new_base_lots: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(new_base_lots > 0, AnqaError::InvalidSize);
    require!(new_price_in_ticks > 0, AnqaError::InvalidPrice);

    let new_price_quote = market
        .ticks_to_quote(new_price_in_ticks)
        .ok_or(AnqaError::MathOverflow)?;
    require!(
        ctx.accounts
            .oracle_state
            .within_band(&market.oracle, new_price_quote)?,
        AnqaError::PriceOutsideBand
    );
    let mark = ctx.accounts.oracle_state.live_mark(&market.oracle)?;

    let trader = ctx.accounts.trader.key();

    // Find the existing order so we know what we are changing from.
    let (old_price, old_lots) = {
        let book = ctx.accounts.book.load()?;
        book.side(side)
            .find_order(&trader, client_order_id)
            .ok_or(AnqaError::OrderNotFound)?
    };

    let shrink_in_place = new_price_in_ticks == old_price && new_base_lots < old_lots;

    let kept_priority = {
        let mut book = ctx.accounts.book.load_mut()?;
        if shrink_in_place {
            book.side_mut(side)
                .resize_in_place(&trader, client_order_id, new_base_lots)?;
            true
        } else {
            // New claim on the book: cancel and re-post, taking a fresh sequence
            // number and therefore the back of its price level.
            book.side_mut(side).cancel(&trader, client_order_id)?;
            let (fills, resting) = book.place(
                side,
                OrderType::PostOnly,
                new_price_in_ticks,
                new_base_lots,
                trader,
                client_order_id,
            )?;
            // Post-only: an amendment that would cross is a mispricing.
            require!(fills.is_empty(), AnqaError::PostOnlyWouldCross);
            require!(resting == new_base_lots, AnqaError::PostOnlyWouldCross);
            false
        }
    };

    // Re-margin: release what the old order held, reserve what the new one does.
    let margin_for = |price_ticks: u64, lots: u64| -> Result<u128> {
        let quote = market
            .ticks_to_quote(price_ticks)
            .ok_or(AnqaError::MathOverflow)? as u128;
        let notional = quote
            .max(mark as u128)
            .checked_mul(lots as u128)
            .ok_or(AnqaError::MathOverflow)?;
        Ok(notional
            .checked_mul(INITIAL_MARGIN_BPS as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128)
    };
    let released = margin_for(old_price, old_lots)?;
    let reserved = margin_for(new_price_in_ticks, new_base_lots)?;

    {
        let mut pf = ctx.accounts.portfolio.load_mut()?;
        pf.release(released);
        pf.reserve(reserved);
    }
    // Growing an order must still be affordable.
    if reserved > released {
        require!(
            ctx.accounts.portfolio.load()?.free_margin()? > 0,
            AnqaError::InsufficientMargin
        );
    }

    emit!(OrderModified {
        market_id: market.market_id,
        client_order_id,
        kept_priority,
    });
    msg!(
        "anqa: order {} amended to {} @ {} ({})",
        client_order_id,
        new_base_lots,
        new_price_in_ticks,
        if kept_priority {
            "kept queue position"
        } else {
            "requeued"
        }
    );
    Ok(())
}
