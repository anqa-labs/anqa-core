//! Rollup: settle the oldest pending fill on a dark market.
//!
//! On a dark market, matching and settlement decouple: `place_order` crossed
//! the book and queued the fill, because the taker cannot name makers it
//! cannot see. This instruction is the other half — driven by the engine
//! keeper (the party permissioned to read the book), it executes the queued
//! pair through the risk kernel and prints the fill to the public tape.
//!
//! **Strictly FIFO.** Only the oldest fill can settle, in the order the book
//! produced them — settlement order is not the caller's to choose. The caller
//! names the two portfolios the head fill requires; wrong accounts simply
//! fail to match.
//!
//! Permissionless on purpose: it can only execute what the book already
//! matched, at the price the book recorded, between the parties the book
//! named. Only permissioned readers can *see* what to settle, but nothing
//! breaks if anyone else drives it.
//!
//! **Failure is consumption, not a revert**, mirroring the lit engine's
//! auto-cancel: if the price has left the band or the kernel refuses, the
//! fill is dropped, the maker's surviving order is cancelled, everyone's
//! reserved margin comes back, and the queue advances. A refused fill must
//! never block the queue behind it.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, TradeRequestV16, POS_SCALE};

use crate::constants::{
    ASSET_SLOTS_SEED, BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED, RISK_GROUP_SEED, TAPE_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::events::{Fill, OrderCancelled};
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::instructions::place_order::band_ok;
use crate::state::{AssetSlots, Book, FillTape, Market, OracleState, Portfolio, RiskGroup, Side};

#[derive(Accounts)]
pub struct SettleFill<'info> {
    /// The engine keeper in practice; anyone in principle.
    pub caller: Signer<'info>,

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

    /// The head fill's taker. Verified against the queue in the handler.
    #[account(mut)]
    pub taker_portfolio: AccountLoader<'info, Portfolio>,

    /// The head fill's maker. Never the taker's account — self-trade
    /// prevention cancels self-crosses at match time, so a self pending fill
    /// cannot exist.
    #[account(mut)]
    pub maker_portfolio: AccountLoader<'info, Portfolio>,

    /// The public tape — the only account in the dark set the world reads.
    #[account(mut, seeds = [TAPE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, FillTape>,
}

pub fn handler(ctx: Context<SettleFill>) -> Result<()> {
    let market = &ctx.accounts.market;
    let asset_index = market.asset_index as usize;

    // Take the head fill — FIFO is not negotiable.
    let fill = {
        let mut book = ctx.accounts.book.load_mut()?;
        let head = *book.peek_pending().ok_or(AnqaError::OrderNotFound)?;
        require!(
            ctx.accounts.taker_portfolio.load()?.owner == head.taker
                && ctx.accounts.maker_portfolio.load()?.owner == head.maker,
            AnqaError::WrongPendingFill
        );
        book.pop_pending()?
    };

    let taker_side = if fill.taker_is_ask == 1 { Side::Ask } else { Side::Bid };
    let fill_price_quote = market
        .ticks_to_quote(fill.price_in_ticks)
        .ok_or(AnqaError::MathOverflow)?;
    let fill_notional = market
        .quote_notional(fill.price_in_ticks, fill.base_lots)
        .ok_or(AnqaError::MathOverflow)? as u128;
    let fill_margin = fill_notional
        .checked_mul(INITIAL_MARGIN_BPS as u128)
        .ok_or(AnqaError::MathOverflow)?
        / 10_000u128;

    // The taker's queue-time reservation comes back either way; on success the
    // kernel now accounts for the exposure, on refusal there is nothing to back.
    ctx.accounts.taker_portfolio.load_mut()?.release(fill_margin);

    // Judge the fill: still inside the band, and the kernel accepts it.
    let mark = ctx.accounts.oracle_state.live_mark(&market.oracle)?;
    let mut accepted = band_ok(fill_price_quote, mark, market.oracle.max_band_bps);

    if accepted {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut taker = ctx.accounts.taker_portfolio.load_mut()?;
        let mut maker = ctx.accounts.maker_portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

        // Settlement happens *after* matching, so both sides may have accrued
        // funding or losses since the book paired them, and both carry health
        // certificates stamped against older epochs. The kernel refuses to
        // trade on a stale certificate (`LockActive`), so refresh both first.
        // The lit path gets this for free — it refreshes the taker up front
        // and the makers were certified when they rested a moment earlier —
        // which is exactly why decoupling the two halves needs it stated.
        {
            let mut tv = PortfolioV16ViewMut::new(taker.account_mut());
            map_risk(view.full_account_refresh_not_atomic(&mut tv))?;
        }
        {
            let mut mv = PortfolioV16ViewMut::new(maker.account_mut());
            map_risk(view.full_account_refresh_not_atomic(&mut mv))?;
        }

        let req = TradeRequestV16 {
            asset_index,
            size_q: i128::from(fill.base_lots)
                .checked_mul(POS_SCALE as i128)
                .ok_or(AnqaError::MathOverflow)?,
            exec_price: fill_price_quote,
            fee_bps: market.taker_fee_bps as u64,
        };
        let mut taker_view = PortfolioV16ViewMut::new(taker.account_mut());
        let mut maker_view = PortfolioV16ViewMut::new(maker.account_mut());
        // The buyer takes the long leg.
        let res = match taker_side {
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
        if let Err(e) = &res {
            msg!("anqa: kernel refused dark fill: {:?}", e);
        }
        accepted = res.is_ok();
    }

    if accepted {
        // The maker's fill portion is kernel-accounted now.
        ctx.accounts.maker_portfolio.load_mut()?.release(fill_margin);

        // Sweep triggers on any position this settlement killed.
        for loader in [&ctx.accounts.taker_portfolio, &ctx.accounts.maker_portfolio] {
            if loader.load()?.current_position(market.asset_index).is_none() {
                loader.load_mut()?.clear_asset_triggers(market.asset_index as u8);
            }
        }

        // The print — the one thing the world sees.
        let now = Clock::get()?.unix_timestamp;
        let seq = ctx
            .accounts
            .tape
            .load_mut()?
            .print(fill.price_in_ticks, fill.base_lots, now);
        emit!(Fill {
            market_id: market.market_id,
            price_in_ticks: fill.price_in_ticks,
            base_lots: fill.base_lots,
            fill_seq: seq,
            timestamp: now,
        });
        msg!(
            "anqa: dark fill settled — {}@{} (print {})",
            fill.base_lots,
            fill.price_in_ticks,
            seq
        );
    } else {
        // Refusal consumes: cancel whatever part of the maker's order still
        // rests, release the margin the whole order held, tell the owner.
        let mut cancelled_lots = fill.base_lots;
        if fill.maker_order_closed == 0 {
            let mut book = ctx.accounts.book.load_mut()?;
            let resting_side = taker_side.opposite();
            if let Ok((_, remainder)) = book
                .side_mut(resting_side)
                .cancel(&fill.maker, fill.maker_client_order_id)
            {
                cancelled_lots = cancelled_lots.saturating_add(remainder);
            }
        }
        let cancelled_notional = market
            .quote_notional(fill.price_in_ticks, cancelled_lots)
            .ok_or(AnqaError::MathOverflow)? as u128;
        let freed = cancelled_notional
            .checked_mul(INITIAL_MARGIN_BPS as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128;
        ctx.accounts.maker_portfolio.load_mut()?.release(freed);
        emit!(OrderCancelled {
            market_id: market.market_id,
            client_order_id: fill.maker_client_order_id,
        });
        msg!("anqa: dark fill refused and consumed; maker order cancelled");
    }

    Ok(())
}
