//! Move a market's shared state into the rollup.
//!
//! Four accounts go together because a fill touches all four atomically:
//!
//! - **book** — the resting orders
//! - **risk group** (the router) — the margin engine over every slab
//! - **asset slots** (the slabs) — per-asset open interest and engine state
//! - **internal oracle** — the relayed mark
//!
//! The router has to be in here even though it is shared across every trader.
//! `execute_trade` takes a view over the header *and* the slabs and writes both
//! on every fill (`loss_stale_active` at minimum, plus the bankruptcy counters).
//! A transaction cannot write a delegated account and an undelegated one, so
//! leaving the router on base chain would make fills impossible.
//!
//! What genuinely stays on base chain is the **money**: custody vault, insurance
//! vault, protocol vault, deposit ledgers. That is the honest form of "collateral
//! never enters the rollup" — the funds stay out, the accounting goes in and
//! commits back.
//!
//! ## Consequence worth knowing
//!
//! Because every fill writes the shared router, a market group lives in **one**
//! rollup. Inside it that costs nothing — the sequencer orders transactions
//! anyway — but a group cannot be spread across regions. Splitting later means
//! separate market groups, which also splits cross-margin.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::{
    ASSET_SLOTS_SEED, BOOK_SEED, INTERNAL_ORACLE_SEED, RISK_GROUP_SEED,
};

#[event]
pub struct MarketDelegated {
    pub market_id: u64,
}

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: delegated by the SDK; seeds bind it to this market.
    #[account(mut, del, seeds = [BOOK_SEED, &market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,

    /// CHECK: the router. Written on every fill, so it must come along.
    #[account(mut, del, seeds = [RISK_GROUP_SEED, &market_id.to_le_bytes()], bump)]
    pub risk_group: AccountInfo<'info>,

    /// CHECK: the slabs — per-asset engine state and open interest.
    #[account(mut, del, seeds = [ASSET_SLOTS_SEED, &market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountInfo<'info>,

    /// CHECK: the relayed mark. Without it the crank cannot run in the rollup.
    #[account(mut, del, seeds = [INTERNAL_ORACLE_SEED, &market_id.to_le_bytes()], bump)]
    pub internal_oracle: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateMarket>, market_id: u64) -> Result<()> {
    let id = market_id.to_le_bytes();
    let cfg = DelegateConfig::default();

    ctx.accounts
        .delegate_book(&ctx.accounts.payer, &[BOOK_SEED, &id], cfg.clone())?;
    ctx.accounts
        .delegate_risk_group(&ctx.accounts.payer, &[RISK_GROUP_SEED, &id], cfg.clone())?;
    ctx.accounts
        .delegate_asset_slots(&ctx.accounts.payer, &[ASSET_SLOTS_SEED, &id], cfg.clone())?;
    ctx.accounts.delegate_internal_oracle(
        &ctx.accounts.payer,
        &[INTERNAL_ORACLE_SEED, &id],
        cfg,
    )?;

    emit!(MarketDelegated { market_id });
    msg!(
        "anqa: market {} delegated — book, router, slabs and oracle",
        market_id
    );
    Ok(())
}
