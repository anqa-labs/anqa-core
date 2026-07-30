//! Delegate the risk group (the router) into the ephemeral rollup.
//!
//! `execute_trade` writes its header on every fill, so matching cannot run in
//! the rollup without it. See `delegate_book.rs` for the full delegated set.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::RISK_GROUP_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateRiskGroup<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the router — the margin engine over every slab.
    #[account(mut, del, seeds = [RISK_GROUP_SEED, &market_id.to_le_bytes()], bump)]
    pub risk_group: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateRiskGroup>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_risk_group(
        &ctx.accounts.payer,
        &[RISK_GROUP_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: router delegated for market {}", market_id);
    Ok(())
}
