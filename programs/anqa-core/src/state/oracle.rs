//! The oracle system.
//!
//! The mark price decides who is solvent, so this is the most security-sensitive
//! code in the venue. Everything here exists to answer one question honestly:
//! *do we currently know the price well enough to liquidate someone over it?*
//!
//! Five defences, in the order they apply:
//!
//! 1. **Source authenticity** — the feed id is pinned on the market. A caller
//!    cannot substitute a different asset's oracle.
//! 2. **Staleness** — a price older than `max_age_secs` is refused. A frozen
//!    oracle during a fast move is how venues hand out free money.
//! 3. **Confidence** — Pyth publishes an interval, not a point. Past
//!    `max_conf_bps` the market disagrees with itself; refuse to mark rather
//!    than mark on a number nobody trusts.
//! 4. **Cross-source deviation** — when a secondary source is configured, the
//!    two must agree within `max_deviation_bps`. Disagreement means one of them
//!    is wrong and we do not know which.
//! 5. **Move band + freeze** — a jump larger than `max_move_bps_per_interval`
//!    since the last accepted mark trips a circuit breaker that freezes
//!    liquidations and leverage increases until sources reconverge. This is the
//!    defence against a single manipulated print liquidating the book.
//!
//! Funding is computed against the **EMA**, never a spot tick, so a momentary
//! wick cannot drain one side of the market.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::AnqaError;

/// Where a market's price comes from.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OracleKind {
    /// Pyth pull oracle. The only kind permitted on mainnet.
    Pyth,
    /// Admin-published price. For devnet, integration tests, and synthetic
    /// markets that have no public feed. Trust-maximising by definition — the
    /// market's `paused` flag and low caps are the compensating controls.
    Custom,
}

impl Default for OracleKind {
    fn default() -> Self {
        OracleKind::Pyth
    }
}

/// A price with its own exponent, so scaling is explicit rather than assumed.
///
/// Oracles publish `price * 10^exponent`; venues want quote atoms. Doing that
/// conversion in one audited place, rather than at each call site, is how you
/// avoid the class of bug where a mark is off by 10^2 and every position in the
/// book is mispriced.
#[derive(Clone, Copy, Debug)]
pub struct OraclePrice {
    pub price: u64,
    pub exponent: i32,
    pub conf: u64,
    pub publish_time: i64,
}

impl OraclePrice {
    /// Rescale to `target_decimals` (the quote mint's decimals).
    pub fn to_quote_atoms(&self, target_decimals: u8) -> Result<u64> {
        let shift = self.exponent + target_decimals as i32;
        let raw = self.price as u128;
        let scaled = if shift >= 0 {
            raw.checked_mul(
                10u128
                    .checked_pow(u32::try_from(shift).map_err(|_| AnqaError::MathOverflow)?)
                    .ok_or(AnqaError::MathOverflow)?,
            )
            .ok_or(AnqaError::MathOverflow)?
        } else {
            let d = 10u128
                .checked_pow(u32::try_from(-shift).map_err(|_| AnqaError::MathOverflow)?)
                .ok_or(AnqaError::MathOverflow)?;
            raw / d
        };
        let out = u64::try_from(scaled).map_err(|_| AnqaError::MathOverflow)?;
        require!(out > 0, AnqaError::OracleUnavailable);
        Ok(out)
    }

    /// Confidence as a fraction of price, in basis points.
    pub fn conf_bps(&self) -> Result<u64> {
        require!(self.price > 0, AnqaError::OracleUnavailable);
        Ok(((self.conf as u128)
            .checked_mul(10_000)
            .ok_or(AnqaError::MathOverflow)?
            / self.price as u128) as u64)
    }
}

/// Per-market oracle policy. Fixed at market creation — a market must not be
/// able to loosen the rules that govern its own liquidations.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct OracleParams {
    /// Pyth feed id this market marks against.
    pub feed_id: [u8; 32],
    /// Optional second feed. Zero means single-source.
    pub secondary_feed_id: [u8; 32],
    /// Refuse prices older than this many seconds.
    pub max_age_secs: u64,
    /// Refuse when Pyth's confidence interval exceeds this fraction of price.
    pub max_conf_bps: u16,
    /// Refuse when two sources disagree by more than this.
    pub max_deviation_bps: u16,
    /// Trip the breaker when the mark jumps more than this since the last
    /// accepted price. Zero disables the band (first mark, or synthetics).
    pub max_move_bps_per_interval: u16,
    /// Slots to stay frozen after the breaker trips.
    pub freeze_slots: u64,
    /// EMA smoothing, in basis points of the new sample (2000 = 20% new).
    pub ema_weight_bps: u16,
    /// **Execution band.** Orders and fills must be within this fraction of the
    /// mark. This is the difference between a spot CLOB and a perp CLOB: on a
    /// spot venue an off-market trade only means you sold cheap with your own
    /// tokens, but on a perp venue it mints a position at that entry and the
    /// mark instantly revalues it — creating value from nothing at the vault's
    /// expense. Two accounts trading at price 1 while the mark is 65,000 would
    /// hand one side enormous profit and bankrupt the other into insurance.
    ///
    /// The risk kernel deliberately does not check this (it only rejects zero
    /// and absurd prices); bounding execution against the oracle is the
    /// wrapper's job.
    pub max_band_bps: u16,
    /// Refuse to trade if the mark has not been cranked within this many slots.
    /// If the crank stops, trading halts — the correct failure mode.
    pub max_mark_staleness_slots: u64,
}

/// Live oracle state for a market: last accepted mark, the EMA funding is
/// computed against, and the circuit breaker.
#[account]
#[derive(InitSpace, Default)]
pub struct OracleState {
    pub market_id: u64,
    /// Last accepted mark, in quote atoms.
    pub last_price: u64,
    /// Exponentially weighted mark. Funding uses this, never a spot tick.
    pub ema_price: u64,
    pub last_publish_time: i64,
    pub last_update_slot: u64,
    /// While `slot < frozen_until_slot`, liquidations and leverage increases are
    /// refused. Set when the move band or cross-source deviation trips.
    pub frozen_until_slot: u64,
    /// Diagnostics: how many times the breaker has tripped.
    pub breaker_trips: u64,
    pub bump: u8,
}

impl OracleState {
    pub fn is_frozen(&self, slot: u64) -> bool {
        slot < self.frozen_until_slot
    }

    /// The mark trading is allowed to reference: fresh, and not under a tripped
    /// breaker. Returns an error rather than a stale number, because every
    /// caller of this is about to decide whether someone can take on risk.
    pub fn live_mark(&self, params: &OracleParams) -> Result<u64> {
        let slot = Clock::get()?.slot;
        require!(!self.is_frozen(slot), AnqaError::OracleFrozen);
        require!(self.last_price > 0, AnqaError::OracleUnavailable);
        require!(
            slot.saturating_sub(self.last_update_slot) <= params.max_mark_staleness_slots,
            AnqaError::OracleUnavailable
        );
        Ok(self.last_price)
    }

    /// Is `price` inside the execution band around the mark?
    pub fn within_band(&self, params: &OracleParams, price: u64) -> Result<bool> {
        let mark = self.live_mark(params)?;
        if params.max_band_bps == 0 {
            return Ok(true);
        }
        Ok(deviation_bps(mark, price)? <= params.max_band_bps as u64)
    }

    fn trip(&mut self, slot: u64, freeze_slots: u64, reason: &str) {
        self.frozen_until_slot = slot.saturating_add(freeze_slots);
        self.breaker_trips = self.breaker_trips.saturating_add(1);
        msg!(
            "anqa: ORACLE BREAKER TRIPPED ({}) — frozen until slot {}",
            reason,
            self.frozen_until_slot
        );
    }

    /// Fold a newly accepted mark into the EMA.
    fn update_ema(&mut self, price: u64, weight_bps: u16) {
        if self.ema_price == 0 {
            self.ema_price = price;
            return;
        }
        let w = weight_bps.min(10_000) as u128;
        let blended = ((price as u128) * w + (self.ema_price as u128) * (10_000 - w)) / 10_000;
        self.ema_price = blended as u64;
    }
}

/// Read a Pyth update, enforcing authenticity, staleness and confidence.
pub fn read_pyth(
    update: &Account<PriceUpdateV2>,
    feed_id: &[u8; 32],
    max_age_secs: u64,
    max_conf_bps: u16,
) -> Result<OraclePrice> {
    let clock = Clock::get()?;
    let p = update
        .get_price_no_older_than(&clock, max_age_secs, feed_id)
        .map_err(|e| {
            msg!("anqa: pyth rejected the price: {:?}", e);
            AnqaError::OracleUnavailable
        })?;
    require!(p.price > 0, AnqaError::OracleUnavailable);

    let price = OraclePrice {
        price: p.price as u64,
        exponent: p.exponent,
        conf: p.conf,
        publish_time: p.publish_time,
    };
    require!(
        price.conf_bps()? <= max_conf_bps as u64,
        AnqaError::OracleConfidenceTooWide
    );
    Ok(price)
}

/// Read the relayed price, applying the same gates as the direct Pyth path.
///
/// This is what the venue uses **inside a rollup**, where Pyth's own accounts
/// are not delegated to us and therefore unreadable. The signature was verified
/// on base layer by `sync_internal_oracle`; what we can still check here is that
/// the relay is fresh, carries the feed this market was created with, and has a
/// confidence interval we are willing to mark positions against.
///
/// Staleness is measured against the oracle's own `publish_time`, not the slot
/// the relay was written — a keeper faithfully relaying a stale price must not
/// be able to launder it into a fresh one.
pub fn read_internal(
    io: &crate::state::InternalOracle,
    feed_id: &[u8; 32],
    max_age_secs: u64,
    max_conf_bps: u16,
) -> Result<OraclePrice> {
    require!(io.feed_id == *feed_id, AnqaError::WrongPriceFeed);
    require!(io.price.mantissa > 0, AnqaError::OracleUnavailable);

    let now = Clock::get()?.unix_timestamp;
    let age = now.saturating_sub(io.publish_time);
    require!(
        age >= 0 && (age as u64) <= max_age_secs,
        AnqaError::OracleUnavailable
    );

    let price = OraclePrice {
        price: io.price.mantissa,
        exponent: io.price.exponent,
        conf: io.conf,
        publish_time: io.publish_time,
    };
    require!(
        price.conf_bps()? <= max_conf_bps as u64,
        AnqaError::OracleConfidenceTooWide
    );
    Ok(price)
}

/// Absolute difference between two prices, in basis points of the first.
fn deviation_bps(a: u64, b: u64) -> Result<u64> {
    require!(a > 0, AnqaError::OracleUnavailable);
    let diff = a.abs_diff(b) as u128;
    Ok((diff
        .checked_mul(10_000)
        .ok_or(AnqaError::MathOverflow)?
        / a as u128) as u64)
}

/// The full pipeline: validate, cross-check, band-check, commit.
///
/// Returns the accepted mark in quote atoms. On a band or deviation breach the
/// breaker trips and the call fails — the caller should retry on the next tick
/// rather than force a mark through.
pub fn accept_mark(
    state: &mut OracleState,
    params: &OracleParams,
    primary: OraclePrice,
    secondary: Option<OraclePrice>,
    quote_decimals: u8,
) -> Result<u64> {
    let slot = Clock::get()?.slot;
    let price = primary.to_quote_atoms(quote_decimals)?;

    // Cross-source agreement.
    if let Some(sec) = secondary {
        let sec_price = sec.to_quote_atoms(quote_decimals)?;
        let dev = deviation_bps(price, sec_price)?;
        if dev > params.max_deviation_bps as u64 {
            state.trip(slot, params.freeze_slots, "source deviation");
            msg!("anqa: sources disagree by {}bps", dev);
            return Err(AnqaError::OracleSourcesDisagree.into());
        }
    }

    // Move band against the last accepted mark.
    if state.last_price > 0 && params.max_move_bps_per_interval > 0 {
        let moved = deviation_bps(state.last_price, price)?;
        if moved > params.max_move_bps_per_interval as u64 {
            state.trip(slot, params.freeze_slots, "price move band");
            msg!(
                "anqa: mark moved {}bps ({} -> {}), band is {}bps",
                moved,
                state.last_price,
                price,
                params.max_move_bps_per_interval
            );
            return Err(AnqaError::OracleMoveTooLarge.into());
        }
    }

    state.last_price = price;
    state.last_publish_time = primary.publish_time;
    state.last_update_slot = slot;
    state.update_ema(price, params.ema_weight_bps);

    Ok(price)
}
