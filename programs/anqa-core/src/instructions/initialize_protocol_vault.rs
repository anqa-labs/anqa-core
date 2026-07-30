//! Create the protocol vault — venue revenue, held apart from both trader
//! collateral and insurance so an accounting bug in one cannot drain another.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{MARKET_SEED, PROTOCOL_VAULT_SEED, PROTOCOL_VAULT_TOKENS_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, ProtocolVault};

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeProtocolVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ AnqaError::Unauthorized
    )]
    pub market: Account<'info, Market>,

    pub collateral_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolVault::INIT_SPACE,
        seeds = [PROTOCOL_VAULT_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub protocol_vault: Account<'info, ProtocolVault>,

    /// Its own authority, like the other two vaults.
    #[account(
        init,
        payer = authority,
        seeds = [PROTOCOL_VAULT_TOKENS_SEED, &market_id.to_le_bytes()],
        bump,
        token::mint = collateral_mint,
        token::authority = protocol_vault_tokens,
    )]
    pub protocol_vault_tokens: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeProtocolVault>,
    market_id: u64,
    insurance_target_bps: u16,
    post_target_insurance_bps: u16,
) -> Result<()> {
    require!(
        insurance_target_bps <= 10_000 && post_target_insurance_bps <= 10_000,
        AnqaError::InvalidSize
    );

    let pv = &mut ctx.accounts.protocol_vault;
    pv.market_id = market_id;
    pv.authority = ctx.accounts.authority.key();
    pv.token_account = ctx.accounts.protocol_vault_tokens.key();
    pv.insurance_target_bps = insurance_target_bps;
    pv.post_target_insurance_bps = post_target_insurance_bps;
    pv.bump = ctx.bumps.protocol_vault;
    pv.token_account_bump = ctx.bumps.protocol_vault_tokens;

    msg!(
        "anqa: protocol vault ready — insurance target {}bps of OI, then {}bps of revenue keeps flowing to it",
        insurance_target_bps,
        post_target_insurance_bps
    );
    Ok(())
}
