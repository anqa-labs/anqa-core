//! Delegate the book into the ephemeral rollup.
//!
//! One of five sibling instructions (`delegate_book`, `delegate_market_config`,
//! `delegate_risk_group`, `delegate_asset_slots`, `delegate_internal_oracle`)
//! that move a market's shared trading state into the rollup. **One instruction
//! per account.** Not because it is prettier, but because each `Accounts`
//! struct validates its own PDA seeds inside `try_accounts`, and four of those
//! in one struct costs 4,104 bytes against Solana's 4,096 byte stack frame.
//! Splitting them sidesteps the limit entirely and lets each account be
//! delegated or left behind independently.
//!
//! ## What has to go in, and why
//!
//! | account | why |
//! |---|---|
//! | **book** | the resting orders matching reads and writes |
//! | **risk group** (router) | `execute_trade` writes the header on every fill (`loss_stale_active` at minimum, plus bankruptcy counters) |
//! | **asset slots** (slabs) | per-asset open interest and engine state, written on every fill |
//! | **internal oracle** | the relayed mark; without it the crank cannot run inside the rollup |
//! | **oracle state** | the crank *writes* it on every accept — last mark, EMA, breaker |
//!
//! Portfolios are delegated separately, per trader — see `delegate_portfolio.rs`.
//!
//! ## What stays on base chain
//!
//! The **money**: custody vault, insurance vault, protocol vault, deposit
//! ledgers. That is the honest form of "collateral never enters the rollup" —
//! the funds stay out, the accounting goes in and commits back.
//!
//! And the **market config**. Nothing writes it on the trading path, the
//! rollup can clone-read undelegated base accounts (verified live on devnet),
//! and delegating it would flip its base-layer owner to the delegation
//! program — instantly breaking every base instruction that reads `market`
//! through Anchor's owner check (`deposit`, the withdraw legs, `forced_exit`).
//!
//! ## Consequence worth knowing
//!
//! Because every fill writes the shared router, a market group lives in **one**
//! rollup. Inside it that costs nothing, since the sequencer orders transactions
//! anyway. But a group cannot be spread across regions; splitting later means
//! separate market groups, which also splits cross-margin.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::BOOK_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ownership transfers to the delegation program; validated by seeds.
    #[account(mut, del, seeds = [BOOK_SEED, &market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateBook>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_book(
        &ctx.accounts.payer,
        &[BOOK_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: book delegated for market {}", market_id);
    Ok(())
}
