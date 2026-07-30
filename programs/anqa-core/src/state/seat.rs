//! Trader seats.
//!
//! Phoenix requires a seat before a trader may rest orders. Anqa keeps that: a
//! seat is the per-trader account that accrues fills, and inside a private
//! ephemeral rollup it is also the natural unit of read permission — a trader
//! can be granted sight of their own seat and nothing else.

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Seat {
    pub market_id: u64,
    pub trader: Pubkey,
    /// Base lots credited to this seat from fills.
    pub base_lots_filled: u64,
    /// Quote atoms credited from fills.
    pub quote_atoms_filled: u64,
    /// Fees paid (taker) net of rebates earned (maker), in quote atoms.
    pub fees_paid: i64,
    /// Orders this seat currently has resting.
    pub open_orders: u16,
    pub bump: u8,
}
