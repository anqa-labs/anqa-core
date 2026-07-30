//! Delegate the internal oracle relay into the ephemeral rollup.
//!
//! The relayed mark; without it the crank cannot run inside the rollup. See
//! `delegate_book.rs` for the full delegated set.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::INTERNAL_ORACLE_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateInternalOracle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the relayed mark.
    #[account(mut, del, seeds = [INTERNAL_ORACLE_SEED, &market_id.to_le_bytes()], bump)]
    pub internal_oracle: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateInternalOracle>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_internal_oracle(
        &ctx.accounts.payer,
        &[INTERNAL_ORACLE_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: relayed oracle delegated for market {}", market_id);
    Ok(())
}
