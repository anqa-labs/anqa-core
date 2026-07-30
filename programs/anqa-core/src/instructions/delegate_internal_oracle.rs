//! Delegate the internal oracle relay into the ephemeral rollup.
//!
//! The relayed mark. `crank` and `reanchor_oracle` read it on every tick, so
//! it belongs to the delegated set — see `delegate_book.rs`.
//!
//! **It must be delegated, not clone-read.** Leaving it on base looks tempting
//! (only `sync_internal_oracle` writes it, and the rollup clone-reads base
//! accounts happily) but the clone is a snapshot: the mark then freezes at
//! whatever it was when the rollup first saw it, and the crank marks every
//! position against a price that never moves. Tried on devnet; it fails
//! quietly, which is the worst way for an oracle to fail.
//!
//! What makes delegation workable is that **`sync_internal_oracle` runs inside
//! the rollup too** — Pyth's price account is itself clone-readable there, so
//! the keeper refreshes the relay from within, against the same verified feed.
//! Verified on devnet: publish time advances on an ER-side sync.

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
