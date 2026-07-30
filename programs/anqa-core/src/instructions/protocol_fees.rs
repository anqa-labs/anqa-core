//! Create the protocol vault and collect from it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{MARKET_SEED, PROTOCOL_VAULT_SEED, PROTOCOL_VAULT_TOKENS_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, ProtocolVault};

#[event]
pub struct FeesCollected {
    pub market_id: u64,
    pub amount: u64,
}

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

pub fn initialize(
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

#[derive(Accounts)]
pub struct CollectFees<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [PROTOCOL_VAULT_SEED, &market.market_id.to_le_bytes()],
        bump = protocol_vault.bump,
        has_one = authority @ AnqaError::Unauthorized
    )]
    pub protocol_vault: Account<'info, ProtocolVault>,

    #[account(
        mut,
        seeds = [PROTOCOL_VAULT_TOKENS_SEED, &market.market_id.to_le_bytes()],
        bump = protocol_vault.token_account_bump
    )]
    pub protocol_vault_tokens: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub destination: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Collect accrued revenue.
///
/// Only ever touches the protocol's own token account — there is no path from
/// here to trader collateral or to insurance, which is the point of keeping
/// three separate accounts.
pub fn collect(ctx: Context<CollectFees>, amount: u64) -> Result<()> {
    require!(amount > 0, AnqaError::InvalidSize);
    ctx.accounts.protocol_vault.collect(amount)?;

    let market_id_bytes = ctx.accounts.market.market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        PROTOCOL_VAULT_TOKENS_SEED,
        &market_id_bytes,
        &[ctx.accounts.protocol_vault.token_account_bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.protocol_vault_tokens.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.protocol_vault_tokens.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    emit!(FeesCollected {
        market_id: ctx.accounts.market.market_id,
        amount,
    });
    msg!("anqa: collected {} in protocol fees", amount);
    Ok(())
}
