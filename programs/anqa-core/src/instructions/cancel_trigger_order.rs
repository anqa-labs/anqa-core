//! Disarm a trigger order. Runs wherever the portfolio lives.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, PORTFOLIO_SEED};
use crate::errors::AnqaError;
use crate::state::{Market, Portfolio};

#[derive(Accounts)]
pub struct CancelTriggerOrder<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<CancelTriggerOrder>, trigger_id: u64) -> Result<()> {
    let mut pf = ctx.accounts.portfolio.load_mut()?;
    let slot = pf
        .find_trigger(trigger_id)
        .ok_or(AnqaError::OrderNotFound)?;
    pf.disarm_trigger(slot);

    msg!("anqa: trigger {} cancelled", trigger_id);
    Ok(())
}
