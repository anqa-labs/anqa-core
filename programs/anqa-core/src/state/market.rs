//! Market configuration. Lives on base layer and is never delegated.

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Stable identifier, also the PDA seed.
    pub market_id: u64,
    /// Admin authority (multisig in production).
    pub authority: Pubkey,
    /// Price increment, quoted in quote atoms per base lot.
    pub tick_size: u64,
    /// Base units per lot — the minimum tradable increment.
    pub base_lot_size: u64,
    /// Decimals of the base asset, for client display.
    pub base_decimals: u8,
    /// Taker fee charged on notional, in basis points.
    pub taker_fee_bps: u16,
    /// Maker rebate on notional, in basis points.
    pub maker_rebate_bps: u16,
    /// Halts new orders while set; cancels remain allowed.
    pub paused: bool,
    /// Number of seats claimed on this market.
    pub seat_count: u64,
    /// Index of this market's asset inside the risk group's slot array.
    pub asset_index: u32,
    pub bump: u8,
}

impl Market {
    /// Notional in quote atoms for a fill.
    pub fn quote_notional(&self, price_in_ticks: u64, base_lots: u64) -> Option<u64> {
        price_in_ticks
            .checked_mul(base_lots)?
            .checked_mul(self.tick_size)
    }
}
