//! Size the asset-slots account, one 10KB step per transaction.
//!
//! `AssetSlots` holds one kernel market per listed asset (~1.3KB each), and at
//! `MAX_ASSETS` slots it outgrew Solana's 10,240-byte limit on CPI-created
//! accounts — so `initialize_risk` can no longer `init` it in one shot. This
//! instruction creates the PDA at the cap and then grows it by up to 10,240
//! bytes per call (the per-transaction realloc limit) until it reaches its
//! full size; `initialize_risk` adopts the pre-sized, still-zeroed account.
//!
//! Idempotent: a call at full size is a no-op, so the client just loops until
//! the account stops growing.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::entrypoint::MAX_PERMITTED_DATA_INCREASE;
use anchor_lang::system_program::{create_account, transfer, CreateAccount, Transfer};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED};
use crate::state::{AssetSlots, Market};

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct PrepareAssetSlots<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    /// CHECK: created and grown here while still zeroed; validated by seeds,
    /// then adopted by `initialize_risk` under its `zero` constraint.
    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market_id.to_le_bytes()], bump)]
    pub asset_slots: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PrepareAssetSlots>, market_id: u64) -> Result<()> {
    let target = 8 + core::mem::size_of::<AssetSlots>();
    let info = ctx.accounts.asset_slots.to_account_info();
    let rent = Rent::get()?;

    if info.owner == &System::id() {
        // First step: create the PDA at the CPI allocation cap (or the full
        // size, when it fits).
        let space = target.min(MAX_PERMITTED_DATA_INCREASE);
        let bump = [ctx.bumps.asset_slots];
        let seeds: &[&[u8]] = &[ASSET_SLOTS_SEED, &market_id.to_le_bytes(), &bump];
        create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: info.clone(),
                },
                &[seeds],
            ),
            rent.minimum_balance(space),
            space as u64,
            &crate::ID,
        )?;
        msg!("anqa: asset slots created at {} of {} bytes", space, target);
        return Ok(());
    }

    let current = info.data_len();
    if current >= target {
        msg!("anqa: asset slots already at full size ({} bytes)", current);
        return Ok(());
    }

    // Growth step: top up rent for the new size, then realloc. New bytes are
    // zero-initialized so the account stays adoptable by `zero`.
    let new_len = target.min(current + MAX_PERMITTED_DATA_INCREASE);
    let owed = rent.minimum_balance(new_len).saturating_sub(info.lamports());
    if owed > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: info.clone(),
                },
            ),
            owed,
        )?;
    }
    info.resize(new_len)?;
    msg!("anqa: asset slots grown to {} of {} bytes", new_len, target);
    Ok(())
}
