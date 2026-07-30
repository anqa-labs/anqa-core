//! Post a ladder of quotes in one transaction.
//!
//! Nobody makes a market one order at a time. A maker quoting five levels a side
//! needs them to land together — partial ladders are directional exposure they
//! did not ask for.
//!
//! All orders here are **post-only**: a quote that would cross is a mistake, not
//! a trade. The whole batch is rejected rather than silently taking, which is
//! what a maker wants (they earn the spread by resting, not by paying it).
//!
//! Margin is checked once for the entire batch before anything rests, so a
//! ladder cannot be half-placed and leave the account over-committed.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ASSET_SLOTS_SEED, BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::events::OrderAccepted;
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::state::{
    AssetSlots, Book, Market, OracleState, OrderType, Portfolio, RiskGroup, Side,
};

/// Bound on a single batch, so matching stays compute-predictable.
pub const MAX_BATCH_ORDERS: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct QuoteParams {
    pub side: Side,
    pub price_in_ticks: u64,
    pub base_lots: u64,
    pub client_order_id: u64,
}

#[derive(Accounts)]
pub struct PlaceMultiple<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<PlaceMultiple>, quotes: Vec<QuoteParams>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.paused, AnqaError::MarketPaused);
    require!(!quotes.is_empty(), AnqaError::InvalidSize);
    require!(quotes.len() <= MAX_BATCH_ORDERS, AnqaError::TooManyAccounts);

    let trader = ctx.accounts.trader.key();
    let oracle = &ctx.accounts.oracle_state;
    let mark = oracle.live_mark(&market.oracle)?;

    // Every quote must be inside the band, and the batch's total margin must be
    // affordable — both checked before a single order rests.
    let mut total_margin: u128 = 0;
    for q in quotes.iter() {
        let price_quote = market
            .ticks_to_quote(q.price_in_ticks)
            .ok_or(AnqaError::MathOverflow)?;
        require!(
            oracle.within_band(&market.oracle, price_quote)?,
            AnqaError::PriceOutsideBand
        );
        let notional = (price_quote.max(mark) as u128)
            .checked_mul(q.base_lots as u128)
            .ok_or(AnqaError::MathOverflow)?;
        total_margin = total_margin
            .checked_add(
                notional
                    .checked_mul(INITIAL_MARGIN_BPS as u128)
                    .ok_or(AnqaError::MathOverflow)?
                    / 10_000u128,
            )
            .ok_or(AnqaError::MathOverflow)?;
    }

    {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut pf = ctx.accounts.portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(pf.account_mut());
        map_risk(view.full_account_refresh_not_atomic(&mut pv))?;

        require!(
            pf.free_margin()? >= total_margin,
            AnqaError::InsufficientMargin
        );
    }

    // Post-only, so nothing here can fill. If any quote would cross, the whole
    // batch aborts — a maker that accidentally takes has mispriced, and half a
    // ladder is worse than none.
    {
        let mut book = ctx.accounts.book.load_mut()?;
        for q in quotes.iter() {
            let (fills, resting, rested) = book.place(
                q.side,
                OrderType::PostOnly,
                q.price_in_ticks,
                q.base_lots,
                trader,
                q.client_order_id,
            )?;
            require!(fills.is_empty(), AnqaError::PostOnlyWouldCross);
            require!(resting == q.base_lots, AnqaError::PostOnlyWouldCross);
            // No eviction on the bulk path — a ladder that needs to evict is
            // quoting into a book with no room for it. Single orders may evict
            // via `place_order`.
            require!(rested, AnqaError::BookSideFull);
        }
    }

    ctx.accounts.portfolio.load_mut()?.reserve(total_margin);

    for q in quotes.iter() {
        emit!(OrderAccepted {
            market_id: market.market_id,
            client_order_id: q.client_order_id,
        });
    }

    msg!("anqa: posted {} quote(s)", quotes.len());
    Ok(())
}
