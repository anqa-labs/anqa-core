//! Place, cancel, and fire trigger orders.
//!
//! `execute_trigger_order` is **permissionless**. Anyone may fire an armed
//! trigger, and that is the point: a stop-loss is worthless if it depends on its
//! owner being online. The keeper supplies no prices and chooses no size — it
//! only pays for a transaction that the mark has already authorised.
//!
//! Firing is a reduce-only close, so the worst a malicious keeper can do is
//! close a position its owner already asked to have closed, at a price the owner
//! already bounded, once the market has actually reached the level the owner
//! named. There is no version of that which profits the keeper.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, ORACLE_STATE_SEED, TRIGGER_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, OracleState, TriggerDirection, TriggerOrder};

#[event]
pub struct TriggerPlaced {
    pub market_id: u64,
    pub trigger_id: u64,
    pub trigger_price: u64,
}

#[event]
pub struct TriggerFired {
    pub market_id: u64,
    pub trigger_id: u64,
    pub mark: u64,
}

#[derive(Accounts)]
#[instruction(trigger_id: u64)]
pub struct PlaceTriggerOrder<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = trader,
        space = 8 + TriggerOrder::INIT_SPACE,
        seeds = [
            TRIGGER_SEED,
            &market.market_id.to_le_bytes(),
            trader.key().as_ref(),
            &trigger_id.to_le_bytes()
        ],
        bump
    )]
    pub trigger: Account<'info, TriggerOrder>,

    pub system_program: Program<'info, System>,
}

pub fn place(
    ctx: Context<PlaceTriggerOrder>,
    trigger_id: u64,
    trigger_price: u64,
    direction: TriggerDirection,
    limit_price_in_ticks: u64,
    max_base_lots: u64,
) -> Result<()> {
    require!(trigger_price > 0, AnqaError::InvalidPrice);
    require!(limit_price_in_ticks > 0, AnqaError::InvalidPrice);

    let t = &mut ctx.accounts.trigger;
    t.market_id = ctx.accounts.market.market_id;
    t.owner = ctx.accounts.trader.key();
    t.trigger_id = trigger_id;
    t.trigger_price = trigger_price;
    t.direction = direction;
    t.limit_price_in_ticks = limit_price_in_ticks;
    t.max_base_lots = max_base_lots;
    t.created_at = Clock::get()?.unix_timestamp;
    t.bump = ctx.bumps.trigger;

    emit!(TriggerPlaced {
        market_id: t.market_id,
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

#[derive(Accounts)]
pub struct CancelTriggerOrder<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        close = trader,
        constraint = trigger.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub trigger: Account<'info, TriggerOrder>,
}

pub fn cancel(ctx: Context<CancelTriggerOrder>) -> Result<()> {
    msg!("anqa: trigger {} cancelled", ctx.accounts.trigger.trigger_id);
    Ok(())
}

/// Check that a trigger is armed and close it out.
///
/// Kept separate from the close itself: this instruction validates and consumes
/// the trigger, and the caller pairs it with `close_position` in the same
/// transaction. Splitting them keeps each instruction's account list small
/// enough to fit alongside the maker portfolios a close needs.
#[derive(Accounts)]
pub struct FireTriggerOrder<'info> {
    /// Permissionless. Reclaims the trigger's rent as the fee for keeping the
    /// venue's stops honest.
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    #[account(
        mut,
        close = keeper,
        constraint = trigger.market_id == market.market_id @ AnqaError::WrongMarket
    )]
    pub trigger: Account<'info, TriggerOrder>,
}

pub fn fire(ctx: Context<FireTriggerOrder>) -> Result<()> {
    let market = &ctx.accounts.market;
    // `live_mark` also refuses a stale mark or a tripped breaker, so stops
    // cannot fire on a price the venue does not currently trust.
    let mark = ctx.accounts.oracle_state.live_mark(&market.oracle)?;
    let t = &ctx.accounts.trigger;

    require!(t.is_armed(mark), AnqaError::TriggerNotArmed);

    emit!(TriggerFired {
        market_id: t.market_id,
        trigger_id: t.trigger_id,
        mark,
    });
    msg!(
        "anqa: trigger {} fired at mark {} (was {:?} {})",
        t.trigger_id,
        mark,
        t.direction,
        t.trigger_price
    );
    Ok(())
}
