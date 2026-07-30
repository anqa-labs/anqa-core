//! Move a trader's portfolio into the rollup.
//!
//! The portfolio is **one account per trader** holding the Percolator kernel
//! state: the balance available to trade and every position across every asset
//! in the market group. One account, so delegation is one operation.
//!
//! ## Lifecycle
//!
//! ```text
//!   open_portfolio        create the portfolio, empty           (base layer)
//!   initialize_ledger     create the deposit record, empty      (base layer)
//!   deposit               tokens -> vault, ledger records it    (base layer)
//!   delegate_portfolio    portfolio moves into the rollup
//!   claim_deposit         portfolio credited from the ledger    (rollup)
//!   ... trade ...                                               (rollup)
//!   undelegate_portfolio  portfolio returns, state committed    (base layer)
//! ```
//!
//! Delegation is session-based on purpose. A trader decides when their state is
//! inside a rollup and when it comes home; nobody is parked there by default.
//! It also keeps the forced-exit story simple — there is always a committed
//! state on base layer to settle against.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::{delegate_config, PORTFOLIO_SEED};

#[event]
pub struct PortfolioDelegated {
    pub market_id: u64,
    pub owner: Pubkey,
}

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegatePortfolio<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    /// CHECK: ownership transfers to the delegation program; seeds bind it to
    /// this trader and market, so nobody can delegate somebody else's portfolio.
    #[account(
        mut,
        del,
        seeds = [PORTFOLIO_SEED, &market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub portfolio: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegatePortfolio>, market_id: u64) -> Result<()> {
    let trader = ctx.accounts.trader.key();
    let market_id_bytes = market_id.to_le_bytes();
    let portfolio_seeds: &[&[u8]] = &[PORTFOLIO_SEED, &market_id_bytes, trader.as_ref()];

    ctx.accounts.delegate_portfolio(
        &ctx.accounts.trader,
        portfolio_seeds,
        delegate_config(),
    )?;

    emit!(PortfolioDelegated {
        market_id,
        owner: trader,
    });
    msg!("anqa: portfolio delegated to the rollup");
    Ok(())
}
