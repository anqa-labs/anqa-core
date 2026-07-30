//! Arm a trigger order (stop-loss / take-profit) — a slot in the portfolio.
//!
//! A trigger order is **not** a resting order. It sits off-book, consumes no
//! depth, and reserves no margin, because until the mark crosses its trigger it
//! is not an order at all — it is a conditional instruction to create one.
//! Anqa's triggers are **reduce-only by construction**: they require an open
//! position at placement and can only ever close, so there is no margin to
//! reserve and no way to be handed exposure you are not watching.
//!
//! It lives *inside* the portfolio (not as its own account) so it delegates
//! with the portfolio and fires inside the rollup, next to the book it closes
//! into. Runs wherever the portfolio lives.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, PORTFOLIO_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, Portfolio, TriggerDirection};

#[event]
pub struct TriggerPlaced {
    pub market_id: u64,
    pub trigger_id: u64,
    pub trigger_price: u64,
}

#[derive(Accounts)]
pub struct PlaceTriggerOrder<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(
    ctx: Context<PlaceTriggerOrder>,
    trigger_id: u64,
    trigger_price: u64,
    direction: TriggerDirection,
    limit_price_in_ticks: u64,
    max_base_lots: u64,
) -> Result<()> {
    require!(trigger_price > 0, AnqaError::InvalidPrice);
    require!(limit_price_in_ticks > 0, AnqaError::InvalidPrice);

    let asset_index = ctx.accounts.market.asset_index;
    let mut pf = ctx.accounts.portfolio.load_mut()?;

    // A stop protects a position; without one there is nothing to protect and
    // an armed slot would orphan onto whatever position comes next.
    require!(
        pf.current_position(asset_index).is_some(),
        AnqaError::NoOpenPosition
    );

    pf.arm_trigger(
        trigger_id,
        asset_index as u8,
        direction,
        trigger_price,
        limit_price_in_ticks,
        max_base_lots,
        Clock::get()?.slot,
    )?;

    emit!(TriggerPlaced {
        market_id: ctx.accounts.market.market_id,
        trigger_id,
        trigger_price,
    });
    msg!(
        "anqa: trigger {} armed {:?} {}",
        trigger_id,
        direction,
        trigger_price
    );
    Ok(())
}
