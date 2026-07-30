//! Delegate the oracle state into the ephemeral rollup.
//!
//! Easy to miss: the relay (`InternalOracle`) is only the *feed*. The crank
//! also **writes** `OracleState` on every accept — last mark, EMA, breaker —
//! so marking cannot run inside the rollup unless this account is in too. See
//! `delegate_book.rs` for the full delegated set.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::ORACLE_STATE_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateOracleState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: mark acceptance state — last price, EMA, circuit breaker.
    #[account(mut, del, seeds = [ORACLE_STATE_SEED, &market_id.to_le_bytes()], bump)]
    pub oracle_state: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateOracleState>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_oracle_state(
        &ctx.accounts.payer,
        &[ORACLE_STATE_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: oracle state delegated for market {}", market_id);
    Ok(())
}
