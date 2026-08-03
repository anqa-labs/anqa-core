//! Grant (or renew) and revoke a trade session.
//!
//! Both are owner-signed base-layer instructions: the grant is the one wallet
//! prompt a trading session costs, and revocation must not depend on the
//! session key's cooperation. See `state::session` for what a grant scopes.

use anchor_lang::prelude::*;

use crate::constants::SESSION_SEED;
use crate::errors::AnqaError;
use crate::state::TradeSession;

/// Longest a single grant may live. Re-grant to continue; an ephemeral key
/// that quietly works forever is a custody bug, not a convenience.
pub const MAX_SESSION_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(Accounts)]
pub struct GrantSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Platform-wide: one grant per owner, honoured by every market.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + TradeSession::INIT_SPACE,
        seeds = [SESSION_SEED, owner.key().as_ref()],
        bump
    )]
    pub session: Account<'info, TradeSession>,

    pub system_program: Program<'info, System>,
}

pub fn grant(ctx: Context<GrantSession>, session_key: Pubkey, duration_secs: i64) -> Result<()> {
    require!(
        duration_secs > 0 && duration_secs <= MAX_SESSION_SECS,
        AnqaError::InvalidPrice // reuse: bad argument
    );
    require!(session_key != Pubkey::default(), AnqaError::InvalidPrice);

    let s = &mut ctx.accounts.session;
    s.owner = ctx.accounts.owner.key();
    s.market_id = 0; // unused: the grant is platform-wide
    s.session_key = session_key;
    s.expires_at = Clock::get()?
        .unix_timestamp
        .checked_add(duration_secs)
        .ok_or(AnqaError::MathOverflow)?;
    s.bump = ctx.bumps.session;

    msg!(
        "anqa: session granted to {} until {}",
        session_key,
        s.expires_at
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [SESSION_SEED, owner.key().as_ref()],
        bump = session.bump,
        constraint = session.owner == owner.key() @ AnqaError::NotOrderOwner
    )]
    pub session: Account<'info, TradeSession>,
}

pub fn revoke(ctx: Context<RevokeSession>) -> Result<()> {
    msg!("anqa: session revoked for {}", ctx.accounts.owner.key());
    Ok(())
}
