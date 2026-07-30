//! Delegate the asset slots (the slabs) into the ephemeral rollup.
//!
//! Per-asset open interest and engine state, written on every fill. See
//! `delegate_book.rs` for the full delegated set.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::ASSET_SLOTS_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateAssetSlots<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the slabs — per-asset open interest and engine state.
    #[account(mut, del, seeds = [ASSET_SLOTS_SEED, &market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateAssetSlots>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_asset_slots(
        &ctx.accounts.payer,
        &[ASSET_SLOTS_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: slabs delegated for market {}", market_id);
    Ok(())
}
