//! Open a margin account — one per trader **per market**.
//!
//! This is what makes the venue isolated-margin: each market's portfolio has
//! its own capital, its own PnL and its own health cert, and the kernel walks
//! exactly one portfolio per operation. A position can only ever lose the
//! collateral deposited into its own portfolio — the trader's other markets
//! (and wallet) are structurally out of reach, not merely policy-protected.
//!
//! The kernel still keys every portfolio to the **group** (its provenance and
//! risk accounting are hub-wide); only ownership of collateral is per-market.

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
        seeds = [PORTFOLIO_SEED, &market.group_id.to_le_bytes(), trader.key().as_ref()],
        bump
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenPortfolio>) -> Result<()> {
    // Isolated margin: one portfolio per (trader, MARKET). The wrapper tag
    // carries the market id — every trading instruction compares it against
    // its market, so a BTC portfolio physically cannot margin a SOL order.
    // The kernel provenance stays group-keyed (risk accounting is hub-wide),
    // with the market mixed into the account seed so no two of a trader's
    // portfolios are kernel-interchangeable either.
    let group = ctx.accounts.market.group_id;
    let market_id = ctx.accounts.market.market_id;
    let trader = ctx.accounts.trader.key();

    let mut portfolio = ctx.accounts.portfolio.load_init()?;
    portfolio.owner = trader;
    portfolio.market_id = market_id.to_le_bytes();
    portfolio.bump = ctx.bumps.portfolio;

    // The kernel stamps its own provenance so an account can never be replayed
    // against a different market group or owner.
    let mut group_id = [0u8; 32];
    group_id[..8].copy_from_slice(&group.to_le_bytes());
    let mut account_seed = [0u8; 32];
    account_seed.copy_from_slice(trader.as_ref());
    // Namespace the seed by market: same owner, distinct kernel identity per
    // market portfolio.
    for (i, b) in market_id.to_le_bytes().iter().enumerate() {
        account_seed[24 + i] ^= b;
    }

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

    msg!("anqa: isolated portfolio opened for market {} (group {})", market_id, group);
    Ok(())
}
