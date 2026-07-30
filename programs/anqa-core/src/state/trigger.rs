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

// The trigger data itself lives in `Portfolio.triggers` (see `state/risk.rs`,
// `TriggerSlot`) — inside the delegated portfolio, so triggers travel with it
// and fire inside the rollup. Standalone trigger accounts became unfireable
// the moment trading moved into the rollup: firing needs the trigger, the
// oracle state, the portfolio and the book in one transaction, and those
// lived on opposite sides of the delegation boundary.
