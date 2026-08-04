//! Publishing one trader's own resting orders.
//!
//! Four instructions, matching the lifecycle the depth mirror already has:
//! create on base, delegate into the rollup beside the book, mark private to
//! the owner, then rebuild from inside on every keeper tick.
//!
//! Rebuilding is **permissionless** in the same sense `publish_depth` is:
//! anyone may drive it, but the projection is fixed by the seeds. The account
//! is bound to one owner, and the handler copies only rows whose trader
//! matches that owner — so a caller cannot aim it at somebody else's orders,
//! and driving it for a trader reveals nothing to the driver, who still cannot
//! read what they wrote.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreateEphemeralPermissionCpi, CreatePermission, CreatePermissionInstructionArgs,
};
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member, MembersArgs};
use ephemeral_rollups_sdk::consts::{MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

use crate::constants::{delegate_config, BOOK_SEED, MARKET_SEED, TRADER_ORDERS_SEED};
use crate::state::{Book, Market, TraderOrders};

// ───────────────────────────── create (base) ─────────────────────────────

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeTraderOrders<'info> {
    /// Whoever pays the rent. **Not** necessarily the owner: the engine
    /// provisions these so a trader never has to sign for the privilege of
    /// seeing their own orders.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the trader these rows will belong to. A seed and a stored
    /// field, never an authority — creating someone's mirror grants the
    /// creator nothing, since the permission below names the owner and the
    /// venue engine and the caller has no say in either.
    pub owner: AccountInfo<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<TraderOrders>(),
        seeds = [TRADER_ORDERS_SEED, &market_id.to_le_bytes(), owner.key().as_ref()],
        bump
    )]
    pub orders: AccountLoader<'info, TraderOrders>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(ctx: Context<InitializeTraderOrders>, market_id: u64) -> Result<()> {
    ctx.accounts.orders.load_init()?.init(
        ctx.accounts.owner.key(),
        market_id,
        ctx.bumps.orders,
    );
    msg!("anqa: order mirror ready for market {}", market_id);
    Ok(())
}

// ───────────────────────── permission record (base) ─────────────────────────

/// Create the mirror's **base-layer** permission record.
///
/// Easy to miss and impossible to skip: the ephemeral permission created in
/// the rollup extends a record that must already exist on base. Without this
/// `set_trader_orders_private` fails at transaction verification — before any
/// program log is written, which is what makes the omission hard to read from
/// the error. Same ordering the portfolio and the book already follow:
/// create, permission, delegate, then hide.
///
/// Permissionless for the same reason as the rest: the member list is fixed
/// by the program to the owner and the venue engine, so the caller chooses
/// nothing and gains nothing.
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateTraderOrdersPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the owner these rows belong to; a seed, never an authority.
    pub owner: AccountInfo<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the permissioned account; seeds bind it to this owner.
    #[account(
        seeds = [TRADER_ORDERS_SEED, &market_id.to_le_bytes(), owner.key().as_ref()],
        bump
    )]
    pub orders: AccountInfo<'info>,

    /// CHECK: the permission record PDA, created by the permission program.
    #[account(mut)]
    pub permission: AccountInfo<'info>,

    /// CHECK: the MagicBlock permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_permission_handler(
    ctx: Context<CreateTraderOrdersPermission>,
    market_id: u64,
) -> Result<()> {
    let ix = CreatePermission {
        permissioned_account: ctx.accounts.orders.key(),
        permission: ctx.accounts.permission.key(),
        payer: ctx.accounts.payer.key(),
        system_program: ctx.accounts.system_program.key(),
    }
    .instruction(CreatePermissionInstructionArgs {
        args: MembersArgs {
            members: Some(vec![
                Member { flags: ALL_FLAGS, pubkey: ctx.accounts.owner.key() },
                Member { flags: ALL_FLAGS, pubkey: ctx.accounts.market.authority },
            ]),
        },
    });

    let owner_key = ctx.accounts.owner.key();
    let market_bytes = market_id.to_le_bytes();
    let bump = [ctx.bumps.orders];
    let seeds: &[&[u8]] = &[TRADER_ORDERS_SEED, &market_bytes, owner_key.as_ref(), &bump];

    invoke_signed(
        &ix,
        &[
            ctx.accounts.orders.to_account_info(),
            ctx.accounts.permission.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.permission_program.to_account_info(),
        ],
        &[seeds],
    )?;

    msg!("anqa: order mirror permission recorded on base");
    Ok(())
}

// ──────────────────────────────── delegate ────────────────────────────────

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateTraderOrders<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the owner this mirror belongs to; only used as a seed.
    pub owner: AccountInfo<'info>,

    /// CHECK: the trader's order mirror.
    #[account(
        mut,
        del,
        seeds = [TRADER_ORDERS_SEED, &market_id.to_le_bytes(), owner.key().as_ref()],
        bump
    )]
    pub orders: AccountInfo<'info>,
}

pub fn delegate_handler(ctx: Context<DelegateTraderOrders>, market_id: u64) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    ctx.accounts.delegate_orders(
        &ctx.accounts.payer,
        &[TRADER_ORDERS_SEED, &market_id.to_le_bytes(), owner.as_ref()],
        delegate_config(),
    )?;
    msg!("anqa: order mirror delegated for market {}", market_id);
    Ok(())
}

// ───────────────────────────────── private ─────────────────────────────────

#[derive(Accounts)]
pub struct SetTraderOrdersPrivate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the owner these rows belong to; a seed, never an authority.
    pub owner: AccountInfo<'info>,

    /// CHECK: seeds bind this to `owner`, so a caller can only ever hide the
    /// mirror that already belongs to the owner they named.
    #[account(
        mut,
        seeds = [TRADER_ORDERS_SEED, &market.market_id.to_le_bytes(), owner.key().as_ref()],
        bump
    )]
    pub orders: AccountInfo<'info>,

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

/// Hide the mirror from everyone but its owner.
///
/// Without this the mirror would undo the book: a stranger who cannot read the
/// book could read every trader's projection of it instead, owners and all,
/// and reassemble the thing the venue exists to hide.
///
/// **The member list is not the caller's to choose**, and that is what makes
/// this safe to leave permissionless. It is always exactly the owner and the
/// venue engine — the engine because it writes the rows, the owner because
/// they are whose rows they are. A caller supplying members could add
/// themselves and read a stranger's book position; a caller supplying nothing
/// can only give the owner what was already theirs. That is the whole reason
/// a trader never has to sign for this.
pub fn set_private_handler(ctx: Context<SetTraderOrdersPrivate>) -> Result<()> {
    let market_bytes = ctx.accounts.market.market_id.to_le_bytes();
    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.bumps.orders];
    let seeds: &[&[u8]] = &[TRADER_ORDERS_SEED, &market_bytes, owner_key.as_ref(), &bump];

    CreateEphemeralPermissionCpi {
        permissioned_account: ctx.accounts.orders.to_account_info(),
        permission: ctx.accounts.permission.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private: true,
            members: vec![
                Member { flags: ALL_FLAGS, pubkey: owner_key },
                // The engine, which is the only party that writes these rows.
                Member { flags: ALL_FLAGS, pubkey: ctx.accounts.market.authority },
            ],
        },
    }
    .invoke_signed(&[seeds])?;

    msg!("anqa: order mirror hidden — these rows are the owner's alone");
    Ok(())
}

/// Full read/write on a permission member.
const ALL_FLAGS: u8 = 31;

// ───────────────────────────────── publish ─────────────────────────────────

#[derive(Accounts)]
pub struct PublishTraderOrders<'info> {
    /// Permissionless: the projection is fixed by the account's own seeds,
    /// and the caller cannot read what they publish.
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    /// CHECK: the owner whose rows are being rebuilt; only used as a seed.
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TRADER_ORDERS_SEED, &market.market_id.to_le_bytes(), owner.key().as_ref()],
        bump = orders.load()?.bump,
        constraint = orders.load()?.owner == owner.key()
    )]
    pub orders: AccountLoader<'info, TraderOrders>,
}

pub fn publish_handler(ctx: Context<PublishTraderOrders>) -> Result<()> {
    let book = ctx.accounts.book.load()?;
    // The venue's own clock rather than `Clock::get()`: a delegated venue
    // changes hosts, and this stamp exists so a client can tell a stale
    // mirror from an empty one. See `venue_clock.rs`.
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts
        .orders
        .load_mut()?
        .rebuild(&book.bids, &book.asks, now);
    Ok(())
}
