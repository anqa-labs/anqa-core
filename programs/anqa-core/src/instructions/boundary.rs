//! Moving value across the rollup boundary.
//!
//! Four instructions, one mechanism — which is why they live together. Each is
//! useless without the others, and reading them apart hides the invariant.
//!
//! ```text
//!  deposit path        L1  deposit          tokens -> vault, ledger.deposited += x
//!                      ER  claim_deposit    credit basket by (deposited - claimed)
//!
//!  withdraw path       L1  request_withdraw reserve on ledger, open a receipt
//!                      ER  authorize_withdraw  kernel debits basket, receipt gets
//!                                              the true amount
//!                      L1  settle_withdraw  pay the authorized amount, release
//!                                           the reservation
//! ```
//!
//! The asymmetry that shapes all of it: **the rollup can read base-layer state,
//! the base layer cannot see inside the rollup.** So deposits flow by the rollup
//! *reading* a monotonic ledger, and withdrawals flow by the rollup *writing* a
//! decision into a receipt that the base layer later consumes.
//!
//! Deposits need no receipt because the ledger only grows and the basket
//! remembers its high-water mark. Withdrawals need one because only the risk
//! kernel knows what a trader can afford, and that knowledge lives inside.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ASSET_SLOTS_SEED, LEDGER_SEED, MARKET_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED, VAULT_SEED,
    WITHDRAW_RECEIPT_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::state::{
    AssetSlots, Market, Portfolio, RiskGroup, UserDepositLedger, WithdrawReceipt, WithdrawStage,
};

#[event]
pub struct DepositClaimed {
    pub market_id: u64,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WithdrawRequested {
    pub market_id: u64,
    pub owner: Pubkey,
    pub reserved: u64,
}

#[event]
pub struct WithdrawSettled {
    pub market_id: u64,
    pub owner: Pubkey,
    pub paid: u64,
}

// ─────────────────────────── ER: claim deposits ───────────────────────────

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    /// Permissionless — crediting a trader their own deposit can only help them.
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

    /// The basket. Delegated to the rollup when this runs there.
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), ledger.owner.as_ref()],
        bump,
        constraint = portfolio.load()?.owner == ledger.owner @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    /// Base-layer ledger. **Read only** — the rollup cannot write it, which is
    /// exactly why the high-water mark lives in the basket instead.
    #[account(
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), ledger.owner.as_ref()],
        bump = ledger.bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,
}

pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    let deposited = ctx.accounts.ledger.deposited;
    let claimed = ctx.accounts.portfolio.load()?.claimed();
    let delta = deposited.saturating_sub(claimed);
    require!(delta > 0, AnqaError::NothingToClaim);

    {
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
    }

    emit!(DepositClaimed {
        market_id: ctx.accounts.market.market_id,
        owner: ctx.accounts.ledger.owner,
        amount: delta,
    });
    msg!("anqa: claimed {} into the basket", delta);
    Ok(())
}

// ────────────────────── L1: request a withdrawal ──────────────────────

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
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump = ledger.bump,
        constraint = ledger.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    #[account(
        init,
        payer = trader,
        space = 8 + WithdrawReceipt::INIT_SPACE,
        seeds = [WITHDRAW_RECEIPT_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, WithdrawReceipt>,

    pub system_program: Program<'info, System>,
}

pub fn request_withdraw(ctx: Context<RequestWithdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, AnqaError::InvalidSize);

    // Optimistic: base layer cannot see the basket, so this is an upper bound.
    // Reserving stops the same collateral being committed twice while the
    // rollup step is still pending.
    let reserved = ctx.accounts.ledger.reserve(amount);
    require!(reserved > 0, AnqaError::NothingToClaim);

    let r = &mut ctx.accounts.receipt;
    r.owner = ctx.accounts.trader.key();
    r.market_id = ctx.accounts.market.market_id;
    r.requested = reserved;
    r.authorized = 0;
    r.stage = WithdrawStage::Requested;
    r.created_at = Clock::get()?.unix_timestamp;
    r.bump = ctx.bumps.receipt;

    emit!(WithdrawRequested {
        market_id: r.market_id,
        owner: r.owner,
        reserved,
    });
    msg!("anqa: withdrawal of {} requested and reserved", reserved);
    Ok(())
}

// ──────────────────── ER: authorize against the basket ────────────────────

#[derive(Accounts)]
pub struct AuthorizeWithdraw<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    #[account(
        mut,
        seeds = [WITHDRAW_RECEIPT_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump = receipt.bump,
        constraint = receipt.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub receipt: Account<'info, WithdrawReceipt>,
}

pub fn authorize_withdraw(ctx: Context<AuthorizeWithdraw>) -> Result<()> {
    require!(
        matches!(ctx.accounts.receipt.stage, WithdrawStage::Requested),
        AnqaError::ReceiptAlreadyProcessed
    );
    let amount = ctx.accounts.receipt.requested;

    {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut pf = ctx.accounts.portfolio.load_mut()?;
        require!(pf.reserved() == 0, AnqaError::WithdrawWithRestingOrders);

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(pf.account_mut());

        // Every kernel gate applies: flat account, losses settled first, equity
        // still non-negative afterwards. The debit happens here, before a single
        // token moves — so a crash after this leaves the trader owed money
        // rather than the protocol short.
        map_risk(view.full_account_refresh_not_atomic(&mut pv))?;
        map_risk(view.withdraw_not_atomic(&mut pv, amount as u128))?;
    }

    let r = &mut ctx.accounts.receipt;
    r.authorized = amount;
    r.stage = WithdrawStage::Authorized;

    msg!("anqa: withdrawal of {} authorized by the risk engine", amount);
    Ok(())
}

// ───────────────────────── L1: settle and pay ─────────────────────────

#[derive(Accounts)]
pub struct SettleWithdraw<'info> {
    /// Permissionless — paying out an already-authorized amount to its owner
    /// harms nobody, and a trader must not need the keeper's goodwill to be paid.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [LEDGER_SEED, &market.market_id.to_le_bytes(), receipt.owner.as_ref()],
        bump = ledger.bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    #[account(
        mut,
        close = caller,
        seeds = [WITHDRAW_RECEIPT_SEED, &market.market_id.to_le_bytes(), receipt.owner.as_ref()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, WithdrawReceipt>,

    #[account(mut)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [VAULT_SEED, &market.market_id.to_le_bytes()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn settle_withdraw(ctx: Context<SettleWithdraw>) -> Result<()> {
    require!(
        ctx.accounts.receipt.is_authorized(),
        AnqaError::ReceiptNotAuthorized
    );
    let paid = ctx.accounts.receipt.authorized;
    let reserved = ctx.accounts.receipt.requested;
    let owner = ctx.accounts.receipt.owner;

    // The token account must belong to the trader named on the receipt, or a
    // permissionless settle would let anyone redirect someone else's payout.
    require_keys_eq!(
        ctx.accounts.trader_token_account.owner,
        owner,
        AnqaError::NotOrderOwner
    );

    ctx.accounts.ledger.settle(reserved, paid)?;

    if paid > 0 {
        let market_id_bytes = ctx.accounts.market.market_id.to_le_bytes();
        let seeds: &[&[u8]] = &[VAULT_SEED, &market_id_bytes, &[ctx.bumps.vault]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.trader_token_account.to_account_info(),
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
