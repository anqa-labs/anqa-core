//! Create the insurance vault — layer two of the loss waterfall.
//!
//! ## Why a separate token account
//!
//! The kernel counts insurance inside `header.vault` — it is one accounting
//! total. We still keep the tokens in their own account, for two reasons:
//!
//! - **Verifiability.** "The fund holds $X" should be answerable with one RPC
//!   call against a real account, not by trusting our arithmetic.
//! - **Blast radius.** The withdraw path signs for the custody vault. If
//!   insurance lived in that same token account, a bug there could pay out
//!   insurance as trader collateral. Separate accounts make that impossible
//!   regardless of accounting bugs.
//!
//! The invariant to check on-chain is therefore:
//! `custody_vault.amount + insurance_vault.amount == header.vault`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{INSURANCE_VAULT_SEED, MARKET_SEED};
use crate::errors::AnqaError;
use crate::state::Market;

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeInsuranceVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ AnqaError::Unauthorized
    )]
    pub market: Account<'info, Market>,

    pub collateral_mint: Account<'info, Mint>,

    /// Its own authority, like the custody vault — no key can move it.
    #[account(
        init,
        payer = authority,
        seeds = [INSURANCE_VAULT_SEED, &market_id.to_le_bytes()],
        bump,
        token::mint = collateral_mint,
        token::authority = insurance_vault,
    )]
    pub insurance_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeInsuranceVault>, market_id: u64) -> Result<()> {
    msg!(
        "anqa: insurance vault ready for market {} ({})",
        market_id,
        ctx.accounts.insurance_vault.key()
    );
    Ok(())
}
