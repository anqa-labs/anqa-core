//! The protocol vault — where the venue's own revenue accumulates.
//!
//! Three pots exist in this program and conflating them is how venues lose
//! money they cannot account for:
//!
//! | pot | holds | pays out when |
//! |---|---|---|
//! | **custody vault** | every trader's collateral | a trader withdraws |
//! | **insurance vault** | the backstop | a bankruptcy outruns the loser's margin |
//! | **protocol vault** | the venue's fee revenue | the authority collects |
//!
//! They are separate token accounts on purpose. Trader collateral is not the
//! protocol's to spend, insurance is not revenue, and revenue must not be
//! reachable by the withdraw path. Keeping them apart means an accounting bug
//! in one cannot drain another.
//!
//! ## The fee ratchet
//!
//! Fee revenue does not go straight to the treasury. Until the insurance fund
//! reaches its target, **all** of it is routed there instead — the backstop
//! fills itself before the business earns anything. Only once insurance covers
//! its target share of open interest does revenue begin to split.
//!
//! That ordering is deliberate: a venue that pays itself before it can cover a
//! bankruptcy is one bad day from haircutting its own users.

use anchor_lang::prelude::*;

use crate::errors::AnqaError;

#[account]
#[derive(InitSpace, Debug, Default)]
pub struct ProtocolVault {
    pub market_id: u64,
    /// Who may collect. A multisig in production.
    pub authority: Pubkey,
    /// The token account holding the revenue.
    pub token_account: Pubkey,
    /// Fees accrued and not yet collected, in quote atoms.
    pub accrued: u64,
    /// Lifetime fees ever routed here.
    pub lifetime_accrued: u64,
    /// Lifetime fees ever collected out.
    pub lifetime_collected: u64,
    /// Lifetime fees diverted into insurance by the ratchet.
    pub lifetime_to_insurance: u64,
    /// Insurance target, as a fraction of open interest. While the fund sits
    /// below this, every basis point of revenue is diverted to it.
    pub insurance_target_bps: u16,
    /// Share of revenue that keeps going to insurance once the target is met.
    /// Zero means the treasury takes everything above target.
    pub post_target_insurance_bps: u16,
    pub bump: u8,
    pub token_account_bump: u8,
}

impl ProtocolVault {
    /// Split an incoming fee into (to_insurance, to_treasury).
    ///
    /// `insurance_balance` and `open_interest` are both in quote atoms. Below
    /// target the whole fee is diverted; above it, only the configured share.
    pub fn split_fee(
        &self,
        fee: u64,
        insurance_balance: u128,
        open_interest: u128,
    ) -> Result<(u64, u64)> {
        if fee == 0 {
            return Ok((0, 0));
        }
        let target = open_interest
            .checked_mul(self.insurance_target_bps as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128;

        // Under-funded: the backstop takes all of it.
        if insurance_balance < target {
            return Ok((fee, 0));
        }

        let to_insurance = ((fee as u128)
            .checked_mul(self.post_target_insurance_bps as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128) as u64;
        Ok((to_insurance, fee.saturating_sub(to_insurance)))
    }

    pub fn accrue(&mut self, amount: u64) -> Result<()> {
        self.accrued = self
            .accrued
            .checked_add(amount)
            .ok_or(AnqaError::MathOverflow)?;
        self.lifetime_accrued = self
            .lifetime_accrued
            .checked_add(amount)
            .ok_or(AnqaError::MathOverflow)?;
        Ok(())
    }

    pub fn collect(&mut self, amount: u64) -> Result<()> {
        require!(amount <= self.accrued, AnqaError::InsuranceInsufficient);
        self.accrued = self.accrued.saturating_sub(amount);
        self.lifetime_collected = self
            .lifetime_collected
            .checked_add(amount)
            .ok_or(AnqaError::MathOverflow)?;
        Ok(())
    }
}
