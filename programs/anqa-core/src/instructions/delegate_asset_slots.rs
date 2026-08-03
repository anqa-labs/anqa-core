//! Delegate the asset slots (the slabs) into the ephemeral rollup.
//!
//! Per-asset open interest and engine state, written on every fill. See
//! `delegate_book.rs` for the full delegated set.
//!
//! ## Why this one is hand-rolled
//!
//! The SDK's one-shot delegate creates the snapshot buffer via CPI, and inner
//! instructions cannot allocate more than 10,240 bytes — at `MAX_ASSETS`
//! slots the slabs outgrew that. So the buffer PDA (same seeds the SDK uses:
//! `["buffer", asset_slots]`) is created and grown across transactions by
//! `prepare_asset_slots_buffer`, and the delegate step here does everything
//! the SDK would have done *after* creation: copy state into the buffer, zero
//! the PDA, hand it to the delegation program, and close the buffer back to
//! the payer.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::entrypoint::MAX_PERMITTED_DATA_INCREASE;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_lang::system_program::{create_account, transfer, CreateAccount, Transfer};
use ephemeral_rollups_sdk::cpi::cpi_delegate;
use ephemeral_rollups_sdk::types::DelegateAccountArgs;
use ephemeral_rollups_sdk::utils::{close_pda_with_system_transfer, seeds_with_bump};

use crate::constants::ASSET_SLOTS_SEED;
use crate::errors::AnqaError;

/// The delegation program's buffer-PDA tag (dlp `DELEGATE_BUFFER_TAG`).
const BUFFER_TAG: &[u8] = b"buffer";

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct PrepareAssetSlotsBuffer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: only its size and address matter — the buffer mirrors it.
    #[account(seeds = [ASSET_SLOTS_SEED, &market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountInfo<'info>,

    /// CHECK: the delegation snapshot buffer, created here across
    /// transactions and consumed by `delegate_asset_slots`.
    #[account(mut, seeds = [BUFFER_TAG, asset_slots.key().as_ref()], bump)]
    pub buffer_asset_slots: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Create or grow the delegation buffer toward the slabs' full size, one
/// 10KB step per transaction. No-op once fully sized.
pub fn prepare_handler(ctx: Context<PrepareAssetSlotsBuffer>, _market_id: u64) -> Result<()> {
    let target = ctx.accounts.asset_slots.data_len();
    let info = ctx.accounts.buffer_asset_slots.to_account_info();
    let rent = Rent::get()?;
    let pda_key = ctx.accounts.asset_slots.key();

    if info.owner == &System::id() {
        let space = target.min(MAX_PERMITTED_DATA_INCREASE);
        let bump = [ctx.bumps.buffer_asset_slots];
        let seeds: &[&[u8]] = &[BUFFER_TAG, pda_key.as_ref(), &bump];
        create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
                &[seeds],
            ),
            rent.minimum_balance(space),
            space as u64,
            &crate::ID,
        )?;
        msg!("anqa: slab buffer created at {} of {} bytes", space, target);
        return Ok(());
    }

    let current = info.data_len();
    if current >= target {
        msg!("anqa: slab buffer already at full size ({} bytes)", current);
        return Ok(());
    }

    let new_len = target.min(current + MAX_PERMITTED_DATA_INCREASE);
    let owed = rent.minimum_balance(new_len).saturating_sub(info.lamports());
    if owed > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            owed,
        )?;
    }
    info.resize(new_len)?;
    msg!("anqa: slab buffer grown to {} of {} bytes", new_len, target);
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateAssetSlots<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the slabs — per-asset open interest and engine state.
    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountInfo<'info>,

    /// CHECK: pre-sized by `prepare_asset_slots_buffer`; closed back to the
    /// payer once the delegation program has consumed the snapshot.
    #[account(mut, seeds = [BUFFER_TAG, asset_slots.key().as_ref()], bump)]
    pub buffer_asset_slots: AccountInfo<'info>,

    /// CHECK: validated by the delegation program.
    #[account(mut)]
    pub delegation_record_asset_slots: AccountInfo<'info>,

    /// CHECK: validated by the delegation program.
    #[account(mut)]
    pub delegation_metadata_asset_slots: AccountInfo<'info>,

    /// CHECK: this program, as the delegated account's owner.
    pub owner_program: AccountInfo<'info>,

    /// CHECK: the delegation program.
    pub delegation_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DelegateAssetSlots>, market_id: u64) -> Result<()> {
    let pda = ctx.accounts.asset_slots.to_account_info();
    let buffer = ctx.accounts.buffer_asset_slots.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    let data_len = pda.data_len();

    require_keys_eq!(*buffer.owner, crate::ID, AnqaError::AssetSlotsNotPrepared);
    require!(buffer.data_len() == data_len, AnqaError::AssetSlotsNotPrepared);

    // Snapshot the slabs into the buffer, then zero the original — the
    // delegation program restores the snapshot into the account it now owns.
    {
        let src = pda.try_borrow_data()?;
        let mut dst = buffer.try_borrow_mut_data()?;
        dst.copy_from_slice(&src);
    }
    pda.try_borrow_mut_data()?.fill(0);

    let market_id_bytes = market_id.to_le_bytes();
    let pda_seeds: &[&[u8]] = &[ASSET_SLOTS_SEED, &market_id_bytes];
    let pda_bump = [ctx.bumps.asset_slots];
    let pda_seeds_bumped = seeds_with_bump(pda_seeds, &pda_bump);
    let pda_signer: &[&[&[u8]]] = &[&pda_seeds_bumped];

    // Hand the zeroed PDA to the delegation program (via system, since only
    // a system-owned account can be assigned by its own signature).
    pda.assign(&System::id());
    invoke_signed(
        &system_instruction::assign(&pda.key(), &ctx.accounts.delegation_program.key()),
        &[pda.clone(), system.clone()],
        pda_signer,
    )?;

    let cfg = crate::constants::delegate_config();
    cpi_delegate(
        &ctx.accounts.payer.to_account_info(),
        &pda,
        &ctx.accounts.owner_program,
        &buffer,
        &ctx.accounts.delegation_record_asset_slots,
        &ctx.accounts.delegation_metadata_asset_slots,
        &system,
        pda_signer,
        DelegateAccountArgs {
            commit_frequency_ms: cfg.commit_frequency_ms,
            seeds: vec![ASSET_SLOTS_SEED.to_vec(), market_id_bytes.to_vec()],
            validator: cfg.validator,
        },
    )?;

    // The snapshot has been consumed; the buffer's rent goes home.
    let pda_key = pda.key();
    let buffer_seeds: &[&[u8]] = &[BUFFER_TAG, pda_key.as_ref()];
    let buffer_bump = [ctx.bumps.buffer_asset_slots];
    let buffer_seeds_bumped = seeds_with_bump(buffer_seeds, &buffer_bump);
    let buffer_signer: &[&[&[u8]]] = &[&buffer_seeds_bumped];
    close_pda_with_system_transfer(
        &buffer,
        buffer_signer,
        &ctx.accounts.payer.to_account_info(),
        &system,
    )?;

    msg!("anqa: slabs delegated for market {}", market_id);
    Ok(())
}
