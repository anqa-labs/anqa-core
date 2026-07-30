//! # Anqa
//!
//! A perpetuals DEX whose order book lives inside a Private Ephemeral Rollup.
//!
//! The book is a Phoenix-style central limit order book — strict price-time
//! priority, FIFO order identifiers, crankless execution — with one difference
//! that defines the product: it is **delegated into a TEE-backed rollup**, so
//! resting depth is invisible to everyone, including the operator. Only fills
//! reach the public tape.
//!
//! Layout:
//! - `state::market` — market configuration (base layer, never delegated)
//! - `state::seat`   — per-trader account and unit of read permission
//! - `state::book`   — the CLOB: arenas, intrusive priority lists, matching
//! - `instructions`  — one module per instruction
//!
//! Margin, funding and liquidation are not here. Those belong to the Percolator
//! risk kernel, which this program will drive as its wrapper: the book decides
//! *who trades at what price*, the kernel decides *whether they may* and what it
//! does to their accounts.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use instructions::place_multiple::QuoteParams;
use state::{OracleKind, OracleParams, OrderType, Side, TriggerDirection};

declare_id!("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");

#[ephemeral]
#[program]
pub mod anqa_core {
    use super::*;

    /// Base layer: create a market and its empty book.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        tick_size: u64,
        base_lot_size: u64,
        base_decimals: u8,
        quote_decimals: u8,
        taker_fee_bps: u16,
        maker_rebate_bps: u16,
        oracle_kind: OracleKind,
        oracle: OracleParams,
    ) -> Result<()> {
        instructions::initialize_market::handler(
            ctx,
            market_id,
            tick_size,
            base_lot_size,
            base_decimals,
            quote_decimals,
            taker_fee_bps,
            maker_rebate_bps,
            oracle_kind,
            oracle,
        )
    }

    /// Base layer: stand up the risk engine for a market group.
    pub fn initialize_risk(
        ctx: Context<InitializeRisk>,
        market_id: u64,
        asset_count: u32,
    ) -> Result<()> {
        instructions::initialize_risk::handler(ctx, market_id, asset_count)
    }

    /// Base layer: create the collateral vault. Never delegated to the rollup.
    pub fn initialize_vault(ctx: Context<InitializeVault>, market_id: u64) -> Result<()> {
        instructions::initialize_vault::handler(ctx, market_id)
    }

    /// Base layer: open a margin account. This is also the trader's seat.
    pub fn open_portfolio(ctx: Context<OpenPortfolio>) -> Result<()> {
        instructions::open_portfolio::handler(ctx)
    }

    /// Base layer: deposit collateral. One of only two instructions that move tokens.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Promote proven-backed profit from junior `pnl` into withdrawable
    /// `capital`. Without this a winner can close a profitable position and
    /// still be unable to take the profit home. Permissionless.
    pub fn realize_pnl(ctx: Context<RealizePnl>) -> Result<()> {
        instructions::realize_pnl::handler(ctx)
    }

    /// Base layer: withdraw collateral. Requires a flat account — the kernel
    /// will not release funds out from under an open position.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Base layer: delegate the book into the ephemeral rollup.
    pub fn delegate_book(ctx: Context<DelegateBook>, market_id: u64) -> Result<()> {
        instructions::delegate_book::handler(ctx, market_id)
    }

    /// Place an order. Crosses the resting book, then rests the remainder; every
    /// fill is handed to the risk kernel, which may refuse it.
    ///
    /// `remaining_accounts`: one `Portfolio` per maker this order may cross.
    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
        side: Side,
        order_type: OrderType,
        price_in_ticks: u64,
        base_lots: u64,
        client_order_id: u64,
    ) -> Result<()> {
        instructions::place_order::handler(
            ctx,
            side,
            order_type,
            price_in_ticks,
            base_lots,
            client_order_id,
        )
    }

    /// Relay a verified Pyth price into the internal oracle account, so the
    /// venue can still read a price once the book lives inside the rollup.
    /// Permissionless — the keeper copies a verified number, it supplies none.
    pub fn sync_internal_oracle(ctx: Context<SyncInternalOracle>) -> Result<()> {
        instructions::sync_internal_oracle::handler(ctx)
    }

    /// Advance mark price and funding for an asset. The mark is read from Pyth;
    /// the caller cannot supply a price.
    pub fn crank<'info>(
        ctx: Context<'_, '_, 'info, 'info, Crank<'info>>,
        asset_index: u32,
        funding_rate_e9: i128,
    ) -> Result<()> {
        instructions::crank::handler(ctx, asset_index, funding_rate_e9)
    }

    /// Settle one account against the latest accrual.
    pub fn refresh_portfolio(ctx: Context<RefreshPortfolio>) -> Result<()> {
        instructions::crank::refresh_handler(ctx)
    }

    /// Create the insurance vault — layer 2 of the loss waterfall, held apart
    /// from custody so it cannot be paid out as trader collateral.
    pub fn initialize_insurance_vault(
        ctx: Context<InitializeInsuranceVault>,
        market_id: u64,
    ) -> Result<()> {
        instructions::insurance::initialize_vault(ctx, market_id)
    }

    /// Fund an asset's insurance, long and short domains separately.
    /// Permissionless — anyone may strengthen the backstop.
    pub fn fund_insurance(
        ctx: Context<FundInsurance>,
        asset_index: u32,
        long_amount: u64,
        short_amount: u64,
    ) -> Result<()> {
        instructions::insurance::fund(ctx, asset_index, long_amount, short_amount)
    }

    /// Auto-deleverage a profitable position — layer 4, reached only when
    /// counterparty collateral, insurance and the haircut have all failed.
    /// Permissionless, bounded by the kernel, and always emits an event.
    pub fn adl(ctx: Context<Adl>, asset_index: u32, reduce_base_lots: u64) -> Result<()> {
        instructions::adl::handler(ctx, asset_index, reduce_base_lots)
    }

    /// Liquidate an unhealthy account. Permissionless; refuses while healthy.
    pub fn liquidate(ctx: Context<Liquidate>, asset_index: u32) -> Result<()> {
        instructions::liquidate::handler(ctx, asset_index)
    }

    /// Pull every resting order this trader has. The panic button — permitted
    /// even while the market is paused, since a pause must not trap orders.
    pub fn cancel_all_orders(ctx: Context<CancelBulk>) -> Result<()> {
        instructions::cancel_bulk::cancel_all(ctx)
    }

    /// Pull only quotes at or more aggressive than a price, leaving the passive
    /// remainder working. The everyday risk tool for a maker.
    pub fn cancel_up_to(
        ctx: Context<CancelBulk>,
        side: Side,
        price_in_ticks: u64,
    ) -> Result<()> {
        instructions::cancel_bulk::cancel_up_to(ctx, side, price_in_ticks)
    }

    /// Post a ladder of post-only quotes in one transaction. All-or-nothing.
    pub fn place_multiple(ctx: Context<PlaceMultiple>, quotes: Vec<QuoteParams>) -> Result<()> {
        instructions::place_multiple::handler(ctx, quotes)
    }

    /// Close an open position, reduce-only by construction.
    ///
    /// Sized to the position the kernel actually holds, so a close can never
    /// overshoot into an opposite position. IOC — a close that silently rests
    /// is a position you believe you exited and have not.
    pub fn close_position<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClosePosition<'info>>,
        worst_price_in_ticks: u64,
        max_base_lots: u64,
    ) -> Result<()> {
        instructions::close_position::handler(ctx, worst_price_in_ticks, max_base_lots)
    }

    /// Arm a stop-loss or take-profit. Sits off-book, reserves no margin, and
    /// is reduce-only when it fires.
    pub fn place_trigger_order(
        ctx: Context<PlaceTriggerOrder>,
        trigger_id: u64,
        trigger_price: u64,
        direction: TriggerDirection,
        limit_price_in_ticks: u64,
        max_base_lots: u64,
    ) -> Result<()> {
        instructions::trigger_order::place(
            ctx,
            trigger_id,
            trigger_price,
            direction,
            limit_price_in_ticks,
            max_base_lots,
        )
    }

    /// Cancel an armed trigger and reclaim its rent.
    pub fn cancel_trigger_order(ctx: Context<CancelTriggerOrder>) -> Result<()> {
        instructions::trigger_order::cancel(ctx)
    }

    /// Fire an armed trigger. Permissionless — a stop-loss is worthless if it
    /// depends on its owner being online. Pair with `close_position` in the
    /// same transaction.
    pub fn fire_trigger_order(ctx: Context<FireTriggerOrder>) -> Result<()> {
        instructions::trigger_order::fire(ctx)
    }

    /// Amend a resting order. Shrinking at the same price keeps queue
    /// position; growing or repricing requeues, because both are new claims on
    /// the book and time priority would otherwise be decorative.
    pub fn modify_order(
        ctx: Context<ModifyOrder>,
        side: Side,
        client_order_id: u64,
        new_price_in_ticks: u64,
        new_base_lots: u64,
    ) -> Result<()> {
        instructions::modify_order::handler(
            ctx,
            side,
            client_order_id,
            new_price_in_ticks,
            new_base_lots,
        )
    }

    /// Rollup: cancel one of your resting orders.
    pub fn cancel_order(
        ctx: Context<CancelOrder>,
        side: Side,
        client_order_id: u64,
    ) -> Result<()> {
        instructions::cancel_order::handler(ctx, side, client_order_id)
    }

    /// Rollup: checkpoint book state to base chain.
    pub fn commit_book(ctx: Context<CommitBook>) -> Result<()> {
        instructions::commit_book::commit_handler(ctx)
    }

    /// Rollup: commit and return the book to base chain.
    pub fn commit_and_undelegate_book(ctx: Context<CommitBook>) -> Result<()> {
        instructions::commit_book::commit_and_undelegate_handler(ctx)
    }
}
