//! Oracle handling.
//!
//! The mark price decides who is solvent and who gets liquidated, so it must not
//! be something the caller can choose. Two gates stand between Pyth and the risk
//! engine:
//!
//! 1. **Staleness** — a price older than `max_price_age_secs` is refused. A
//!    frozen oracle during a fast move is how venues hand out free money.
//! 2. **Confidence** — Pyth publishes an interval, not a point. When that
//!    interval widens past `max_conf_bps` the market is disagreeing with itself,
//!    and marking positions on a number nobody trusts is worse than not marking
//!    them at all. We refuse and let the crank retry.
//!
//! The confidence gate is the one most venues skip. It is also the one that
//! matters during exactly the minutes when liquidations are firing.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::AnqaError;

/// A validated mark price, already scaled to the venue's quote atoms.
pub struct MarkPrice {
    pub price: u64,
    pub conf_bps: u64,
    pub publish_time: i64,
}

/// Read Pyth, enforce both gates, and rescale to quote atoms.
///
/// `quote_decimals` is the collateral mint's decimals (6 for USDC). Pyth reports
/// `price * 10^exponent` in USD; the venue wants `price * 10^quote_decimals`.
pub fn read_mark(
    price_update: &Account<PriceUpdateV2>,
    feed_id: &[u8; 32],
    max_age_secs: u64,
    max_conf_bps: u16,
    quote_decimals: u8,
) -> Result<MarkPrice> {
    let clock = Clock::get()?;

    let p = price_update
        .get_price_no_older_than(&clock, max_age_secs, feed_id)
        .map_err(|e| {
            msg!("anqa: pyth rejected the price: {:?}", e);
            AnqaError::OracleUnavailable
        })?;

    require!(p.price > 0, AnqaError::OracleUnavailable);
    let raw = p.price as u128;

    // Confidence as a fraction of price. Wide interval => market disagrees.
    let conf_bps = (p.conf as u128)
        .checked_mul(10_000)
        .ok_or(AnqaError::MathOverflow)?
        / raw;
    require!(
        conf_bps <= max_conf_bps as u128,
        AnqaError::OracleConfidenceTooWide
    );

    // Rescale 10^exponent -> 10^quote_decimals.
    let shift = p.exponent + quote_decimals as i32;
    let scaled = if shift >= 0 {
        raw.checked_mul(
            10u128
                .checked_pow(shift as u32)
                .ok_or(AnqaError::MathOverflow)?,
        )
        .ok_or(AnqaError::MathOverflow)?
    } else {
        raw / 10u128
            .checked_pow((-shift) as u32)
            .ok_or(AnqaError::MathOverflow)?
    };

    let price = u64::try_from(scaled).map_err(|_| AnqaError::MathOverflow)?;
    require!(price > 0, AnqaError::OracleUnavailable);

    Ok(MarkPrice {
        price,
        conf_bps: conf_bps as u64,
        publish_time: p.publish_time,
    })
}
