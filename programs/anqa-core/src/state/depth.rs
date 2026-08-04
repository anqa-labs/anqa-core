//! Aggregate depth — what a dark book can publish without giving anyone away.
//!
//! The book itself stays unreadable: every resting order carries its owner,
//! its exact size and its place in the queue, and that is precisely what a
//! trader resting size is paying to hide.
//!
//! But hiding *how much is bid at a price* protects nobody. It is the one
//! piece of opacity that costs the taker rather than the maker: without it
//! they cannot size a trade, and a taker who cannot size a trade goes
//! somewhere they can. So the program keeps this mirror alongside the book —
//! totals per price level, no owners, no individual quantities — and leaves
//! it public.
//!
//! What stays private is what actually protects a trader: which order is
//! theirs, how large it is on its own, what position they carry, and the
//! price at which they would be liquidated.

use anchor_lang::prelude::*;

use crate::constants::ORDERS_PER_SIDE;

/// Price levels published per side. A level is a price and the total resting
/// there; two orders at one price are indistinguishable inside it, which is
/// the point.
pub const DEPTH_LEVELS: usize = 12;

#[zero_copy]
#[derive(Default)]
pub struct DepthLevel {
    pub price_in_ticks: u64,
    /// Total base lots resting at this price, across every order.
    pub base_lots: u64,
}

/// The public face of a dark book.
#[account(zero_copy)]
pub struct BookDepth {
    pub market_id: u64,
    /// Bumped on every rebuild, so a client can tell a stale read from a
    /// quiet market.
    pub seq: u64,
    /// Best-first: `bids[0]` is the highest bid, `asks[0]` the lowest ask.
    pub bids: [DepthLevel; DEPTH_LEVELS],
    pub asks: [DepthLevel; DEPTH_LEVELS],
    /// Everything resting, including whatever sits past the published
    /// levels — the venue's size, which is aggregate by definition.
    pub total_bid_lots: u64,
    pub total_ask_lots: u64,
    /// Levels actually populated on each side.
    pub bid_levels: u8,
    pub ask_levels: u8,
    pub bump: u8,
    /// Explicit tail padding — `Pod` refuses a type the compiler had to pad.
    pub _pad: [u8; 5],
}

impl BookDepth {
    pub fn init(&mut self, market_id: u64, bump: u8) {
        self.market_id = market_id;
        self.bump = bump;
        self.seq = 0;
        self.bid_levels = 0;
        self.ask_levels = 0;
        self.total_bid_lots = 0;
        self.total_ask_lots = 0;
        self.bids = [DepthLevel::default(); DEPTH_LEVELS];
        self.asks = [DepthLevel::default(); DEPTH_LEVELS];
    }

    /// Rebuild one side from the book's own priority order.
    ///
    /// The walk is already price-ordered, so equal prices arrive together and
    /// fold into one level without sorting. Bounded by `ORDERS_PER_SIDE`,
    /// which is what keeps this affordable on every order and every fill.
    pub fn rebuild_side(
        levels: &mut [DepthLevel; DEPTH_LEVELS],
        count: &mut u8,
        total: &mut u64,
        walk: impl Iterator<Item = (u64, u64)>,
    ) {
        *levels = [DepthLevel::default(); DEPTH_LEVELS];
        *count = 0;
        *total = 0;
        let mut n: usize = 0;
        let mut walked = 0usize;
        for (price, lots) in walk {
            if walked >= ORDERS_PER_SIDE {
                break;
            }
            walked += 1;
            *total = total.saturating_add(lots);
            if n > 0 && levels[n - 1].price_in_ticks == price {
                levels[n - 1].base_lots = levels[n - 1].base_lots.saturating_add(lots);
                continue;
            }
            if n < DEPTH_LEVELS {
                levels[n] = DepthLevel {
                    price_in_ticks: price,
                    base_lots: lots,
                };
                n += 1;
            }
            // Past the published depth the totals still accumulate: a taker
            // learns the venue's size even where the ladder is truncated.
        }
        *count = n as u8;
    }
}
