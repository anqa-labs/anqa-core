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
    ASSET_SLOTS_SEED, BOOK_SEED, MARKET_SEED, ORACLE_STATE_SEED, RISK_GROUP_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::events::Fill;
use crate::instructions::initialize_risk::{INITIAL_MARGIN_BPS, MAINTENANCE_MARGIN_BPS};
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
    /// The portfolio owner, or a session key the owner granted.
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Present when a session key signs for the owner; judged in the handler.
    pub session: Option<Account<'info, crate::state::TradeSession>>,

    #[account(mut, seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.group_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.group_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    #[account(
        mut,
        constraint = portfolio.load()?.market_id == market.group_id.to_le_bytes() @ AnqaError::NotOrderOwner
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
    close_inner(ctx, worst_price_in_ticks, max_base_lots, false)
}

/// Isolated liquidation: close a position because **its own** collateral is
/// spent, not because the account is unhealthy.
///
/// The kernel pools capital and liquidates per account, so on its own it lets
/// one bad position eat everything the trader holds. Anqa records collateral
/// per position (`Portfolio::asset_collateral`), and this is what enforces it:
/// permissionless, refuses while the position's own margin survives, and
/// closes only that position.
///
/// ```text
///   margin = collateral + unrealised pnl of THIS position
///   liquidatable when margin <= size x maintenance margin
/// ```
///
/// The account's other markets never enter the arithmetic, which is what makes
/// "you can only lose what is behind this position" true rather than displayed.
/// The kernel's account-level `liquidate` remains the backstop beneath it.
pub fn liquidate_isolated_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClosePosition<'info>>,
    worst_price_in_ticks: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let asset_index = market.asset_index;
    let (is_long, size_q, collateral, entry) = {
        let pf = ctx.accounts.portfolio.load()?;
        let (is_long, size_q) = pf
            .current_position(asset_index)
            .ok_or(AnqaError::NoOpenPosition)?;
        (is_long, size_q, pf.collateral_of(asset_index), pf.entry_of(asset_index))
    };
    // No recorded collateral means no isolated promise to enforce — the
    // account-level liquidator owns that case.
    require!(collateral > 0 && entry > 0, AnqaError::NotAdlEligible);

    // `live_mark` refuses a stale price or a tripped breaker, so nobody can be
    // liquidated on a number the venue does not currently trust.
    let mark = ctx.accounts.oracle_state.live_mark(&market.oracle)? as u128;
    let lots = size_q / POS_SCALE;
    require!(
        isolated_underwater(collateral, entry, mark, lots, is_long),
        AnqaError::NotAdlEligible
    );

    msg!(
        "anqa: isolated liquidation — asset {} spent its {} of collateral",
        asset_index,
        collateral
    );
    close_inner(ctx, worst_price_in_ticks, 0, true)
}

/// Has this position spent its own margin?
///
/// Pure so the keeper can mirror it exactly when deciding *when* to call, and
/// so the arithmetic can be tested without a ledger.
pub fn isolated_underwater(
    collateral: u128,
    entry_per_lot: u128,
    mark_per_lot: u128,
    lots: u128,
    is_long: bool,
) -> bool {
    if lots == 0 {
        return false;
    }
    let pnl: i128 = if is_long {
        (mark_per_lot as i128 - entry_per_lot as i128) * lots as i128
    } else {
        (entry_per_lot as i128 - mark_per_lot as i128) * lots as i128
    };
    let margin = collateral as i128 + pnl;
    let maintenance = mark_per_lot
        .saturating_mul(lots)
        .saturating_mul(MAINTENANCE_MARGIN_BPS as u128)
        / 10_000u128;
    margin <= maintenance as i128
}

fn close_inner<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClosePosition<'info>>,
    worst_price_in_ticks: u64,
    max_base_lots: u64,
    liquidation: bool,
) -> Result<()> {
    let market = &ctx.accounts.market;
    // Queue entries and self-cross checks speak the owner's key regardless
    // of which key signed.
    let trader = ctx.accounts.portfolio.load()?.owner;
    // A liquidation is permissionless by design: it fires on a position whose
    // own margin is gone, and closing it protects the trader's other markets
    // as much as it protects the venue.
    require!(
        liquidation
            || crate::state::trade_authorized(
                trader,
                market.market_id,
                ctx.accounts.trader.key(),
                ctx.accounts.session.as_ref(),
            )?,
        AnqaError::NotOrderOwner
    );
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
        // IOC rests nothing, so the `rested` flag is vacuous here.
        let (fills, resting, _rested) = book.place(
            side,
            OrderType::ImmediateOrCancel,
            worst_price_in_ticks,
            close_lots,
            trader,
            u64::MAX, // reserved client id for protocol-initiated closes
            false,    // IOC rests nothing, so there is nothing to hide
        )?;
        let n = book.fill_count;
        (fills, resting, n)
    };
    require!(!fills.is_empty(), AnqaError::CloseUnfilled);

    // Dark markets: the close crossed the book, but settlement goes through
    // the pending queue like every dark fill — this closer cannot name its
    // counterparties either. The position shrinks when `settle_fill` runs;
    // triggers are swept there, where the position actually dies.
    if market.dark {
        let mut queued_notional: u128 = 0;
        {
            let mut book = ctx.accounts.book.load_mut()?;
            require!(
                book.pending_free() >= fills.len(),
                AnqaError::PendingFillsFull
            );
            for f in fills.iter() {
                book.push_pending(trader, side, f)?;
                let notional = market
                    .quote_notional(f.price_in_ticks, f.base_lots)
                    .ok_or(AnqaError::MathOverflow)? as u128;
                queued_notional = queued_notional
                    .checked_add(notional)
                    .ok_or(AnqaError::MathOverflow)?;
            }
        }
        let reserve = queued_notional
            .checked_mul(INITIAL_MARGIN_BPS as u128)
            .ok_or(AnqaError::MathOverflow)?
            / 10_000u128;
        ctx.accounts.portfolio.load_mut()?.reserve(reserve);

        let queued: u64 = fills.iter().map(|f| f.base_lots).sum();
        // Isolated margin: a full close frees the collateral that stood
        // behind this position, back into the account's spendable equity.
        if queued >= position_lots {
            let released = ctx
                .accounts
                .portfolio
                .load_mut()?
                .take_collateral(market.asset_index);
            if released > 0 {
                msg!("anqa: released {} of isolated collateral", released);
            }
        }
        emit!(PositionClosed {
            market_id: market.market_id,
            base_lots_closed: queued,
            fully_closed: queued >= position_lots,
        });
        msg!("anqa: dark — close queued {} lots for settlement", queued);
        return Ok(());
    }

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
                        .and_then(|l| l.load().map(|p| p.owner == f.maker
                            && p.market_id == ctx.accounts.market.market_id.to_le_bytes()))
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

    // A dead position must take its triggers with it — an orphaned stop
    // silently attaches to the next position this trader opens.
    if ctx
        .accounts
        .portfolio
        .load()?
        .current_position(asset_index)
        .is_none()
    {
        let cleared = ctx
            .accounts
            .portfolio
            .load_mut()?
            .clear_asset_triggers(asset_index as u8);
        if cleared > 0 {
            msg!("anqa: {} trigger(s) cleared with the position", cleared);
        }
    }

    if closed_lots >= position_lots {
        let released = ctx
            .accounts
            .portfolio
            .load_mut()?
            .take_collateral(market.asset_index);
        if released > 0 {
            msg!("anqa: released {} of isolated collateral", released);
        }
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
