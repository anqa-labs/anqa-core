//! The fill tape — the only thing a dark market ever shows the world.
//!
//! On a lit market the public tape is the `Fill` event stream. Inside a
//! private rollup, transaction logs are permission-gated — only the parties to
//! a transaction see its events — so the public surface must be an *account*:
//! one left deliberately permissionless (world-readable) while the book and
//! portfolios are locked down, and committed to base chain so the tape is
//! public even for people who never talk to the rollup.
//!
//! It carries exactly what the pitch promises and nothing else: price, size,
//! sequence, time. No maker, no taker, no order ids, no side.

use anchor_lang::prelude::*;

/// One print. 32 bytes.
#[zero_copy]
#[derive(Debug)]
pub struct TapeEntry {
    pub fill_seq: u64,
    pub price_in_ticks: u64,
    pub base_lots: u64,
    pub timestamp: i64,
}

/// Ring capacity. 128 prints ≈ 4KB — cheap to commit, deep enough that an
/// indexer polling every few seconds never misses a print.
pub const TAPE_ENTRIES: usize = 128;

#[account(zero_copy)]
#[derive(Debug)]
pub struct FillTape {
    pub market_id: u64,
    /// Total prints ever. `head` is `count % TAPE_ENTRIES`, so a reader can
    /// detect how far behind it is and page accordingly.
    pub count: u64,
    pub entries: [TapeEntry; TAPE_ENTRIES],
    pub bump: u8,
    pub _pad: [u8; 7],
}

impl FillTape {
    pub fn init(&mut self, market_id: u64, bump: u8) {
        self.market_id = market_id;
        self.bump = bump;
        self.count = 0;
    }

    pub fn print(&mut self, price_in_ticks: u64, base_lots: u64, timestamp: i64) -> u64 {
        let seq = self.count + 1;
        let slot = (self.count as usize) % TAPE_ENTRIES;
        self.entries[slot] = TapeEntry {
            fill_seq: seq,
            price_in_ticks,
            base_lots,
            timestamp,
        };
        self.count = seq;
        seq
    }
}
