//! Check that a trigger is armed, and consume it.
//!
//! **Permissionless.** Anyone may fire an armed trigger, and that is the point:
//! a stop-loss is worthless if it depends on its owner being online. The keeper
//! supplies no prices and chooses no size — it only pays for a transaction that
//! the mark has already authorised.
//!
//! Firing is a reduce-only close, so the worst a malicious keeper can do is
//! close a position its owner already asked to have closed, at a price the owner
//! already bounded, once the market has actually reached the level the owner
//! named. There is no version of that which profits the keeper. (There is also,
//! for now, no version that *pays* the keeper — a fire fee debited from the
//! owner's portfolio needs a kernel-level transfer primitive; until then the
//! protocol keeper runs this unpaid, as Flash does.)
//!
//! **Must be paired with `close_position` in the same transaction.** The two
//! are separate instructions because a close needs maker portfolios in
//! `remaining_accounts`, and merging would blow the account limit. The guard
//! that makes the split safe: a trigger can only be consumed while there is a
//! position for it to protect, so a keeper firing it alone either performs the
//! close it was paired with or fails outright.
//!
//! Two more guards, both cheap and both load-bearing:
//! - a trigger cannot fire in the slot it was armed in (blocks atomic
//!   arm-then-fire extraction);
//! - triggers are addressed by id, never slot index, so a racing cancel can
//!   never redirect a fire onto a different order.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, ORACLE_STATE_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, OracleState, Portfolio};

#[event]
pub struct TriggerFired {
    pub market_id: u64,
    pub trigger_id: u64,
    pub mark: u64,
}

#[derive(Accounts)]
pub struct FireTriggerOrder<'info> {
    /// Permissionless keeper.
    pub keeper: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    /// The owner's portfolio, which carries the trigger slots. The trigger
    /// must not be consumable unless there is a position for it to act on.
    /// The tag pins it to this market — isolated portfolios never cross.
    #[account(
        mut,
        constraint = portfolio.load()?.market_id == market.group_id.to_le_bytes() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<FireTriggerOrder>, trigger_id: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    // `live_mark` also refuses a stale mark or a tripped breaker, so stops
    // cannot fire on a price the venue does not currently trust.
    let mark = ctx.accounts.oracle_state.live_mark(&market.oracle)?;

    let mut pf = ctx.accounts.portfolio.load_mut()?;
    let slot = pf
        .find_trigger(trigger_id)
        .ok_or(AnqaError::OrderNotFound)?;
    let t = pf.triggers[slot];

    require!(
        t.asset_index == market.asset_index as u8,
        AnqaError::WrongMarket
    );
    require!(t.is_armed(mark), AnqaError::TriggerNotArmed);
    // Not in the same slot it was armed in.
    require!(
        Clock::get()?.slot > t.armed_at(),
        AnqaError::TriggerNotArmed
    );
    // Without this, a keeper could consume a stop against a flat account and
    // burn the owner's protection for free.
    require!(
        pf.current_position(market.asset_index).is_some(),
        AnqaError::NoOpenPosition
    );

    pf.disarm_trigger(slot);

    emit!(TriggerFired {
        market_id: market.market_id,
        trigger_id,
        mark,
    });
    msg!(
        "anqa: trigger {} fired at mark {} (was {:?} {})",
        trigger_id,
        mark,
        t.direction(),
        t.price()
    );
    Ok(())
}
