//! Make the book unreadable — the instruction the whole product rests on.
//!
//! Everything else about a "dark" book is decoration until this runs. What
//! actually hides an account is an **`EphemeralPermission` with `private:
//! true`**, created inside the rollup, which MagicBlock's Query Filtering
//! Service reads at RPC ingress: a caller who is not a member gets `null`
//! back, and the account is dropped from `getProgramAccounts` results.
//!
//! Three things had to be true together, and were not:
//!
//! 1. **The account is delegated to the TEE validator.** Filtering only
//!    exists in front of that one; the shared regional validators serve
//!    every delegated account to anyone who asks. See `delegation_validator`.
//! 2. **The permission is the *ephemeral* kind.** The base-layer
//!    `create_permission` has no `private` flag at all, so an account
//!    carrying one is still world-readable. That is what anqa had.
//! 3. **The state stays in the rollup.** A commit writes plaintext to base
//!    layer, where nothing filters it — which is why the book is never
//!    committed and `commit_frequency_ms` is `u32::MAX`.
//!
//! ## What this does not do
//!
//! It is a **read filter, not an execution guard**. Programs running inside
//! the rollup still read and write the account normally, so every
//! authorization rule anqa cares about — who may cancel an order, who may
//! close a position — stays in the program where it already lives.
//!
//! The permission record itself is public: anyone can see that this book is
//! private and who may read it. The contents are what stay hidden.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member};
use ephemeral_rollups_sdk::consts::{MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

use crate::constants::{BOOK_SEED, MARKET_SEED, PORTFOLIO_SEED};
use crate::state::Market;

/// A reader of a private account, and what they may see.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PermissionMemberArg {
    pub pubkey: Pubkey,
    /// Bitmask over the SDK's observability flags (authority, logs,
    /// balances, message, signatures).
    pub flags: u8,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct SetBookPrivate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the market's admin, checked by `has_one`.
    pub authority: UncheckedAccount<'info>,

    /// CHECK: the account being hidden. The permission program requires it to
    /// sign, which this program does by seeds.
    #[account(mut, seeds = [BOOK_SEED, &market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,

    /// CHECK: the permission record, created by the permission program.
    #[account(mut)]
    pub permission: AccountInfo<'info>,

    /// CHECK: the validator's fee vault, which funds the record's rent.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// CHECK: MagicBlock's program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,

    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,
}

pub fn book_handler(
    ctx: Context<SetBookPrivate>,
    market_id: u64,
    members: Vec<PermissionMemberArg>,
) -> Result<()> {
    let bump = [ctx.bumps.book];
    let market_id_bytes = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[BOOK_SEED, &market_id_bytes, &bump];

    CreateEphemeralPermissionCpi {
        permissioned_account: ctx.accounts.book.to_account_info(),
        permission: ctx.accounts.permission.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private: true,
            members: members
                .iter()
                .map(|m| Member {
                    flags: m.flags,
                    pubkey: m.pubkey,
                })
                .collect(),
        },
    }
    .invoke_signed(&[seeds])?;

    msg!("anqa: book {} is now unreadable from outside", market_id);
    Ok(())
}

#[derive(Accounts)]
pub struct SetPortfolioPrivate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: the trader's account. Seeds bind it to this owner, so nobody
    /// can hide — or expose — somebody else's position.
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.group_id.to_le_bytes(), owner.key().as_ref()],
        bump
    )]
    pub portfolio: AccountInfo<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the permission record, created by the permission program.
    #[account(mut)]
    pub permission: AccountInfo<'info>,

    /// CHECK: the validator's fee vault.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// CHECK: MagicBlock's program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,

    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,
}

/// Hide a trader's own account: position, entry, collateral, and therefore
/// the price at which they would be liquidated.
///
/// This is the privacy that costs nobody anything — no taker needs to read a
/// stranger's position to size their own trade — and the one every other perp
/// venue gives away, which is why liquidation hunting is a sport.
pub fn portfolio_handler(
    ctx: Context<SetPortfolioPrivate>,
    members: Vec<PermissionMemberArg>,
) -> Result<()> {
    let group_bytes = ctx.accounts.market.group_id.to_le_bytes();
    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.bumps.portfolio];
    let seeds: &[&[u8]] = &[PORTFOLIO_SEED, &group_bytes, owner_key.as_ref(), &bump];

    CreateEphemeralPermissionCpi {
        permissioned_account: ctx.accounts.portfolio.to_account_info(),
        permission: ctx.accounts.permission.to_account_info(),
        payer: ctx.accounts.owner.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private: true,
            members: members
                .iter()
                .map(|m| Member {
                    flags: m.flags,
                    pubkey: m.pubkey,
                })
                .collect(),
        },
    }
    .invoke_signed(&[seeds])?;

    msg!("anqa: portfolio hidden — position and liquidation price are the owner's alone");
    Ok(())
}
