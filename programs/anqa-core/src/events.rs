//! Events — the public tape.
//!
//! Everything the outside world ever learns about the book comes from here.
//! Deliberately absent: order owners, resting depth, order identifiers, and the
//! side that initiated. A fill tells you a trade happened at a price and size,
//! and nothing about who wanted what.

use anchor_lang::prelude::*;

/// The only event that carries market information.
#[event]
pub struct Fill {
    pub market_id: u64,
    pub price_in_ticks: u64,
    pub base_lots: u64,
    pub fill_seq: u64,
    pub timestamp: i64,
}

/// Emitted on order placement. Carries no price, size, side, or owner — it exists
/// so integrators can confirm their own submission landed, correlated by the
/// client-supplied nonce they already know.
#[event]
pub struct OrderAccepted {
    pub market_id: u64,
    pub client_order_id: u64,
}

/// Emitted on cancellation. Same reasoning as above.
#[event]
pub struct OrderCancelled {
    pub market_id: u64,
    pub client_order_id: u64,
}
