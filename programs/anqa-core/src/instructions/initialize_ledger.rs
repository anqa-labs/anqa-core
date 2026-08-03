//! Base layer: create a trader's deposit ledger, empty.

use anchor_lang::prelude::*;

use crate::constants::{LEDGER_SEED, MARKET_SEED};
use crate::state::{Market, UserDepositLedger};

#[event]
pub struct LedgerInitialized {
    pub market_id: u64,
    pub owner: Pubkey,
}

#[derive(Accounts)]
pub struct InitializeLedger<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = trader,
        space = 8 + UserDepositLedger::INIT_SPACE,
        seeds = [LEDGER_SEED, &market.group_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    pub system_program: Program<'info, System>,
}

/// Create the deposit ledger with no balance.
///
/// Separate from `deposit` on purpose: the ledger is a permanent base-layer
/// record of everything a trader ever pays in or takes out, and it must exist
/// independently of whether a deposit happens to be in flight. It is also the
/// account the rollup reads, so it cannot be conjured mid-transaction from
/// inside one.
pub fn handler(ctx: Context<InitializeLedger>) -> Result<()> {
    let l = &mut ctx.accounts.ledger;
    l.owner = ctx.accounts.trader.key();
    l.market_id = ctx.accounts.market.group_id;
    l.deposited = 0;
    l.withdrawn = 0;
    l.reserved = 0;
    l.bump = ctx.bumps.ledger;

    emit!(LedgerInitialized {
        market_id: l.market_id,
        owner: l.owner,
    });
    msg!("anqa: deposit ledger opened, empty");
    Ok(())
}
