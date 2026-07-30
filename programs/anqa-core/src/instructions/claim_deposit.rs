//! Rollup: credit a portfolio with deposits recorded on the base-layer ledger.
//!
//! The deposit half of the boundary (see `state/deposit_ledger.rs` for the full
//! mechanism): the ledger only ever grows, the portfolio remembers the
//! high-water mark it has absorbed, and this instruction credits the difference
//! through the risk kernel. Idempotent by construction — replaying it is a
//! no-op — and no cross-boundary write is ever needed.
//!
//! ## Two ways in
//!
//! - **Receipt rail** (normal): `deposit(queue_claim = true)` delegated a
//!   `DepositReceipt` with this instruction queued behind it. The validator
//!   dispatches it here with the receipt attached; the receipt is marked
//!   credited and committed home with `close_deposit_receipt` queued, so the
//!   trader's rent comes back without another signature.
//! - **Keeper rail** (fallback): no receipt, no magic accounts — anyone calls
//!   this directly wherever the portfolio lives. This is what makes a stuck
//!   receipt harmless: the credit never depends on it.

use anchor_lang::prelude::*;
use anchor_lang::{InstructionData, ToAccountMetas};
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ACTION_INJECTED_TRAILING_ACCOUNTS, ASSET_SLOTS_SEED, DEPOSIT_RECEIPT_SEED, LEDGER_SEED,
    MARKET_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED, SETTLE_ACTION_COMPUTE_UNITS,
};
use crate::errors::{map_risk, AnqaError};
use crate::instructions::close_deposit_receipt::__client_accounts_close_deposit_receipt;
use crate::state::{AssetSlots, DepositReceipt, Market, Portfolio, RiskGroup, UserDepositLedger};

#[event]
pub struct DepositClaimed {
    pub market_id: u64,
    pub owner: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    /// Permissionless — crediting a trader their own deposit can only help them.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// The portfolio. Delegated to the rollup when this runs there.
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), ledger.owner.as_ref()],
        bump,
        constraint = portfolio.load()?.owner == ledger.owner @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    /// Base-layer ledger. **Read only** — the rollup cannot write it, which is
    /// exactly why the high-water mark lives in the portfolio instead.
    #[account(
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), ledger.owner.as_ref()],
        bump = ledger.bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    /// CHECK: the delegated deposit receipt, when riding the receipt rail.
    /// Deserialized and PDA-verified by hand; committed home with the close
    /// queued behind it.
    #[account(mut)]
    pub receipt: Option<AccountInfo<'info>>,

    /// CHECK: MagicBlock context — required only with a receipt.
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: Option<AccountInfo<'info>>,

    /// CHECK: MagicBlock program — required only with a receipt.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<ClaimDeposit>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let deposited = ctx.accounts.ledger.deposited;
    let claimed = ctx.accounts.portfolio.load()?.claimed();
    let delta = deposited.saturating_sub(claimed);

    // Nothing to claim is a no-op, not an error: when this arrives as a queued
    // action a revert helps nobody, and an already-absorbed receipt must still
    // travel home to be closed.
    if delta > 0 {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut pf = ctx.accounts.portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(pf.account_mut());
        map_risk(view.deposit_not_atomic(&mut pv, delta as u128))?;

        // Advance the mark only after the credit succeeded, so a failed credit
        // can be retried rather than silently skipped.
        pf.set_claimed(deposited);

        emit!(DepositClaimed {
            market_id,
            owner: ctx.accounts.ledger.owner,
            amount: delta,
        });
        msg!("anqa: claimed {} into the portfolio", delta);
    } else {
        msg!("anqa: nothing to claim");
    }

    // Receipt rail: mark it credited and send it home, with the close queued
    // behind the undelegation so the trader's rent returns by itself.
    if let Some(receipt_info) = &ctx.accounts.receipt {
        let magic_context = ctx
            .accounts
            .magic_context
            .as_ref()
            .ok_or(AnqaError::ReceiptNotAuthorized)?;
        let magic_program = ctx
            .accounts
            .magic_program
            .as_ref()
            .ok_or(AnqaError::ReceiptNotAuthorized)?;

        let mut receipt: DepositReceipt = {
            let data = receipt_info.try_borrow_data()?;
            DepositReceipt::try_deserialize(&mut &data[..])?
        };
        let market_id_bytes = market_id.to_le_bytes();
        let (expected, _) = Pubkey::find_program_address(
            &[DEPOSIT_RECEIPT_SEED, &market_id_bytes, receipt.owner.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(receipt_info.key(), expected, AnqaError::NotOrderOwner);
        require_keys_eq!(receipt.owner, ctx.accounts.ledger.owner, AnqaError::NotOrderOwner);

        receipt.credited = 1;
        {
            let mut data = receipt_info.try_borrow_mut_data()?;
            let mut cursor: &mut [u8] = &mut data;
            receipt.try_serialize(&mut cursor)?;
        }

        let close_action = build_close_action(
            ctx.accounts.caller.to_account_info(),
            ctx.accounts.market.key(),
            receipt_info.key(),
            &receipt,
        );
        MagicIntentBundleBuilder::new(
            ctx.accounts.caller.to_account_info(),
            magic_context.to_account_info(),
            magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[receipt_info.to_account_info()])
        .add_post_undelegate_actions([close_action])
        .build_and_invoke()?;
    }

    Ok(())
}

/// The base-layer close, as an action for the validator to dispatch once the
/// receipt has undelegated. The trailing escrow accounts `#[action]` appends
/// are the validator's to inject, so they are truncated off the metas.
fn build_close_action<'info>(
    payer: AccountInfo<'info>,
    market: Pubkey,
    receipt_key: Pubkey,
    receipt: &DepositReceipt,
) -> CallHandler<'info> {
    let mut metas = __client_accounts_close_deposit_receipt::CloseDepositReceipt {
        market,
        receipt: receipt_key,
        owner: receipt.owner,
        escrow_auth: Pubkey::default(),
        escrow: Pubkey::default(),
    }
    .to_account_metas(None);
    metas.truncate(metas.len().saturating_sub(ACTION_INJECTED_TRAILING_ACCOUNTS));

    CallHandler {
        args: ActionArgs::new(crate::instruction::CloseDepositReceipt {}.data()),
        compute_units: SETTLE_ACTION_COMPUTE_UNITS,
        escrow_authority: payer,
        destination_program: crate::ID,
        accounts: metas.into_iter().map(ShortAccountMeta::from).collect(),
    }
}
