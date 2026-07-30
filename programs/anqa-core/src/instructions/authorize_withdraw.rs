//! Rollup: let the risk engine judge a withdrawal request and send the receipt
//! home with the settle queued behind it.
//!
//! Middle leg of the withdraw lifecycle (`request_withdraw` → here →
//! `settle_withdraw`).
//!
//! ## Failure is a verdict, not a revert
//!
//! This leg never strands a receipt. If the kernel refuses the withdrawal
//! (open positions, unsettled losses, resting orders), the receipt still comes
//! home — `authorized = 0` — and settle releases the reservation and pays
//! nothing. Reverting instead would leave the reservation locked forever.

use anchor_lang::prelude::*;
use anchor_lang::{InstructionData, ToAccountMetas};
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ACTION_INJECTED_TRAILING_ACCOUNTS, ASSET_SLOTS_SEED, LEDGER_SEED, MARKET_SEED,
    PORTFOLIO_SEED, RISK_GROUP_SEED, SETTLE_ACTION_COMPUTE_UNITS, VAULT_SEED,
    WITHDRAW_RECEIPT_SEED,
};
use crate::errors::AnqaError;
use crate::instructions::settle_withdraw::__client_accounts_settle_withdraw;
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup, WithdrawReceipt, WithdrawStage};

#[event]
pub struct WithdrawAuthorized {
    pub market_id: u64,
    pub owner: Pubkey,
    pub requested: u64,
    /// Zero means the kernel refused; the receipt still travels home so the
    /// reservation can be released.
    pub authorized: u64,
}

#[commit]
#[derive(Accounts)]
pub struct AuthorizeWithdraw<'info> {
    /// Permissionless — this can only execute the owner's own signed request,
    /// against the owner's own portfolio, into the owner's own receipt. A keeper
    /// must be able to re-drive it if the validator-dispatched run failed.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// The portfolio. Bound to the receipt's owner in the handler, since the
    /// owner is only known once the receipt is deserialized.
    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,

    /// CHECK: the delegated receipt. Deserialized and PDA-verified by hand —
    /// on base layer it is owned by the delegation program, so Anchor's typed
    /// owner check cannot be used across both layers.
    #[account(mut)]
    pub receipt: AccountInfo<'info>,
}

pub fn handler(ctx: Context<AuthorizeWithdraw>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let market_id_bytes = market_id.to_le_bytes();

    let mut receipt: WithdrawReceipt = {
        let data = ctx.accounts.receipt.try_borrow_data()?;
        WithdrawReceipt::try_deserialize(&mut &data[..])?
    };
    // The receipt names its owner; verify this account *is* that owner's
    // receipt, and that the portfolio is that owner's portfolio.
    let (expected_receipt, _) = Pubkey::find_program_address(
        &[WITHDRAW_RECEIPT_SEED, &market_id_bytes, receipt.owner.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(ctx.accounts.receipt.key(), expected_receipt, AnqaError::NotOrderOwner);
    let (expected_portfolio, _) = Pubkey::find_program_address(
        &[PORTFOLIO_SEED, &market_id_bytes, receipt.owner.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.portfolio.key(),
        expected_portfolio,
        AnqaError::NotOrderOwner
    );
    require!(
        matches!(receipt.stage, WithdrawStage::Requested),
        AnqaError::ReceiptAlreadyProcessed
    );

    let amount = receipt.requested;

    // The kernel's verdict. A refusal is not a revert: the receipt must reach
    // base layer either way, or the reservation it holds is stranded.
    let authorized = {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut pf = ctx.accounts.portfolio.load_mut()?;

        if pf.reserved() != 0 {
            // Resting orders hold margin; withdrawing under them is refused.
            0
        } else {
            let mut view = MarketGroupV16ViewMut::new(
                group.header_mut(),
                &mut slots.markets_mut()[..n_assets],
            );
            let mut pv = PortfolioV16ViewMut::new(pf.account_mut());
            // Every kernel gate applies: flat account, losses settled first,
            // equity still non-negative afterwards. The debit happens here,
            // before a single token moves — a crash after this leaves the
            // trader owed money rather than the protocol short.
            let verdict = view
                .full_account_refresh_not_atomic(&mut pv)
                .and_then(|_| view.withdraw_not_atomic(&mut pv, amount as u128));
            if verdict.is_ok() {
                amount
            } else {
                0
            }
        }
    };

    receipt.authorized = authorized;
    receipt.stage = WithdrawStage::Authorized;
    {
        let mut data = ctx.accounts.receipt.try_borrow_mut_data()?;
        let mut cursor: &mut [u8] = &mut data;
        receipt.try_serialize(&mut cursor)?;
    }

    // Send the receipt home, with the settle queued behind the undelegation.
    let settle_action = build_settle_action(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.market.key(),
        ctx.accounts.receipt.key(),
        &receipt,
        &market_id_bytes,
    );
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.receipt.to_account_info()])
    .add_post_undelegate_actions([settle_action])
    .build_and_invoke()?;

    emit!(WithdrawAuthorized {
        market_id,
        owner: receipt.owner,
        requested: amount,
        authorized,
    });
    msg!("anqa: withdrawal verdict {} of {} requested", authorized, amount);
    Ok(())
}

/// The base-layer settle, as an action for the validator to dispatch once the
/// receipt has undelegated. The trailing `escrow_auth`/`escrow` accounts that
/// `#[action]` appends are the validator's to inject, so they are truncated
/// off the meta list here.
fn build_settle_action<'info>(
    payer: AccountInfo<'info>,
    market: Pubkey,
    receipt_key: Pubkey,
    receipt: &WithdrawReceipt,
    market_id_bytes: &[u8; 8],
) -> CallHandler<'info> {
    let (ledger, _) = Pubkey::find_program_address(
        &[LEDGER_SEED, market_id_bytes, receipt.owner.as_ref()],
        &crate::ID,
    );
    let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, market_id_bytes], &crate::ID);
    let mut metas = __client_accounts_settle_withdraw::SettleWithdraw {
        market,
        ledger,
        receipt: receipt_key,
        owner: receipt.owner,
        payout_to: receipt.payout_to,
        vault,
        token_program: anchor_spl::token::ID,
        escrow_auth: Pubkey::default(),
        escrow: Pubkey::default(),
    }
    .to_account_metas(None);
    metas.truncate(metas.len().saturating_sub(ACTION_INJECTED_TRAILING_ACCOUNTS));

    CallHandler {
        args: ActionArgs::new(crate::instruction::SettleWithdraw {}.data()),
        compute_units: SETTLE_ACTION_COMPUTE_UNITS,
        escrow_authority: payer,
        destination_program: crate::ID,
        accounts: metas.into_iter().map(ShortAccountMeta::from).collect(),
    }
}
