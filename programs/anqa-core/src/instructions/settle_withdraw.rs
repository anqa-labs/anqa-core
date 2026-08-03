//! Base layer: pay out a settled withdrawal receipt and release the
//! reservation.
//!
//! Final leg of the withdraw lifecycle (`request_withdraw` →
//! `authorize_withdraw` → here). Normally dispatched by the validator as a
//! post-undelegate action; retryable by anyone because the validator fires each
//! action exactly once.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::action;

use crate::constants::{LEDGER_SEED, MARKET_SEED, VAULT_SEED, WITHDRAW_RECEIPT_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, UserDepositLedger, WithdrawReceipt};

#[event]
pub struct WithdrawSettled {
    pub market_id: u64,
    pub owner: Pubkey,
    pub paid: u64,
}

#[action]
#[derive(Accounts)]
pub struct SettleWithdraw<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [LEDGER_SEED, &market.group_id.to_le_bytes(), receipt.owner.as_ref()],
        bump = ledger.bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    /// Deserializable as ours again only once the rollup has undelegated it —
    /// which is exactly what makes a premature settle impossible.
    #[account(
        mut,
        close = owner,
        seeds = [WITHDRAW_RECEIPT_SEED, &market.group_id.to_le_bytes(), receipt.owner.as_ref()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, WithdrawReceipt>,

    /// CHECK: the trader named on the receipt; gets the rent back.
    #[account(mut, address = receipt.owner @ AnqaError::NotOrderOwner)]
    pub owner: AccountInfo<'info>,

    /// The destination the trader signed for at request time. No signer here
    /// can redirect it.
    #[account(mut, address = receipt.payout_to @ AnqaError::NotOrderOwner)]
    pub payout_to: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [VAULT_SEED, &market.group_id.to_le_bytes()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    // `#[action]` appends `escrow_auth` and `escrow` here; the validator
    // injects them when it dispatches this as a post-undelegate action, and a
    // direct (keeper or user) call passes any two accounts — they are unread.
}

/// Deliberately signerless: it can only pay the receipt's own destination, and
/// a trader must not need anyone's goodwill to be paid. Folds all three
/// outcomes: authorized → pay and deduct; refused (`authorized == 0`) →
/// release the reservation; orphaned (`Requested`, undelegated without a
/// verdict) → no-op close that still releases the reservation.
pub fn handler(ctx: Context<SettleWithdraw>) -> Result<()> {
    let receipt = &ctx.accounts.receipt;
    let paid = if receipt.is_authorized() { receipt.authorized } else { 0 };
    let reserved = receipt.requested;
    let owner = receipt.owner;

    ctx.accounts.ledger.settle(reserved, paid)?;

    if paid > 0 {
        let market_id_bytes = ctx.accounts.market.group_id.to_le_bytes();
        let seeds: &[&[u8]] = &[VAULT_SEED, &market_id_bytes, &[ctx.bumps.vault]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.payout_to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            paid,
        )?;
    }

    emit!(WithdrawSettled {
        market_id: ctx.accounts.market.market_id,
        owner,
        paid,
    });
    msg!("anqa: settled {} out of the vault", paid);
    Ok(())
}
