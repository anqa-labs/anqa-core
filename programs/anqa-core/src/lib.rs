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
use state::{OrderType, Side};

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
        pyth_feed_id: [u8; 32],
        max_price_age_secs: u64,
        max_conf_bps: u16,
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
            pyth_feed_id,
            max_price_age_secs,
            max_conf_bps,
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

    /// Advance mark price and funding for an asset. The mark is read from Pyth;
    /// the caller cannot supply a price.
    pub fn crank(ctx: Context<Crank>, asset_index: u32, funding_rate_e9: i128) -> Result<()> {
        instructions::crank::handler(ctx, asset_index, funding_rate_e9)
    }

    /// Settle one account against the latest accrual.
    pub fn refresh_portfolio(ctx: Context<RefreshPortfolio>) -> Result<()> {
        instructions::crank::refresh_handler(ctx)
    }

    /// Liquidate an unhealthy account. Permissionless; refuses while healthy.
    pub fn liquidate(ctx: Context<Liquidate>, asset_index: u32) -> Result<()> {
        instructions::liquidate::handler(ctx, asset_index)
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
