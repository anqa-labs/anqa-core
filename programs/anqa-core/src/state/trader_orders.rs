//! One trader's own resting orders.
//!
//! A dark book creates a problem it also has to solve: the trader cannot read
//! the book, so they cannot see their own orders on it. Membership is not the
//! answer — a member reads the *whole* book, owners included, which is the one
//! thing the venue promises nobody can do. Handing every trader that key to
//! solve a display problem would end the product.
//!
//! So this mirrors the shape the venue already uses for depth: the program
//! walks the book from inside the rollup, where it is allowed to look, and
//! writes out a projection narrow enough to be safe to share. Depth publishes
//! the aggregate and keeps the owners; this publishes one owner's rows and
//! keeps everyone else's. Same book, two lawful views of it.
//!
//! Permissioned to the owner (and the engine that writes it), so a stranger
//! reading this account gets the same `null` the book gives them.
//!
//! **Derived, never authoritative.** The book is the truth; this is a copy
//! rebuilt from it. Nothing reads this to decide a fill, a cancel or a margin
//! release — it exists so a trader can see what they left resting. That is
//! also why no instruction has to maintain it: `place_order`, `cancel`,
//! `modify_order` and `settle_fill` all change the book and none of them know
//! this account exists. A hand-maintained index would have to be updated
//! correctly in all four, plus the eviction and auto-cancel paths, and would
//! be wrong the first time one of them was missed.

use anchor_lang::prelude::*;

use crate::constants::NIL;
use crate::state::{BookSide, Side};

/// Rows published per trader, per market.
///
/// A book side holds 32 orders, so 32 is the most a trader could rest on one
/// side and 64 across both. This is a display mirror, not a ledger, and a
/// trader quoting more than 24 rungs on one market is a market maker reading
/// its own book from the engine rather than this. Overflow truncates and says
/// so through `truncated`, which is honest and bounded; growing the account
/// is a provisioning change, not a code one.
pub const TRADER_ORDER_ROWS: usize = 24;

#[zero_copy]
#[derive(Default)]
pub struct TraderOrderRow {
    pub client_order_id: u64,
    pub price_in_ticks: u64,
    pub base_lots: u64,
    /// Arrival sequence — the "time" in price-time priority. Lets a client
    /// show queue position without reading anyone else's order.
    pub seq: u64,
    /// 0 = bid, 1 = ask.
    pub side: u8,
    /// 1 when this order is withheld from the public depth ladder.
    pub hidden: u8,
    pub _pad: [u8; 6],
}

#[account(zero_copy)]
pub struct TraderOrders {
    pub owner: Pubkey,
    pub market_id: u64,
    /// Bumped on every rebuild, so a client can tell a stale read from a
    /// trader who simply has nothing resting.
    pub seq: u64,
    /// Unix time of the last rebuild, from the venue clock's host reading.
    /// A row set that stopped updating is a keeper that stopped running, and
    /// a trader should be able to tell that apart from an empty book.
    pub published_at: i64,
    pub rows: [TraderOrderRow; TRADER_ORDER_ROWS],
    pub count: u8,
    /// 1 when the trader had more resting orders than `rows` can hold.
    pub truncated: u8,
    pub bump: u8,
    pub _pad: [u8; 5],
}

impl TraderOrders {
    pub fn init(&mut self, owner: Pubkey, market_id: u64, bump: u8) {
        self.owner = owner;
        self.market_id = market_id;
        self.bump = bump;
        self.seq = 0;
        self.published_at = 0;
        self.count = 0;
        self.truncated = 0;
        self.rows = [TraderOrderRow::default(); TRADER_ORDER_ROWS];
    }

    /// Rebuild from both sides of the book, keeping only `owner`'s orders.
    ///
    /// Walks in the book's own priority order, so rows arrive best-first
    /// within each side — the same order the trader's orders would fill in.
    pub fn rebuild(&mut self, bids: &BookSide, asks: &BookSide, now: i64) {
        self.rows = [TraderOrderRow::default(); TRADER_ORDER_ROWS];
        let mut n: usize = 0;
        let mut overflow = false;

        for (side, book_side) in [(Side::Bid, bids), (Side::Ask, asks)] {
            let mut cursor = book_side.head;
            let mut guard = 0usize;
            while cursor != NIL && guard < book_side.orders.len() {
                guard += 1;
                let o = &book_side.orders[cursor as usize];
                cursor = o.next;
                if o.active != 1 || o.trader != self.owner {
                    continue;
                }
                if n >= TRADER_ORDER_ROWS {
                    overflow = true;
                    break;
                }
                self.rows[n] = TraderOrderRow {
                    client_order_id: o.client_order_id,
                    price_in_ticks: o.price_in_ticks,
                    base_lots: o.base_lots,
                    seq: o.seq,
                    side: side.as_u8(),
                    hidden: o.hidden,
                    _pad: [0; 6],
                };
                n += 1;
            }
        }

        self.count = n as u8;
        self.truncated = u8::from(overflow);
        self.published_at = now;
        self.seq = self.seq.wrapping_add(1);
    }
}
