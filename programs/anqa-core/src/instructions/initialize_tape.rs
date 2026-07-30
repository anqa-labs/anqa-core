//! Base layer: create the public fill tape for a market.
//!
//! Separate from `initialize_market` because it only matters once a market
//! goes dark — and because it is delegated to the rollup *unpermissioned*,
//! the one account in the private set the whole world may read.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, TAPE_SEED};
use crate::errors::AnqaError;
use crate::state::{FillTape, Market};

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeTape<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ AnqaError::Unauthorized
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<FillTape>(),
        seeds = [TAPE_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub tape: AccountLoader<'info, FillTape>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeTape>, market_id: u64) -> Result<()> {
    let mut tape = ctx.accounts.tape.load_init()?;
    tape.init(market_id, ctx.bumps.tape);
    msg!("anqa: fill tape ready for market {}", market_id);
    Ok(())
}
