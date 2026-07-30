//! Trigger orders — stop-loss and take-profit.
//!
//! A trigger order is **not** a resting order. It sits off-book, consumes no
//! depth, and reserves no margin, because until the mark crosses its trigger it
//! is not an order at all — it is a conditional instruction to create one.
//!
//! That distinction matters for a CLOB. If stops rested on the book they would
//! be visible (in a lit venue) and would occupy scarce arena slots for orders
//! that may never fire. Keeping them separate is also what lets a keeper find
//! them cheaply: one account per trigger, discoverable by `getProgramAccounts`.
//!
//! Anqa's triggers are **reduce-only by construction**. A stop that can open a
//! position is a way to be handed exposure you are not watching, and the margin
//! accounting for a conditional opening order is a genuine trap — you either
//! reserve margin for something that may never happen, or you fire into an
//! account that can no longer afford it. Protecting an existing position has
//! neither problem, and it is what stops are actually for.

use anchor_lang::prelude::*;

/// Which way the mark must cross for the trigger to arm.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TriggerDirection {
    /// Fire once the mark rises to or above the trigger price.
    Above,
    /// Fire once the mark falls to or below it.
    Below,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct TriggerOrder {
    pub market_id: u64,
    pub owner: Pubkey,
    /// Caller-supplied id; also the PDA seed, so a trader can hold many.
    pub trigger_id: u64,
    /// Mark price, in quote atoms, at which this arms.
    pub trigger_price: u64,
    pub direction: TriggerDirection,
    /// Worst acceptable execution price, in ticks — the slippage bound applied
    /// when the trigger converts into a live order.
    pub limit_price_in_ticks: u64,
    /// Zero means "whatever the position is when it fires".
    pub max_base_lots: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl TriggerOrder {
    /// Has the mark crossed this trigger?
    pub fn is_armed(&self, mark: u64) -> bool {
        match self.direction {
            TriggerDirection::Above => mark >= self.trigger_price,
            TriggerDirection::Below => mark <= self.trigger_price,
        }
    }
}
