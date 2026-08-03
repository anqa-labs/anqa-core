//! Base layer: reserve collateral, open a withdrawal receipt, and delegate it
//! to the rollup.
//!
//! First leg of the withdraw lifecycle (the others are `authorize_withdraw` and
//! `settle_withdraw`). The trader signs here and **only** here — the rollup leg
//! is permissionless and the settle is signerless.
//!
//! ## Why the receipt is delegated
//!
//! The rollup can only write accounts delegated to it — a receipt left on base
//! could never receive the kernel's verdict. Delegating it also buys the
//! lifecycle its safety for free: while the request is in flight the receipt is
//! owned by the delegation program, so the base-layer settle **cannot** run
//! early — Anchor's owner check fails until the rollup hands the receipt back.

use anchor_lang::prelude::*;
use anchor_lang::{system_program, InstructionData, ToAccountMetas};
use anchor_spl::token::TokenAccount;
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::{
    delegate_account, delegate_account_with_actions, DelegateAccounts,
};
use ephemeral_rollups_sdk::dlp_api::compact::ClearText;
// The delegation program's API is on the Solana 3.x type stack; Anchor is on
// 2.x. The queued instruction must be built in *its* types, converted at the
// boundary by bytes.
use solana_instruction::{AccountMeta as DlpAccountMeta, Instruction as DlpInstruction};

use crate::constants::{
    delegate_config, ASSET_SLOTS_SEED, LEDGER_SEED, MARKET_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED,
    WITHDRAW_RECEIPT_SEED,
};
use crate::errors::AnqaError;
use crate::instructions::authorize_withdraw::__client_accounts_authorize_withdraw;
use crate::state::{Market, UserDepositLedger, WithdrawReceipt, WithdrawStage};

#[event]
pub struct WithdrawRequested {
    pub market_id: u64,
    pub owner: Pubkey,
    pub reserved: u64,
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [LEDGER_SEED, &market.group_id.to_le_bytes(), trader.key().as_ref()],
        bump = ledger.bump,
        constraint = ledger.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    /// Where the payout will go. Captured now, while the trader is signing, so
    /// the later signerless settle cannot be pointed anywhere else.
    pub payout_to: Box<Account<'info, TokenAccount>>,

    /// CHECK: created by hand in the handler (Anchor's `init` serializes on
    /// exit, which is after the delegation CPI would need the bytes in place),
    /// then delegated to the rollup. Seeds bind it to this trader and market.
    #[account(
        mut,
        seeds = [WITHDRAW_RECEIPT_SEED, &market.group_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub receipt: AccountInfo<'info>,

    // ── delegation plumbing, validated by the delegation program's CPI ──
    /// CHECK: delegate buffer PDA for the receipt, derived by the SDK.
    #[account(mut)]
    pub buffer: AccountInfo<'info>,
    /// CHECK: delegation record PDA, owned by the delegation program.
    #[account(mut)]
    pub delegation_record: AccountInfo<'info>,
    /// CHECK: delegation metadata PDA, owned by the delegation program.
    #[account(mut)]
    pub delegation_metadata: AccountInfo<'info>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub owner_program: AccountInfo<'info>,
    /// CHECK: the delegation program.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RequestWithdraw>,
    amount: u64,
    queue_authorize: bool,
) -> Result<()> {
    require!(amount > 0, AnqaError::InvalidSize);

    // Optimistic: base layer cannot see the portfolio, so this is an upper bound.
    // Reserving stops the same collateral being committed twice while the
    // rollup step is still pending.
    let reserved = ctx.accounts.ledger.reserve(amount);
    require!(reserved > 0, AnqaError::NothingToClaim);

    // Isolated margin: ledger, receipt and portfolio are scoped to THIS
    // market. Only the risk-engine derivations inside the queued authorize
    // (built below from the group id) stay hub-wide.
    let group_id = ctx.accounts.market.group_id;
    let market_id = ctx.accounts.market.market_id;
    let trader = ctx.accounts.trader.key();

    let receipt = WithdrawReceipt {
        owner: trader,
        market_id,
        requested: reserved,
        authorized: 0,
        payout_to: ctx.accounts.payout_to.key(),
        stage: WithdrawStage::Requested,
        created_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.receipt,
    };
    write_fresh_receipt(&ctx, &receipt)?;

    // Hand the receipt to the rollup. With `queue_authorize` the validator
    // runs the rollup leg itself the moment the delegation lands; without it a
    // keeper (or the trader's client) submits `authorize_withdraw` to the
    // rollup directly — the instruction is permissionless either way.
    let market_id_bytes = market_id.to_le_bytes();
    let receipt_seeds: &[&[u8]] = &[WITHDRAW_RECEIPT_SEED, &market_id_bytes, trader.as_ref()];
    let trader_info = ctx.accounts.trader.to_account_info();
    let receipt_info = ctx.accounts.receipt.to_account_info();
    let owner_program_info = ctx.accounts.owner_program.to_account_info();
    let buffer_info = ctx.accounts.buffer.to_account_info();
    let record_info = ctx.accounts.delegation_record.to_account_info();
    let metadata_info = ctx.accounts.delegation_metadata.to_account_info();
    let delegation_program_info = ctx.accounts.delegation_program.to_account_info();
    let system_program_info = ctx.accounts.system_program.to_account_info();
    let delegate_accounts = DelegateAccounts {
        payer: &trader_info,
        pda: &receipt_info,
        owner_program: &owner_program_info,
        buffer: &buffer_info,
        delegation_record: &record_info,
        delegation_metadata: &metadata_info,
        delegation_program: &delegation_program_info,
        system_program: &system_program_info,
    };

    if queue_authorize {
        let authorize_ix = build_authorize_ix(&ctx, group_id, trader);
        delegate_account_with_actions(
            delegate_accounts,
            receipt_seeds,
            delegate_config(),
            vec![authorize_ix].cleartext(),
            &[&trader_info],
        )?;
    } else {
        delegate_account(delegate_accounts, receipt_seeds, delegate_config())?;
    }

    emit!(WithdrawRequested {
        market_id,
        owner: trader,
        reserved,
    });
    msg!("anqa: withdrawal of {} requested, reserved, delegated", reserved);
    Ok(())
}

/// Create the receipt account by hand and serialize the receipt into it.
///
/// By hand because the bytes must be in place *before* the delegation CPI in
/// the same instruction copies them into its buffer — Anchor's `init` writes
/// on instruction exit, which is too late. Tolerates pre-existing lamports
/// (anyone can transfer into a PDA address), so a griefer cannot block the
/// account's creation.
fn write_fresh_receipt(ctx: &Context<RequestWithdraw>, receipt: &WithdrawReceipt) -> Result<()> {
    let space = 8 + WithdrawReceipt::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let info = ctx.accounts.receipt.to_account_info();
    require!(info.data_is_empty(), AnqaError::ReceiptAlreadyProcessed);

    let market_id_bytes = receipt.market_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        WITHDRAW_RECEIPT_SEED,
        &market_id_bytes,
        receipt.owner.as_ref(),
        &[receipt.bump],
    ]];

    let lamports = info.lamports();
    if lamports < rent {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: info.clone(),
                },
            ),
            rent - lamports,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Allocate { account_to_allocate: info.clone() },
            signer_seeds,
        ),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Assign { account_to_assign: info.clone() },
            signer_seeds,
        ),
        &crate::ID,
    )?;

    let mut data = info.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    receipt.try_serialize(&mut cursor)?;
    Ok(())
}

/// Convert an Anchor pubkey into the delegation API's pubkey type.
fn dlp_key(key: &Pubkey) -> solana_pubkey::Pubkey {
    solana_pubkey::Pubkey::new_from_array(key.to_bytes())
}

/// The rollup leg, as an instruction the validator can dispatch after the
/// delegation lands. Anchor's generated client-accounts mirror keeps the
/// account list in sync with `AuthorizeWithdraw` at compile time.
fn build_authorize_ix(
    ctx: &Context<RequestWithdraw>,
    market_id: u64,
    trader: Pubkey,
) -> DlpInstruction {
    let market_id_bytes = market_id.to_le_bytes();
    let (risk_group, _) =
        Pubkey::find_program_address(&[RISK_GROUP_SEED, &market_id_bytes], &crate::ID);
    let (asset_slots, _) =
        Pubkey::find_program_address(&[ASSET_SLOTS_SEED, &market_id_bytes], &crate::ID);
    // Isolated margin: the withdrawal is judged against THIS market's
    // portfolio — the only pot this market's positions can draw on.
    let (portfolio, _) = Pubkey::find_program_address(
        &[
            PORTFOLIO_SEED,
            &ctx.accounts.market.market_id.to_le_bytes(),
            trader.as_ref(),
        ],
        &crate::ID,
    );
    let metas = __client_accounts_authorize_withdraw::AuthorizeWithdraw {
        payer: trader,
        market: ctx.accounts.market.key(),
        risk_group,
        asset_slots,
        portfolio,
        receipt: ctx.accounts.receipt.key(),
        magic_context: MAGIC_CONTEXT_ID,
        magic_program: MAGIC_PROGRAM_ID,
    }
    .to_account_metas(None);
    DlpInstruction {
        program_id: dlp_key(&crate::ID),
        accounts: metas
            .into_iter()
            .map(|m| DlpAccountMeta {
                pubkey: dlp_key(&m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: crate::instruction::AuthorizeWithdraw {}.data(),
    }
}
