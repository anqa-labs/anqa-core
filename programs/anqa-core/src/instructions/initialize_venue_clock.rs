//! Create the venue's clock, and delegate it alongside the risk group.
//!
//! See `state/venue_clock.rs` for why the venue cannot use the host chain's
//! clock. This runs on base layer, before delegation.
//!
//! ## Where the starting value comes from
//!
//! The kernel header already holds a slot, stamped from base layer by
//! `initialize_risk`, and it will reject anything earlier. Seeding from base
//! layer's clock is therefore correct without having to read the header at
//! all: this account is created on base, after the group was, and base's slot
//! only moves forward — so `Clock::get()` here is always at least the value
//! the kernel is holding.
//!
//! That is also what lets an already-wedged venue be rescued in place. Hub 900
//! was stamped at base slot 481,132,442 and then delegated to a rollup running
//! at 238,184,391; creating its clock on base picks up ~481,140,000, the first
//! rollup call reads backwards and advances by nothing, and the venue resumes
//! from a value the kernel already agrees with. No re-provisioning, no new
//! collateral mint.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::{CLOCK_SEED, MARKET_SEED};
use crate::state::{Market, VenueClock};

#[derive(Accounts)]
#[instruction(group_id: u64)]
pub struct InitializeVenueClock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority,
        constraint = market.group_id == group_id @ crate::errors::AnqaError::BadAssetIndex
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the group's admin, checked by `has_one`.
    pub authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + VenueClock::INIT_SPACE,
        seeds = [CLOCK_SEED, &group_id.to_le_bytes()],
        bump
    )]
    pub venue_clock: Account<'info, VenueClock>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVenueClock>, group_id: u64) -> Result<()> {
    let slot = Clock::get()?.slot;
    let c = &mut ctx.accounts.venue_clock;
    c.group_id = group_id;
    c.venue_slot = slot;
    c.last_raw = slot;
    c.frame_changes = 0;
    c.bump = ctx.bumps.venue_clock;

    msg!("anqa: venue clock for group {} starts at {}", group_id, slot);
    Ok(())
}

/// Delegate the clock into the rollup. It must travel with the risk group —
/// left behind on base it would be unwritable from inside the rollup, and
/// every crank would fail.
#[delegate]
#[derive(Accounts)]
#[instruction(group_id: u64)]
pub struct DelegateVenueClock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the venue clock.
    #[account(mut, del, seeds = [CLOCK_SEED, &group_id.to_le_bytes()], bump)]
    pub venue_clock: AccountInfo<'info>,
}

pub fn delegate_handler(ctx: Context<DelegateVenueClock>, group_id: u64) -> Result<()> {
    ctx.accounts.delegate_venue_clock(
        &ctx.accounts.payer,
        &[CLOCK_SEED, &group_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: venue clock delegated for group {}", group_id);
    Ok(())
}
