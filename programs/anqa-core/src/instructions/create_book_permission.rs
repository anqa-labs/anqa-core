//! Base layer, admin: make the book private.
//!
//! Creates the MagicBlock permission record for the book PDA. On a TEE
//! validator, a delegated account with a permission record is served only to
//! its members — this is the on-chain half of "nobody can see the book". The
//! members here are the venue's engine keys (the matching/settle crank must
//! read the book); everyone else, including every trader, sees nothing.
//!
//! The permission program requires the permissioned account itself to sign
//! its record's creation — for a PDA that means this program signs with the
//! book's seeds, which is exactly the authorization story wanted: only the
//! program that owns the book can decide who may read it.
//!
//! Deliberately **not** permissioned anywhere: the market config, the oracle
//! accounts, the risk group and asset slots (aggregate OI is published
//! aggregate-only by design), and the fill tape — the tape is the product's
//! public face.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermission, CreatePermissionInstructionArgs,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::constants::{BOOK_SEED, MARKET_SEED};
use crate::errors::AnqaError;
use crate::state::Market;

/// A permission-list entry, IDL-friendly. `flags` bits: 1 authority, 2 tx
/// logs, 4 tx balances, 8 tx messages, 16 account signatures. Read access to
/// the account itself comes with membership.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PermissionMember {
    pub pubkey: Pubkey,
    pub flags: u8,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateBookPermission<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ AnqaError::Unauthorized
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the permissioned account; this program signs for it by seeds.
    #[account(seeds = [BOOK_SEED, &market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,

    /// CHECK: the permission record PDA, derived and created by the
    /// permission program.
    #[account(mut)]
    pub permission: AccountInfo<'info>,

    /// CHECK: the MagicBlock permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateBookPermission>,
    market_id: u64,
    members: Vec<PermissionMember>,
) -> Result<()> {
    let ix = CreatePermission {
        permissioned_account: ctx.accounts.book.key(),
        permission: ctx.accounts.permission.key(),
        payer: ctx.accounts.authority.key(),
        system_program: ctx.accounts.system_program.key(),
    }
    .instruction(CreatePermissionInstructionArgs {
        args: MembersArgs {
            members: Some(
                members
                    .iter()
                    .map(|m| Member {
                        flags: m.flags,
                        pubkey: m.pubkey,
                    })
                    .collect(),
            ),
        },
    });

    let market_id_bytes = market_id.to_le_bytes();
    invoke_signed(
        &ix,
        &[
            ctx.accounts.book.to_account_info(),
            ctx.accounts.permission.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[BOOK_SEED, &market_id_bytes, &[ctx.bumps.book]]],
    )?;

    msg!(
        "anqa: book permission created — {} member(s); the book is dark to everyone else",
        members.len()
    );
    Ok(())
}
