//! Create the protocol's collateral vault.
//!
//! Every trader's collateral sits here. The vault is a base-layer token account
//! and is **never delegated to the rollup** — collateral stays outside the
//! enclave's trust boundary even once the book is private. The honest version of
//! the pitch: matching moves into the TEE, custody does not.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{MARKET_SEED, VAULT_SEED};
use crate::state::Market;

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    pub collateral_mint: Account<'info, Mint>,

    /// Its own authority — no human key can move collateral out of band.
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, &market_id.to_le_bytes()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeVault>, market_id: u64) -> Result<()> {
    msg!(
        "anqa: collateral vault ready for market {} ({})",
        market_id,
        ctx.accounts.vault.key()
    );
    Ok(())
}
