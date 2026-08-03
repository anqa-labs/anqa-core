//! Rollup: commit the risk engine and return it to base chain entirely.
//!
//! Two callers need this:
//! - `fund_insurance` runs on base (it moves real tokens) and must write the
//!   kernel's per-domain insurance accounting — impossible while the engine
//!   is delegated. Undelegate, fund, re-delegate.
//! - The escape hatch. Book and portfolio already had one; the venue is only
//!   non-custodial if the risk engine can come home without the rollup's
//!   goodwill too.
//!
//! ## Why two instructions, one account each
//!
//! The devnet validator rejects a commit-and-undelegate bundle carrying two
//! accounts ("Unknown action") while accepting the same bundle with one, so
//! the group and the slabs leave in separate transactions. That split is
//! safe: every kernel write path takes *both* accounts, so the moment the
//! group has left the rollup no instruction can mutate the slabs there —
//! the two snapshots cannot diverge. Undelegate the group first.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::state::{AssetSlots, RiskGroup};

#[commit]
#[derive(Accounts)]
pub struct UndelegateRiskGroup<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub risk_group: AccountLoader<'info, RiskGroup>,
}

/// Checkpoint the risk group to base without leaving the rollup. The keeper
/// runs this on a slow tick: with explicit-only commits, base knows nothing
/// newer than the last one, and an unplanned undelegation strands everything
/// since — bound that loss to one tick.
pub fn commit_group_handler(ctx: Context<UndelegateRiskGroup>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.risk_group.to_account_info()])
    .build_and_invoke()?;
    msg!("anqa: risk group committed");
    Ok(())
}

/// Checkpoint the slabs; the other half of the keeper's risk-engine tick.
pub fn commit_slots_handler(ctx: Context<UndelegateAssetSlots>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.asset_slots.to_account_info()])
    .build_and_invoke()?;
    msg!("anqa: slabs committed");
    Ok(())
}

pub fn group_handler(ctx: Context<UndelegateRiskGroup>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.risk_group.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: risk group committed and undelegated");
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateAssetSlots<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,
}

pub fn slots_handler(ctx: Context<UndelegateAssetSlots>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.asset_slots.to_account_info()])
    .build_and_invoke()?;

    msg!("anqa: slabs committed and undelegated");
    Ok(())
}
