//! Base layer, trader: make your portfolio private.
//!
//! Creates the MagicBlock permission record for the trader's portfolio PDA —
//! on a TEE validator only the members listed here can read it. The trader
//! signs and chooses the list; the sensible minimum is themselves (all flags)
//! plus the venue's engine keys, which must read positions to run the
//! matching, settle, and liquidation cranks. Note what this means honestly:
//! the *public* cannot see your positions, the engine can — that is the
//! CEX-privacy trust model, bounded later by attestation.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermission, CreatePermissionInstructionArgs,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::constants::{MARKET_SEED, PORTFOLIO_SEED};
use crate::instructions::create_book_permission::PermissionMember;
use crate::state::Market;

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreatePortfolioPermission<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the permissioned account; seeds bind it to this trader, and
    /// this program signs for it by those seeds.
    #[account(seeds = [PORTFOLIO_SEED, &market_id.to_le_bytes(), trader.key().as_ref()], bump)]
    pub portfolio: AccountInfo<'info>,

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
    ctx: Context<CreatePortfolioPermission>,
    market_id: u64,
    members: Vec<PermissionMember>,
) -> Result<()> {
    let ix = CreatePermission {
        permissioned_account: ctx.accounts.portfolio.key(),
        permission: ctx.accounts.permission.key(),
        payer: ctx.accounts.trader.key(),
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
    let trader = ctx.accounts.trader.key();
    invoke_signed(
        &ix,
        &[
            ctx.accounts.portfolio.to_account_info(),
            ctx.accounts.permission.to_account_info(),
            ctx.accounts.trader.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[
            PORTFOLIO_SEED,
            &market_id_bytes,
            trader.as_ref(),
            &[ctx.bumps.portfolio],
        ]],
    )?;

    msg!(
        "anqa: portfolio permission created — {} member(s) may read it",
        members.len()
    );
    Ok(())
}
