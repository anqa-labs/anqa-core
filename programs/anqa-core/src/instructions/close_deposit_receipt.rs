//! Base layer: close a deposit receipt once its credit has landed.
//!
//! Final leg of the deposit rail (`deposit` → `claim_deposit` → here).
//! Normally dispatched by the validator as a post-undelegate action; callable
//! by anyone because the validator fires each action exactly once.
//!
//! Deliberately signerless and safe on any receipt state: the accounting is
//! ledger-and-high-water, so closing a receipt — credited or not — can never
//! lose a deposit. The only thing at stake here is the trader's rent, which
//! goes back to the trader.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::action;

use crate::constants::{DEPOSIT_RECEIPT_SEED, MARKET_SEED};
use crate::errors::AnqaError;
use crate::state::{DepositReceipt, Market};

#[action]
#[derive(Accounts)]
pub struct CloseDepositReceipt<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Deserializable as ours again only once the rollup has undelegated it.
    #[account(
        mut,
        close = owner,
        seeds = [DEPOSIT_RECEIPT_SEED, &market.market_id.to_le_bytes(), receipt.owner.as_ref()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, DepositReceipt>,

    /// CHECK: the trader named on the receipt; gets the rent back.
    #[account(mut, address = receipt.owner @ AnqaError::NotOrderOwner)]
    pub owner: AccountInfo<'info>,
    // `#[action]` appends `escrow_auth` and `escrow`; injected by the
    // validator, unread on a direct call.
}

pub fn handler(ctx: Context<CloseDepositReceipt>) -> Result<()> {
    msg!(
        "anqa: deposit receipt closed for {} ({}credited)",
        ctx.accounts.receipt.owner,
        if ctx.accounts.receipt.credited == 1 { "" } else { "un" }
    );
    Ok(())
}
