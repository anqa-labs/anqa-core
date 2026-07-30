//! Open a margin account.
//!
//! This is the perps counterpart to a spot venue's token accounts. A trader's
//! portfolio holds collateral, positions and PnL; the kernel walks exactly one
//! portfolio per operation, never a global table, which is what keeps margin
//! checks and liquidation cranks compute-bounded.

use anchor_lang::prelude::*;
use percolator::{ProvenanceHeaderV16, ProvenanceHeaderV16Account};

use crate::constants::{MARKET_SEED, PORTFOLIO_SEED};
use crate::errors::map_risk;
use crate::state::{Market, Portfolio};

#[derive(Accounts)]
pub struct OpenPortfolio<'info> {
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
        space = 8 + std::mem::size_of::<Portfolio>(),
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenPortfolio>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let trader = ctx.accounts.trader.key();

    let mut portfolio = ctx.accounts.portfolio.load_init()?;
    portfolio.owner = trader;
    portfolio.market_id = market_id.to_le_bytes();
    portfolio.bump = ctx.bumps.portfolio;

    // The kernel stamps its own provenance so an account can never be replayed
    // against a different market group or owner.
    let mut group_id = [0u8; 32];
    group_id[..8].copy_from_slice(&market_id.to_le_bytes());
    let mut account_seed = [0u8; 32];
    account_seed.copy_from_slice(trader.as_ref());

    let provenance = ProvenanceHeaderV16Account::from_runtime(&ProvenanceHeaderV16::new(
        group_id,
        account_seed,
        trader.to_bytes(),
    ));

    // Note: no `portfolio.inner = PortfolioAccountV16Account::default()`.
    // That materialises a 9KB value on the BPF stack (9,600-byte frame against
    // a 4,096-byte limit) before copying it into the account. `load_init()`
    // already hands us zeroed data and the type is `Zeroable`, so we initialise
    // in place instead.
    map_risk(portfolio.account_mut().init_empty_in_place(provenance))?;

    msg!("anqa: portfolio opened on market {}", market_id);
    Ok(())
}
