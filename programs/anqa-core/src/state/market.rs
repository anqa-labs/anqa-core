//! Market configuration. Lives on base layer and is never delegated.

use anchor_lang::prelude::*;

/// Market configuration.
///
/// **Never delegated.** `place_order` reads this for tick size, fees, oracle
/// policy and the paused flag; inside the rollup it arrives as a read-only
/// clone of the base account (verified live on devnet). Keeping it on base is
/// load-bearing: delegation would flip its owner to the delegation program and
/// break every base instruction that reads `market` through Anchor's owner
/// check — `deposit`, the withdraw legs, `forced_exit`.
///
/// Consequence: admin writes (pause, oracle params) always happen on base, and
/// the rollup sees them on its next clone refresh.
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
    /// Decimals of the collateral/quote mint (6 for USDC). The mark price is
    /// denominated in quote atoms, so this — not `base_decimals` — is what the
    /// oracle read rescales to.
    pub quote_decimals: u8,
    /// Taker fee charged on notional, in basis points.
    pub taker_fee_bps: u16,
    /// Maker rebate on notional, in basis points.
    pub maker_rebate_bps: u16,
    /// Halts new orders while set; cancels remain allowed.
    pub paused: bool,
    /// Index of this market's asset inside the risk group's slot array.
    pub asset_index: u32,
    /// Oracle policy. Fixed at creation; changeable only through a timelocked
    /// admin path, because it governs this market's own liquidations.
    pub oracle: crate::state::OracleParams,
    /// Which oracle backend this market reads.
    pub oracle_kind: crate::state::OracleKind,
    pub bump: u8,
}

impl Market {
    /// Notional in quote atoms for `base_lots` at `price_in_ticks`.
    pub fn quote_notional(&self, price_in_ticks: u64, base_lots: u64) -> Option<u64> {
        price_in_ticks
            .checked_mul(base_lots)?
            .checked_mul(self.tick_size)
    }

    /// Price of a single base lot, in quote atoms.
    ///
    /// Book prices are integer **tick counts**; the oracle mark is in **quote
    /// atoms**. Comparing the two directly is only accidentally correct when
    /// `tick_size == 1`. Always convert through here first.
    pub fn ticks_to_quote(&self, price_in_ticks: u64) -> Option<u64> {
        price_in_ticks.checked_mul(self.tick_size)
    }

    /// Quote-atom price expressed as a tick count, rounded down.
    pub fn quote_to_ticks(&self, quote_price: u64) -> Option<u64> {
        if self.tick_size == 0 {
            return None;
        }
        Some(quote_price / self.tick_size)
    }
}
