//! The internal oracle account.
//!
//! ## Why this exists
//!
//! A program running inside an ephemeral rollup can only read accounts that were
//! delegated to that rollup. Pyth's price accounts live on base layer and are
//! not ours to delegate, so once Anqa's book moves into the PER the crank can no
//! longer read Pyth directly.
//!
//! The fix is a relay: a permissionless keeper reads Pyth **on base layer**,
//! writes the price into this account, and this account is delegated into the
//! rollup alongside the book. Inside the rollup the venue reads a local account
//! that mirrors the oracle.
//!
//! ## What that costs, stated plainly
//!
//! The relay is a trust hop. Inside the rollup we are no longer verifying Pyth's
//! signature — we are trusting that whoever last wrote this account wrote the
//! truth. Three things bound the damage:
//!
//! 1. `sync_internal_oracle` re-derives everything from a real `PriceUpdateV2`
//!    on base layer, so the *write* is verified even though the *read* is not.
//! 2. Every field the base-layer check produced travels with the price —
//!    publish time, confidence, source slot — so the rollup can still apply
//!    staleness and confidence gates to relayed data.
//! 3. The consuming side keeps its circuit breaker. A relay that starts
//!    publishing nonsense trips the same move band a bad feed would.
//!
//! This is the standard shape for oracle-dependent programs on ephemeral
//! rollups. It is worth being honest that it weakens the trust story relative to
//! reading Pyth directly, which is why the vault never enters the rollup.

use anchor_lang::prelude::*;

use crate::state::Price;

#[account]
#[derive(InitSpace, Default, Debug)]
pub struct InternalOracle {
    pub market_id: u64,
    /// Feed this mirrors. Checked against the market's own on every read.
    pub feed_id: [u8; 32],
    /// Price as published, still carrying its own exponent.
    pub price: Price,
    /// Confidence interval, at the same exponent as `price`.
    pub conf: u64,
    /// Exponentially weighted price, for funding.
    pub ema: Price,
    /// Publish time reported by the oracle, not the time we relayed it.
    pub publish_time: i64,
    /// Base-layer slot at which this relay was written.
    pub synced_at_slot: u64,
    /// Who last wrote it. Diagnostics only; the write path is permissionless.
    pub last_keeper: Pubkey,
    pub bump: u8,
}

impl InternalOracle {
    pub fn set(&mut self, price: Price, conf: u64, publish_time: i64, keeper: Pubkey, slot: u64) {
        self.price = price;
        self.conf = conf;
        self.publish_time = publish_time;
        self.last_keeper = keeper;
        self.synced_at_slot = slot;
    }

    /// Fold a new sample into the EMA. Funding is charged against this rather
    /// than a spot tick, so one wick cannot drain a side of the book.
    pub fn update_ema(&mut self, sample: Price, weight_bps: u16) -> Result<()> {
        if self.ema.is_zero() {
            self.ema = sample;
            return Ok(());
        }
        let w = weight_bps.min(10_000) as u64;
        let common = self.ema.exponent.min(sample.exponent);
        let prev = self.ema.scale_to(common)?.mantissa as u128;
        let next = sample.scale_to(common)?.mantissa as u128;
        let blended = (next * w as u128 + prev * (10_000 - w) as u128) / 10_000;
        self.ema = Price::new(blended as u64, common);
        Ok(())
    }
}
