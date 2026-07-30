//! Place an order.
//!
//! Two engines meet here, and the seam is the whole design:
//!
//! 1. **The book** decides *who trades at what price* — price-time priority,
//!    crankless, taker crosses inside this instruction.
//! 2. **The risk kernel** decides *whether they may* — every fill is handed to
//!    Percolator, which mints the long/short pair or refuses on margin.
//!
//! No tokens move. A perp fill is a bookkeeping event between two margin
//! accounts; collateral only crosses custody in `deposit`/`withdraw`.
//!
//! Because a fill mutates *both* traders' portfolios atomically, maker
//! portfolios must be supplied in `remaining_accounts`. On a lit book the taker
//! reads the book and knows who it will cross. (When the book goes dark this
//! becomes the settlement problem — the taker can no longer see its
//! counterparties, so crediting has to move inside the enclave.)

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, TradeRequestV16, POS_SCALE};

use crate::constants::{
    ASSET_SLOTS_SEED, BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED, PORTFOLIO_SEED,
    RISK_GROUP_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::events::{Fill, OrderAccepted};
use crate::state::{AssetSlots, Book, Market, OracleState, OrderType, Portfolio, RiskGroup, Side};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// The order book. Delegated to the rollup in production.
    #[account(mut, seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// Last accepted mark plus the circuit breaker. Read, never written, here:
    /// trading references the mark but must not be able to move it.
    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    /// The taker's margin account.
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.market_id.to_le_bytes(), trader.key().as_ref()],
        bump,
        constraint = portfolio.load()?.owner == trader.key() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
    // remaining_accounts: one `Portfolio` per maker this order may cross.
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
    side: Side,
    order_type: OrderType,
    price_in_ticks: u64,
    base_lots: u64,
    client_order_id: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.paused, AnqaError::MarketPaused);

    let trader_key = ctx.accounts.trader.key();
    let market_id = market.market_id;
    let asset_index = market.asset_index as usize;

    // --- 0. is this price anywhere near reality? -----------------------------
    // A perp fill mints a position at its execution price and the mark instantly
    // revalues it, so an off-market trade creates value out of nothing at the
    // vault's expense. The book still discovers price — this only bounds how far
    // it may wander from the oracle. Also fails when the mark is stale or the
    // breaker is tripped, which halts trading rather than trading blind.
    // Book prices are tick counts, the mark is quote atoms. Convert before
    // comparing — mixing the two is only harmless when tick_size == 1.
    let order_price_quote = market
        .ticks_to_quote(price_in_ticks)
        .ok_or(AnqaError::MathOverflow)?;
    let oracle = &ctx.accounts.oracle_state;
    require!(
        oracle.within_band(&market.oracle, order_price_quote)?,
        AnqaError::PriceOutsideBand
    );
    let mark = oracle.live_mark(&market.oracle)?;

    // --- 1. can this trader afford the order at all? -------------------------
    // The kernel only sees positions; a resting order is invisible to it. So we
    // check up front against certified equity, counting margin already committed
    // to open positions *and* to this trader's other resting orders. Without
    // this an account could paper the book with orders it cannot honour and only
    // fail at match time, after the book has been walked.
    // Size margin off whichever is worse for us — a resting bid far below the
    // mark must not reserve less margin than the exposure it will actually take.
    // Both sides of this max are quote atoms.
    let margin_price_quote = order_price_quote.max(mark);
    let order_notional = (margin_price_quote as u128)
        .checked_mul(base_lots as u128)
        .ok_or(AnqaError::MathOverflow)?;
    let order_margin = order_notional
        .checked_mul(INITIAL_MARGIN_BPS as u128)
        .ok_or(AnqaError::MathOverflow)?
        / 10_000u128;

    {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut taker = ctx.accounts.portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(taker.account_mut());
        map_risk(view.full_account_refresh_not_atomic(&mut pv))?;

        require!(
            taker.free_margin()? >= order_margin,
            AnqaError::InsufficientMargin
        );
    }

    // --- 2. matching ---------------------------------------------------------
    let (fills, resting, fill_count_after) = {
        let mut book = ctx.accounts.book.load_mut()?;
        let (fills, resting) = book.place(
            side,
            order_type,
            price_in_ticks,
            base_lots,
            trader_key,
            client_order_id,
        )?;
        let n = book.fill_count;
        (fills, resting, n)
    };

    // --- 3. risk ------------------------------------------------------------
    // Each fill becomes a position pair. The kernel may still refuse — the
    // pre-check above is Anqa's, this is the kernel's, and only the kernel's
    // is authoritative.
    if !fills.is_empty() {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut taker = ctx.accounts.portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

        for f in fills.iter() {
            // Locate this maker's portfolio among the supplied accounts.
            let maker_ai = ctx
                .remaining_accounts
                .iter()
                .find(|ai| {
                    AccountLoader::<Portfolio>::try_from(ai)
                        .and_then(|l| l.load().map(|p| p.owner == f.maker))
                        .unwrap_or(false)
                })
                .ok_or(AnqaError::MakerPortfolioMissing)?;

            // Resting orders were banded when placed, but the mark moves. Check
            // again at execution so a stale resting order cannot be crossed at a
            // price that is now far from reality.
            let fill_price_quote = market
                .ticks_to_quote(f.price_in_ticks)
                .ok_or(AnqaError::MathOverflow)?;
            require!(
                band_ok(fill_price_quote, mark, market.oracle.max_band_bps),
                AnqaError::PriceOutsideBand
            );

            let maker_loader = AccountLoader::<Portfolio>::try_from(maker_ai)?;
            let mut maker = maker_loader.load_mut()?;

            let exec_price = market
                .quote_notional(f.price_in_ticks, 1)
                .ok_or(AnqaError::MathOverflow)?;
            let size_q = i128::from(f.base_lots)
                .checked_mul(POS_SCALE as i128)
                .ok_or(AnqaError::MathOverflow)?;

            let req = TradeRequestV16 {
                asset_index,
                size_q,
                exec_price,
                fee_bps: market.taker_fee_bps as u64,
            };

            // Orientation: the buyer takes the long leg.
            let mut taker_view = PortfolioV16ViewMut::new(taker.account_mut());
            let mut maker_view = PortfolioV16ViewMut::new(maker.account_mut());
            let res = match side {
                Side::Bid => view.execute_trade_with_fee_loss_stale_scoped_not_atomic(
                    &mut taker_view,
                    &mut maker_view,
                    req,
                ),
                Side::Ask => view.execute_trade_with_fee_loss_stale_scoped_not_atomic(
                    &mut maker_view,
                    &mut taker_view,
                    req,
                ),
            };
            map_risk(res)?;

            // The maker's resting order became a position: the margin it had
            // reserved is now accounted for by the kernel, so release ours.
            let filled_notional = market
                .quote_notional(f.price_in_ticks, f.base_lots)
                .ok_or(AnqaError::MathOverflow)? as u128;
            let freed = filled_notional
                .checked_mul(INITIAL_MARGIN_BPS as u128)
                .ok_or(AnqaError::MathOverflow)?
                / 10_000u128;
            maker.release(freed);
        }
    }

    // --- 4. reserve margin for whatever rests --------------------------------
    if resting > 0 {
        let resting_notional = market
            .quote_notional(price_in_ticks, resting)
            .ok_or(AnqaError::MathOverflow)? as u128;
        let reserve = resting_notional
            .checked_mul(INITIAL_MARGIN_BPS as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128;
        ctx.accounts.portfolio.load_mut()?.reserve(reserve);
    }

    // --- 5. the public tape --------------------------------------------------
    let now = Clock::get()?.unix_timestamp;
    let mut fill_seq = fill_count_after - fills.len() as u64;
    for f in fills.iter() {
        fill_seq += 1;
        emit!(Fill {
            market_id,
            price_in_ticks: f.price_in_ticks,
            base_lots: f.base_lots,
            fill_seq,
            timestamp: now,
        });
    }

    emit!(OrderAccepted {
        market_id,
        client_order_id,
    });

    msg!(
        "anqa: {} fill(s), {} lots resting",
        fills.len(),
        resting
    );
    Ok(())
}

/// Band check against a mark already validated by the caller.
fn band_ok(price: u64, mark: u64, max_band_bps: u16) -> bool {
    if max_band_bps == 0 || mark == 0 {
        return true;
    }
    let diff = mark.abs_diff(price) as u128;
    diff.saturating_mul(10_000) / mark as u128 <= max_band_bps as u128
}
