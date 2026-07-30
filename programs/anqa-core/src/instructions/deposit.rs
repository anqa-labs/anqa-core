//! Deposit collateral — one signature, credited in the rollup.
//!
//! One of exactly two instructions where tokens actually move (the other is
//! `settle_withdraw`). Trades never transfer tokens — a fill mints a long/short
//! pair in two margin accounts and nothing is delivered.
//!
//! ## The rail
//!
//! ```text
//!  L1  deposit(amount, queue_claim)   tokens -> vault; ledger.deposited += x;
//!                                     create DepositReceipt, DELEGATE it with
//!                                     claim_deposit queued          [user signs]
//!  ER  claim_deposit                  credit the portfolio (numbers only),
//!                                     receipt committed home with the close
//!                                     queued behind it       [validator runs]
//!  L1  close_deposit_receipt          receipt closed, rent back    [validator]
//! ```
//!
//! The receipt is the *vehicle* for the queued rollup leg; the **accounting**
//! stays with the monotonic ledger and the portfolio's high-water mark, so a
//! stalled receipt can never strand or double-credit a deposit — a keeper can
//! always drive `claim_deposit` by hand.
//!
//! With `queue_claim = false` no receipt is created at all and this is a plain
//! base-layer deposit: tokens plus ledger, claim driven by keeper or client.
//! Note the portfolio must already be **delegated** for the queued claim to
//! run — the rollup can only credit an account it holds.

use anchor_lang::prelude::*;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::{delegate_account_with_actions, DelegateAccounts};
use ephemeral_rollups_sdk::dlp_api::compact::ClearText;
use solana_instruction::{AccountMeta as DlpAccountMeta, Instruction as DlpInstruction};

use crate::constants::{
    delegate_config, ASSET_SLOTS_SEED, DEPOSIT_RECEIPT_SEED, LEDGER_SEED, MARKET_SEED,
    PORTFOLIO_SEED, RISK_GROUP_SEED, VAULT_SEED,
};
use crate::errors::AnqaError;
use crate::instructions::claim_deposit::__client_accounts_claim_deposit;
use crate::state::{DepositReceipt, Market, UserDepositLedger};

#[event]
pub struct Deposited {
    pub market_id: u64,
    pub owner: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Must already exist — see `initialize_ledger`. The ledger is a permanent
    /// record, not something a deposit conjures into being.
    #[account(
        mut,
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump = ledger.bump,
        constraint = ledger.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    /// Trader's USDC account.
    #[account(mut)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,

    /// Protocol custody. Holds every trader's collateral; never delegated to the
    /// rollup, so collateral stays outside the enclave's trust boundary.
    #[account(
        mut,
        seeds = [VAULT_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: the deposit receipt — created by hand and delegated in the
    /// handler when `queue_claim` is set; untouched otherwise.
    #[account(
        mut,
        seeds = [DEPOSIT_RECEIPT_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub receipt: AccountInfo<'info>,

    // ── delegation plumbing, validated by the delegation program's CPI ──
    /// CHECK: delegate buffer PDA for the receipt.
    #[account(mut)]
    pub buffer: AccountInfo<'info>,
    /// CHECK: delegation record PDA.
    #[account(mut)]
    pub delegation_record: AccountInfo<'info>,
    /// CHECK: delegation metadata PDA.
    #[account(mut)]
    pub delegation_metadata: AccountInfo<'info>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub owner_program: AccountInfo<'info>,
    /// CHECK: the delegation program.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64, queue_claim: bool) -> Result<()> {
    require!(amount > 0, AnqaError::InvalidSize);

    // 1. Move the tokens.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. Record it on the ledger — the permanent, monotonic source of truth.
    ctx.accounts.ledger.credit_deposit(amount)?;

    let market_id = ctx.accounts.market.market_id;
    let trader = ctx.accounts.trader.key();

    // 3. The rollup leg, if asked for: a receipt delegated with the claim
    //    queued behind it, so the validator credits the portfolio the moment
    //    the delegation lands. One receipt in flight per trader — a second
    //    queued deposit waits for the first to close.
    if queue_claim {
        let receipt = DepositReceipt {
            owner: trader,
            market_id,
            amount,
            credited: 0,
            created_at: Clock::get()?.unix_timestamp,
            bump: ctx.bumps.receipt,
        };
        write_fresh_receipt(&ctx, &receipt)?;

        let market_id_bytes = market_id.to_le_bytes();
        let receipt_seeds: &[&[u8]] =
            &[DEPOSIT_RECEIPT_SEED, &market_id_bytes, trader.as_ref()];
        let trader_info = ctx.accounts.trader.to_account_info();
        let receipt_info = ctx.accounts.receipt.to_account_info();
        let owner_program_info = ctx.accounts.owner_program.to_account_info();
        let buffer_info = ctx.accounts.buffer.to_account_info();
        let record_info = ctx.accounts.delegation_record.to_account_info();
        let metadata_info = ctx.accounts.delegation_metadata.to_account_info();
        let delegation_program_info = ctx.accounts.delegation_program.to_account_info();
        let system_program_info = ctx.accounts.system_program.to_account_info();
        delegate_account_with_actions(
            DelegateAccounts {
                payer: &trader_info,
                pda: &receipt_info,
                owner_program: &owner_program_info,
                buffer: &buffer_info,
                delegation_record: &record_info,
                delegation_metadata: &metadata_info,
                delegation_program: &delegation_program_info,
                system_program: &system_program_info,
            },
            receipt_seeds,
            delegate_config(),
            vec![build_claim_ix(&ctx, market_id, trader)].cleartext(),
            &[&trader_info],
        )?;
    }

    emit!(Deposited {
        market_id,
        owner: trader,
        amount,
    });
    msg!(
        "anqa: deposited {} to the vault and ledger{}",
        amount,
        if queue_claim { ", claim queued" } else { "" }
    );
    Ok(())
}

/// Create the receipt account by hand and serialize it, before the delegation
/// CPI needs the bytes in place. Tolerates pre-existing lamports so a griefer
/// cannot block creation by dusting the address.
fn write_fresh_receipt(ctx: &Context<Deposit>, receipt: &DepositReceipt) -> Result<()> {
    use anchor_lang::system_program;

    let space = 8 + DepositReceipt::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let info = ctx.accounts.receipt.to_account_info();
    require!(info.data_is_empty(), AnqaError::ReceiptAlreadyProcessed);

    let market_id_bytes = receipt.market_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        DEPOSIT_RECEIPT_SEED,
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

/// `claim_deposit`, as the instruction the validator dispatches inside the
/// rollup once the receipt's delegation lands. The generated client-accounts
/// mirror keeps the account list in sync with `ClaimDeposit` at compile time.
fn build_claim_ix(ctx: &Context<Deposit>, market_id: u64, trader: Pubkey) -> DlpInstruction {
    let market_id_bytes = market_id.to_le_bytes();
    let derive =
        |seeds: &[&[u8]]| -> Pubkey { Pubkey::find_program_address(seeds, &crate::ID).0 };
    let metas = __client_accounts_claim_deposit::ClaimDeposit {
        caller: trader,
        market: ctx.accounts.market.key(),
        risk_group: derive(&[RISK_GROUP_SEED, &market_id_bytes]),
        asset_slots: derive(&[ASSET_SLOTS_SEED, &market_id_bytes]),
        portfolio: derive(&[PORTFOLIO_SEED, &market_id_bytes, trader.as_ref()]),
        ledger: ctx.accounts.ledger.key(),
        receipt: Some(ctx.accounts.receipt.key()),
        magic_context: Some(MAGIC_CONTEXT_ID),
        magic_program: Some(MAGIC_PROGRAM_ID),
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
        data: crate::instruction::ClaimDeposit {}.data(),
    }
}
