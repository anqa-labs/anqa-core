//! The base-layer deposit ledger, and the receipt that carries a withdrawal
//! back across the rollup boundary.
//!
//! ## Why these exist
//!
//! A rollup can only write accounts delegated to it. Collateral lives in a
//! base-layer vault and must stay there; the trading account (the portfolio) is
//! delegated. So value moving in either direction crosses a boundary that no
//! single transaction can span.
//!
//! The asymmetry that makes it tractable: **the rollup can read base-layer
//! state, but the base layer cannot see inside the rollup.** So the ledger is
//! written on base and *read* from the rollup, and anything the rollup decides
//! has to travel back as committed state plus a receipt.
//!
//! ## Deposits: monotonic ledger, high-water mark in the portfolio
//!
//! `deposited` only ever grows. The portfolio remembers how much of it has already
//! been absorbed. Claiming credits the difference, so replaying a claim is a
//! no-op and no cross-boundary write is ever needed. Idempotent by construction
//! rather than by locking.
//!
//! ## Withdrawals: reserve, reconcile, settle
//!
//! The base layer cannot see whether the trader can actually afford a
//! withdrawal — only the risk kernel inside the rollup knows that. So the base
//! side reserves an **optimistic upper bound** against the ledger, the rollup
//! reconciles it against real equity and writes the true figure into a receipt,
//! and the base side pays out that figure and releases the rest of the
//! reservation.
//!
//! Reserving matters: without it, a trader could request a withdrawal and then
//! spend the same collateral again before the rollup step ran.

use anchor_lang::prelude::*;

use crate::errors::AnqaError;

/// Per-trader, per-market, base layer. Never delegated.
#[account]
#[derive(InitSpace, Debug, Default)]
pub struct UserDepositLedger {
    pub owner: Pubkey,
    pub market_id: u64,
    /// Cumulative collateral ever paid into the vault. **Monotonic** — this is
    /// what makes the high-water claim idempotent.
    pub deposited: u64,
    /// Cumulative collateral ever paid back out.
    pub withdrawn: u64,
    /// Currently committed to an in-flight withdrawal and not spendable.
    pub reserved: u64,
    pub bump: u8,
}

impl UserDepositLedger {
    /// What a withdrawal may still draw against. The rollup reads this term.
    pub fn available(&self) -> u64 {
        self.deposited
            .saturating_sub(self.withdrawn)
            .saturating_sub(self.reserved)
    }

    pub fn credit_deposit(&mut self, amount: u64) -> Result<()> {
        self.deposited = self
            .deposited
            .checked_add(amount)
            .ok_or(AnqaError::MathOverflow)?;
        Ok(())
    }

    /// Reserve up to `amount`, returning what was actually reserved. An upper
    /// bound only — the rollup has the final say on what the trader can afford.
    pub fn reserve(&mut self, amount: u64) -> u64 {
        let take = amount.min(self.available());
        self.reserved = self.reserved.saturating_add(take);
        take
    }

    /// Settle `paid` out of a `reserved_amount` reservation, releasing the rest.
    pub fn settle(&mut self, reserved_amount: u64, paid: u64) -> Result<()> {
        require!(paid <= reserved_amount, AnqaError::MathOverflow);
        self.withdrawn = self
            .withdrawn
            .checked_add(paid)
            .ok_or(AnqaError::MathOverflow)?;
        self.reserved = self.reserved.saturating_sub(reserved_amount);
        Ok(())
    }
}

/// A deposit crossing into the rollup. Created **and delegated** on base by
/// `deposit`, carrying the queued `claim_deposit` the validator runs inside
/// the rollup; consumed on base by `close_deposit_receipt` once the credit
/// has landed.
///
/// The receipt is the *vehicle*, not the accounting: the credit itself is
/// still computed from the monotonic ledger against the portfolio's
/// high-water mark, so a lost or replayed receipt can never mint or lose a
/// deposit — at worst it costs the rent until someone closes it.
#[account]
#[derive(InitSpace, Debug)]
pub struct DepositReceipt {
    pub owner: Pubkey,
    pub market_id: u64,
    /// What this deposit paid in, for the tape; the credit is ledger-derived.
    pub amount: u64,
    /// Set by the rollup once the portfolio was credited.
    pub credited: u8,
    pub created_at: i64,
    pub bump: u8,
}

/// Stages a withdrawal as it crosses the boundary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum WithdrawStage {
    /// Reserved on base layer. The rollup has not yet judged it.
    Requested,
    /// The rollup debited the portfolio and wrote the true amount here.
    Authorized,
}

/// The receipt itself. Created **and delegated** on base, authorized inside
/// the rollup, committed-and-undelegated back, consumed on base — the only way
/// a rollup decision can reach the vault.
///
/// Delegation is what makes the lifecycle race-free: while the request is in
/// flight the receipt is owned by the delegation program, so the base-layer
/// settle physically cannot run early. Only after the rollup hands it back —
/// with or without an authorization — does settling become possible.
#[account]
#[derive(InitSpace, Debug)]
pub struct WithdrawReceipt {
    pub owner: Pubkey,
    pub market_id: u64,
    /// What the trader asked for and the ledger reserved.
    pub requested: u64,
    /// What the risk kernel actually permitted. Meaningless until `Authorized`,
    /// and zero if the kernel refused — a refusal still comes home as a
    /// receipt, so the reservation can be released.
    pub authorized: u64,
    /// Where the payout goes. Captured at request time, when the trader signed,
    /// so the permissionless settle cannot be pointed anywhere else.
    pub payout_to: Pubkey,
    pub stage: WithdrawStage,
    pub created_at: i64,
    pub bump: u8,
}

impl WithdrawReceipt {
    pub fn is_authorized(&self) -> bool {
        matches!(self.stage, WithdrawStage::Authorized)
    }
}
