//! Close a position.
//!
//! In a CLOB there is no separate "close" primitive — closing is just trading
//! the other way, and the netting logic in the risk kernel turns an opposing
//! fill into a reduction. So why does this instruction exist at all?
//!
//! **Safety.** If a trader long 3 BTC sends a sell for 5, the first 3 close and
//! the last 2 open a *short*. That is almost never what someone clicking
//! "close" meant. This instruction reads the position from the kernel, sizes the
//! order to it exactly, and refuses to exceed it — so closing can never flip you.
//!
//! It is an immediate-or-cancel order at a caller-supplied worst price. If the
//! book cannot fill it there, nothing rests: a close that silently becomes a
//! resting order is a position you think you exited and have not.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, TradeRequestV16, POS_SCALE};

use crate::constants::{
    ASSET_SLOTS_SEED, BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::events::Fill;
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::state::{
    AssetSlots, Book, Market, OracleState, OrderType, Portfolio, RiskGroup, Side,
};

#[event]
pub struct PositionClosed {
    pub market_id: u64,
    pub base_lots_closed: u64,
    pub fully_closed: bool,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
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
    // remaining_accounts: one `Portfolio` per maker this close may cross.
}

/// `worst_price_in_ticks` is a slippage bound: the lowest acceptable price when
/// closing a long, the highest when closing a short. `max_base_lots` of zero
/// means "all of it".
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClosePosition<'info>>,
    worst_price_in_ticks: u64,
    max_base_lots: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let trader = ctx.accounts.trader.key();
    let asset_index = market.asset_index;

    // What is actually open? The book cannot answer this; only the kernel can.
    let (is_long, size_q) = ctx
        .accounts
        .portfolio
        .load()?
        .current_position(asset_index)
        .ok_or(AnqaError::NoOpenPosition)?;

    // Position size is carried in POS_SCALE units; the book speaks base lots.
    let position_lots = u64::try_from(size_q / POS_SCALE).map_err(|_| AnqaError::MathOverflow)?;
    require!(position_lots > 0, AnqaError::NoOpenPosition);

    let close_lots = if max_base_lots == 0 {
        position_lots
    } else {
        max_base_lots.min(position_lots)
    };

    // Closing a long means selling; closing a short means buying.
    let side = if is_long { Side::Ask } else { Side::Bid };

    let order_price_quote = market
        .ticks_to_quote(worst_price_in_ticks)
        .ok_or(AnqaError::MathOverflow)?;
    let oracle = &ctx.accounts.oracle_state;
    require!(
        oracle.within_band(&market.oracle, order_price_quote)?,
        AnqaError::PriceOutsideBand
    );
    let mark = oracle.live_mark(&market.oracle)?;

    // IOC: fill what the book offers at this price or better, rest nothing.
    let (fills, _resting, fill_count_after) = {
        let mut book = ctx.accounts.book.load_mut()?;
        let (fills, resting) = book.place(
            side,
            OrderType::ImmediateOrCancel,
            worst_price_in_ticks,
            close_lots,
            trader,
            u64::MAX, // reserved client id for protocol-initiated closes
        )?;
        let n = book.fill_count;
        (fills, resting, n)
    };
    require!(!fills.is_empty(), AnqaError::CloseUnfilled);

    let mut closed_lots: u64 = 0;
    {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut taker = ctx.accounts.portfolio.load_mut()?;
        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

        for f in fills.iter() {
            let fill_price_quote = market
                .ticks_to_quote(f.price_in_ticks)
                .ok_or(AnqaError::MathOverflow)?;
            require!(
                crate::instructions::place_order::band_ok(
                    fill_price_quote,
                    mark,
                    market.oracle.max_band_bps
                ),
                AnqaError::PriceOutsideBand
            );

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

            let req = TradeRequestV16 {
                asset_index: asset_index as usize,
                size_q: i128::from(f.base_lots)
                    .checked_mul(POS_SCALE as i128)
                    .ok_or(AnqaError::MathOverflow)?,
                exec_price: fill_price_quote,
                fee_bps: market.taker_fee_bps as u64,
            };

            let mut taker_view = PortfolioV16ViewMut::new(taker.account_mut());
            let mut maker_view = PortfolioV16ViewMut::new(maker.account_mut());
            // We are on `side`; the buyer always takes the long leg.
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

            // The maker's resting order became a position; release its reserve.
            let freed = (fill_price_quote as u128)
                .checked_mul(f.base_lots as u128)
                .ok_or(AnqaError::MathOverflow)?
                .checked_mul(INITIAL_MARGIN_BPS as u128)
                .ok_or(AnqaError::MathOverflow)?
                / 10_000u128;
            maker.release(freed);

            closed_lots = closed_lots.saturating_add(f.base_lots);
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let mut seq = fill_count_after - fills.len() as u64;
    for f in fills.iter() {
        seq += 1;
        emit!(Fill {
            market_id: market.market_id,
            price_in_ticks: f.price_in_ticks,
            base_lots: f.base_lots,
            fill_seq: seq,
            timestamp: now,
        });
    }

    emit!(PositionClosed {
        market_id: market.market_id,
        base_lots_closed: closed_lots,
        fully_closed: closed_lots >= position_lots,
    });
    msg!(
        "anqa: closed {} of {} lots",
        closed_lots,
        position_lots
    );
    Ok(())
}
