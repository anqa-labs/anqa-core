//! Expire a lapsed source-backing bucket — kernel maintenance, exposed.
//!
//! The kernel backs realized positive PnL with per-domain buckets that carry
//! a slot expiry. Once a `Fresh` bucket's expiry passes, every account
//! refresh in that domain refuses with `Stale` until the bucket is swept —
//! and the kernel ships the sweep (`expire_source_backing_bucket_not_atomic`)
//! but nothing on this venue called it, so one winner's expired winnings
//! could wedge the whole asset. Found the hard way on devnet market 802.
//!
//! Permissionless, like the crank: sweeping an actually-lapsed bucket is the
//! only thing this can do — the kernel refuses (`Stale`) if the bucket is
//! still current, so there is nothing for a hostile caller to abuse.

use anchor_lang::prelude::*;
use percolator::MarketGroupV16ViewMut;

use crate::instructions::initialize_risk::MAX_ACCRUAL_DT_SLOTS;
use crate::constants::{CLOCK_SEED, ASSET_SLOTS_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, RiskGroup, VenueClock};

#[derive(Accounts)]
pub struct SweepBacking<'info> {
    /// Anyone; the keeper in practice.
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.group_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.group_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// The venue's own clock. Bound to this group by seeds: the kernel trusts
    /// whatever slot it is handed, so a caller-supplied account here would be
    /// a way to stall or force accrual. See `state/venue_clock.rs`.
    #[account(
        mut,
        seeds = [CLOCK_SEED, &market.group_id.to_le_bytes()],
        bump = venue_clock.bump
    )]
    pub venue_clock: Account<'info, VenueClock>,
}

pub fn handler(ctx: Context<SweepBacking>, domain: u32) -> Result<()> {
    require!(
        (domain as usize) < crate::constants::MAX_ASSETS * 2,
        AnqaError::BadAssetIndex
    );

    let slot = ctx
        .accounts
        .venue_clock
        .tick(Clock::get()?.slot, MAX_ACCRUAL_DT_SLOTS);
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

    map_risk(view.expire_source_backing_bucket_not_atomic(domain as usize, slot))?;

    msg!("anqa: backing bucket swept — domain {}", domain);
    Ok(())
}
