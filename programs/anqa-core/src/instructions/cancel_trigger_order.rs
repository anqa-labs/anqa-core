//! Disarm a trigger order. Runs wherever the portfolio lives.

use anchor_lang::prelude::*;

use crate::constants::MARKET_SEED;
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

    /// Present when a session key signs for the owner; judged in the handler.
    pub session: Option<Account<'info, crate::state::TradeSession>>,

    #[account(
        mut,
        constraint = portfolio.load()?.market_id == market.group_id.to_le_bytes() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<CancelTriggerOrder>, trigger_id: u64) -> Result<()> {
    require!(
        crate::state::trade_authorized(
            ctx.accounts.portfolio.load()?.owner,
            ctx.accounts.market.market_id,
            ctx.accounts.trader.key(),
            ctx.accounts.session.as_ref(),
        )?,
        AnqaError::NotOrderOwner
    );
    let mut pf = ctx.accounts.portfolio.load_mut()?;
    let slot = pf
        .find_trigger(trigger_id)
        .ok_or(AnqaError::OrderNotFound)?;
    pf.disarm_trigger(slot);

    msg!("anqa: trigger {} cancelled", trigger_id);
    Ok(())
}
