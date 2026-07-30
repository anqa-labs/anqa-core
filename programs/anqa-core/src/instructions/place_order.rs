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
use crate::events::{Fill, OrderAccepted, OrderCancelled};
use crate::state::{
    AssetSlots, Book, FillRecord, Market, OracleState, OrderType, Portfolio, RiskGroup, Side,
};

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
    let (fills, resting, rested, fill_count_after) = {
        let mut book = ctx.accounts.book.load_mut()?;
        let (fills, resting, rested) = book.place(
            side,
            order_type,
            price_in_ticks,
            base_lots,
            trader_key,
            client_order_id,
        )?;
        let n = book.fill_count;
        (fills, resting, rested, n)
    };

    // --- 2.5 dark markets: queue, don't settle -------------------------------
    // A taker on a dark market cannot name the makers it crossed, so the fills
    // it produced go to the book's pending queue and the engine (which can see
    // the book) drives `settle_fill`. Margin for the queued lots is reserved
    // exactly like resting-order margin; settlement releases it when the
    // kernel takes over. A full queue refuses the order outright — an engine
    // that cannot keep up must not keep matching. No eviction in the dark:
    // the taker cannot supply the evicted owner's portfolio either.
    if ctx.accounts.market.dark {
        require!(resting == 0 || rested, AnqaError::BookSideFull);
        let mut reserve_total: u128 = 0;
        if !fills.is_empty() {
            let mut book = ctx.accounts.book.load_mut()?;
            require!(
                book.pending_free() >= fills.len(),
                AnqaError::PendingFillsFull
            );
            for f in fills.iter() {
                book.push_pending(trader_key, side, f)?;
                let notional = market
                    .quote_notional(f.price_in_ticks, f.base_lots)
                    .ok_or(AnqaError::MathOverflow)? as u128;
                reserve_total = reserve_total
                    .checked_add(notional)
                    .ok_or(AnqaError::MathOverflow)?;
            }
        }
        if resting > 0 {
            let resting_notional = market
                .quote_notional(price_in_ticks, resting)
                .ok_or(AnqaError::MathOverflow)? as u128;
            reserve_total = reserve_total
                .checked_add(resting_notional)
                .ok_or(AnqaError::MathOverflow)?;
        }
        if reserve_total > 0 {
            let reserve = reserve_total
                .checked_mul(INITIAL_MARGIN_BPS as u128)
                .ok_or(AnqaError::MathOverflow)?
                / 10_000u128;
            ctx.accounts.portfolio.load_mut()?.reserve(reserve);
        }
        emit!(OrderAccepted {
            market_id,
            client_order_id,
        });
        msg!(
            "anqa: dark — {} fill(s) queued, {} lots resting",
            fills.len(),
            resting
        );
        return Ok(());
    }

    // --- 3. risk ------------------------------------------------------------
    // Each fill becomes a position pair. The kernel may still refuse — the
    // pre-check above is Anqa's, this is the kernel's, and only the kernel's
    // is authoritative.
    //
    // A refusal does NOT fail the taker. The refused maker's order is provably
    // unbackable — the kernel would never let it become a position for anyone —
    // so it is auto-cancelled, its margin released, and matching moves on.
    // Failing instead would let one underwater account brick a price level:
    // its order stays at the head of the queue and every taker who touches it
    // reverts. The one exception is fill-or-kill, whose all-or-nothing promise
    // a refused leg breaks — that still aborts everything.
    let resting_side = side.opposite();
    let mut credited: Vec<FillRecord> = Vec::with_capacity(fills.len());
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

            let maker_loader = AccountLoader::<Portfolio>::try_from(maker_ai)?;
            let mut maker = maker_loader.load_mut()?;

            // Resting orders were banded when placed, but the mark moves. A
            // resting price now outside the band is stale by definition — the
            // order is cancelled, not crossed.
            let fill_price_quote = market
                .ticks_to_quote(f.price_in_ticks)
                .ok_or(AnqaError::MathOverflow)?;
            let mut accepted = band_ok(fill_price_quote, mark, market.oracle.max_band_bps);

            if accepted {
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
                if order_type == OrderType::FillOrKill {
                    map_risk(res)?;
                }
                if let Err(e) = &res {
                    // The refusal is folded into an auto-cancel below; the tape
                    // must still say why, or refusals become undiagnosable.
                    msg!("anqa: kernel refused fill: {:?}", e);
                }
                accepted = res.is_ok();
            } else {
                require!(
                    order_type != OrderType::FillOrKill,
                    AnqaError::FillOrKillUnfilled
                );
            }

            if !accepted {
                // Auto-cancel: remove whatever part of the order still rests,
                // release the margin the whole order held, tell the owner.
                let mut cancelled_lots = f.base_lots;
                if !f.maker_order_closed {
                    let mut book = ctx.accounts.book.load_mut()?;
                    let (_, remainder) = book
                        .side_mut(resting_side)
                        .cancel(&f.maker, f.maker_client_order_id)?;
                    cancelled_lots = cancelled_lots.saturating_add(remainder);
                }
                let cancelled_notional = market
                    .quote_notional(f.price_in_ticks, cancelled_lots)
                    .ok_or(AnqaError::MathOverflow)? as u128;
                let freed = cancelled_notional
                    .checked_mul(INITIAL_MARGIN_BPS as u128)
                    .ok_or(AnqaError::MathOverflow)?
                    / 10_000u128;
                maker.release(freed);
                emit!(OrderCancelled {
                    market_id,
                    client_order_id: f.maker_client_order_id,
                });
                // The taker's lots that "matched" here go unexecuted — same
                // outcome as if the maker had cancelled a moment earlier. A
                // taker is never owed the depth it saw.
                continue;
            }

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
            credited.push(*f);
        }
    }

    // --- 3.5 eviction: a full side yields its worst order to a better one ----
    // Without this a full book freezes in whatever shape it filled up in: the
    // 33rd order is refused even at a better price, while a never-to-trade
    // order keeps its slot. Eviction keeps the book holding the N most
    // aggressive orders anyone wants to place. Only a strictly better price
    // earns a slot — an equal price arrived later and loses on time.
    if resting > 0 && !rested {
        {
            let book = ctx.accounts.book.load()?;
            require!(
                book.outranks_worst(side, price_in_ticks),
                AnqaError::BookSideFull
            );
        }
        let evicted = {
            let mut book = ctx.accounts.book.load_mut()?;
            let evicted = book
                .side_mut(side)
                .evict_worst()
                .ok_or(AnqaError::BookSideFull)?;
            book.rest(side, trader_key, client_order_id, price_in_ticks, resting)?;
            evicted
        };

        // Give the evicted order's margin back to its owner, whose portfolio
        // the client supplies (or it is the taker's own).
        let evicted_notional = market
            .quote_notional(evicted.price_in_ticks, evicted.base_lots)
            .ok_or(AnqaError::MathOverflow)? as u128;
        let freed = evicted_notional
            .checked_mul(INITIAL_MARGIN_BPS as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128;
        if evicted.trader == trader_key {
            ctx.accounts.portfolio.load_mut()?.release(freed);
        } else {
            let owner_ai = ctx
                .remaining_accounts
                .iter()
                .find(|ai| {
                    AccountLoader::<Portfolio>::try_from(ai)
                        .and_then(|l| l.load().map(|p| p.owner == evicted.trader))
                        .unwrap_or(false)
                })
                .ok_or(AnqaError::EvictedPortfolioMissing)?;
            AccountLoader::<Portfolio>::try_from(owner_ai)?
                .load_mut()?
                .release(freed);
        }
        emit!(OrderCancelled {
            market_id,
            client_order_id: evicted.client_order_id,
        });
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
    // Auto-cancelled fills never consummated, so they are not fills: back the
    // book's counter off and number the tape by what actually traded.
    let failed = (fills.len() - credited.len()) as u64;
    if failed > 0 {
        let mut book = ctx.accounts.book.load_mut()?;
        book.fill_count = book.fill_count.saturating_sub(failed);
        if let Some(last) = credited.last() {
            book.last_fill_price_in_ticks = last.price_in_ticks;
            book.last_fill_base_lots = last.base_lots;
        }
    }
    let now = Clock::get()?.unix_timestamp;
    let mut fill_seq = (fill_count_after - failed) - credited.len() as u64;
    for f in credited.iter() {
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
        credited.len(),
        resting
    );
    Ok(())
}

/// Band check against a mark already validated by the caller.
pub fn band_ok(price: u64, mark: u64, max_band_bps: u16) -> bool {
    if max_band_bps == 0 || mark == 0 {
        return true;
    }
    let diff = mark.abs_diff(price) as u128;
    diff.saturating_mul(10_000) / mark as u128 <= max_band_bps as u128
}
