//! The venue's own clock.
//!
//! ## Why anqa cannot use the host's clock
//!
//! The risk kernel needs a monotonic slot counter: it accrues funding over
//! elapsed slots and refuses to run if time appears to move backwards, because
//! a clock that can be rewound is a clock that can be used to replay funding
//! or hide a loss. That refusal is correct and worth keeping.
//!
//! The problem is that `Clock::get()` returns **the host chain's** slot, and a
//! delegated venue changes hosts. Base layer and each rollup validator count
//! their own blocks from their own genesis, so the same instant reads as a
//! different number depending on where the venue is currently running:
//!
//! ```text
//! Solana devnet         481,140,360
//! shared ER validator   509,xxx,xxx   (ahead — counts ~20 slots/sec)
//! TEE ER validator      238,184,391   (behind — younger chain)
//! ```
//!
//! Delegating to the TEE validator therefore looks to the kernel like time
//! jumping back 243 million slots, and it stops the venue dead. This was found
//! live: hub 900 could not crank, could not anchor its oracle, and so quoted
//! against a mark of $0 and rested no orders.
//!
//! An earlier attempt at this problem — `reanchor_oracle` — assumed the rollup
//! always runs *ahead* and only knows how to jump the clock forward, so it
//! cannot rescue a venue on a validator that runs behind.
//!
//! ## What this does instead
//!
//! Anqa keeps its own counter and never shows the kernel a host slot. Each
//! call converts the host's reading into an elapsed amount and adds it:
//!
//! - host moved forward → advance by that much, capped at one accrual step
//! - host moved backward (new validator, restart) → advance by nothing
//!
//! So the counter is monotonic **by construction**, whatever the host does,
//! and changing hosts costs one call's worth of accrual rather than freezing
//! the venue. The kernel's invariant is not relaxed; it is guaranteed.
//!
//! The cap matters as much as the floor. The kernel already refuses to accrue
//! more than `max_accrual_dt_slots` in a single call — hand it a larger jump
//! and it clamps, leaving its own `slot_last` behind, which arms the staleness
//! lock and starts refusing fills. Capping here means the clock can never
//! outrun what the kernel is willing to accrue, so that lock stops arming.
//!
//! ## What this costs
//!
//! Time only advances when somebody calls. If the keepers stop, funding stops
//! accruing — which is arguably right for a venue that is not running, but it
//! does make funding a function of crank liveness rather than wall time.

use anchor_lang::prelude::*;

/// The venue's monotonic clock, one per risk group.
///
/// Travels with the risk group: delegated with it, committed with it,
/// undelegated with it. Separated from it only because `RiskGroup` is a fixed
/// byte image of the kernel header with no room to spare, and growing that
/// account would invalidate every venue already running.
#[account]
#[derive(InitSpace)]
pub struct VenueClock {
    /// Which risk group this clock belongs to.
    pub group_id: u64,
    /// What the kernel is told. Only ever increases.
    pub venue_slot: u64,
    /// The last slot the host chain reported, in whatever frame it was using.
    /// Meaningful only as the baseline for the next reading.
    pub last_raw: u64,
    /// How many times the host's clock has been seen to move backwards —
    /// operational visibility, since each one is a validator change or a
    /// restart and is worth noticing.
    pub frame_changes: u32,
    pub bump: u8,
}

impl VenueClock {
    /// Advance the venue clock from a host reading, and return what the kernel
    /// should be told.
    ///
    /// `max_step` should be the kernel's `max_accrual_dt_slots`: advancing by
    /// more than it will accrue in one call only desynchronises the two.
    pub fn tick(&mut self, host_slot: u64, max_step: u64) -> u64 {
        if host_slot < self.last_raw {
            // The host chain changed underneath us — a different validator, or
            // the same one restarted. There is no elapsed time we can trust, so
            // claim none and re-baseline. Our own counter does not move.
            self.frame_changes = self.frame_changes.saturating_add(1);
            self.last_raw = host_slot;
            return self.venue_slot;
        }
        let elapsed = host_slot.saturating_sub(self.last_raw).min(max_step);
        self.last_raw = host_slot;
        self.venue_slot = self.venue_slot.saturating_add(elapsed);
        self.venue_slot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(venue: u64, raw: u64) -> VenueClock {
        VenueClock {
            group_id: 900,
            venue_slot: venue,
            last_raw: raw,
            frame_changes: 0,
            bump: 255,
        }
    }

    #[test]
    fn advances_with_the_host() {
        let mut c = clock(1_000, 500);
        assert_eq!(c.tick(540, 100), 1_040);
        assert_eq!(c.tick(560, 100), 1_060);
    }

    #[test]
    fn never_advances_more_than_one_accrual_step() {
        let mut c = clock(1_000, 500);
        // A 10,000-slot gap still only buys one step; the kernel would clamp
        // anything larger anyway.
        assert_eq!(c.tick(10_500, 100), 1_100);
    }

    #[test]
    fn a_host_that_rewinds_does_not_move_the_clock() {
        // Delegating from base (481M) to the TEE rollup (238M): the exact
        // case that froze hub 900.
        let mut c = clock(481_140_360, 481_140_360);
        assert_eq!(c.tick(238_184_391, 100), 481_140_360);
        assert_eq!(c.frame_changes, 1);
        // and time resumes in the new frame without any further intervention
        assert_eq!(c.tick(238_184_431, 100), 481_140_400);
    }

    #[test]
    fn is_monotonic_under_an_adversarial_host() {
        let mut c = clock(1_000, 1_000);
        let mut last = 1_000;
        for raw in [900u64, 5_000, 4_999, 0, u64::MAX, 7, 8, 1_000_000] {
            let now = c.tick(raw, 100);
            assert!(now >= last, "clock went backwards: {last} -> {now}");
            last = now;
        }
    }
}
