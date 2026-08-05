//! # Anqa
//!
//! A perpetuals DEX whose order book lives inside a Private Ephemeral Rollup.
//!
//! The book is a Phoenix-style central limit order book — strict price-time
//! priority, FIFO order identifiers, crankless execution — delegated into a
//! rollup and marked private, so the book account is not served to callers
//! outside its permission set. What the public sees instead is the depth
//! mirror (aggregate size per price, no owners) and the fill tape.
//!
//! **What that is and is not.** Concealment here is a read filter at RPC
//! ingress, enforced by the validator's query filtering service against an
//! ephemeral permission record. Orders are stored as plaintext; they are
//! withheld, not encrypted. The operator running the validator executes the
//! matching code and therefore sees every resting order, its owner and its
//! queue position in the clear. The trust model is a venue's, bounded later by
//! attestation — not a cryptographic one. Nothing in this program verifies an
//! enclave quote.
//!
//! Within that model, a trader may additionally mark an order `hidden`, which
//! withholds it from the depth mirror while leaving its priority, its matching
//! and its tape print untouched.
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

declare_id!("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");

#[ephemeral]
#[program]
pub mod anqa_core {
    use super::*;

    /// Base layer: create a market and its empty book.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        group_id: u64,
        asset_index: u32,
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
            group_id,
            asset_index,
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

    /// Rollup: permissionless portfolio checkpoint to base — a commit is a
    /// truthful snapshot and can only help the owner. Keeper slow tick.
    pub fn checkpoint_portfolio(ctx: Context<CheckpointPortfolio>) -> Result<()> {
        instructions::commit_portfolio::checkpoint_handler(ctx)
    }

    /// Rollup: checkpoint the risk group to base, keeping the rollup. The
    /// keeper's slow tick — bounds what an unplanned undelegation can lose.
    pub fn commit_risk_group(ctx: Context<UndelegateRiskGroup>) -> Result<()> {
        instructions::undelegate_risk::commit_group_handler(ctx)
    }

    /// Rollup: checkpoint the slabs to base, keeping the rollup.
    pub fn commit_asset_slots(ctx: Context<UndelegateAssetSlots>) -> Result<()> {
        instructions::undelegate_risk::commit_slots_handler(ctx)
    }

    /// Rollup: commit the risk group and return it to base. Run this before
    /// `undelegate_asset_slots`; see the module doc for why they're separate.
    pub fn undelegate_risk_group(ctx: Context<UndelegateRiskGroup>) -> Result<()> {
        instructions::undelegate_risk::group_handler(ctx)
    }

    /// Rollup: commit the slabs and return them to base — the second half of
    /// bringing the risk engine home for base-layer maintenance
    /// (`fund_insurance`) or escape.
    pub fn undelegate_asset_slots(ctx: Context<UndelegateAssetSlots>) -> Result<()> {
        instructions::undelegate_risk::slots_handler(ctx)
    }

    /// Base layer: create or grow the slabs' delegation buffer toward full
    /// size, one 10KB step per transaction. Must reach full size before
    /// `delegate_asset_slots` can run.
    pub fn prepare_asset_slots_buffer(
        ctx: Context<PrepareAssetSlotsBuffer>,
        market_id: u64,
    ) -> Result<()> {
        instructions::delegate_asset_slots::prepare_handler(ctx, market_id)
    }

    /// Base layer: create or grow the asset-slots account toward its full
    /// size, one 10KB step per transaction. Must reach full size before
    /// `initialize_risk` can run.
    pub fn prepare_asset_slots(
        ctx: Context<PrepareAssetSlots>,
        market_id: u64,
    ) -> Result<()> {
        instructions::prepare_asset_slots::handler(ctx, market_id)
    }

    /// Base layer: stand up the risk engine for a market group.
    pub fn initialize_risk(
        ctx: Context<InitializeRisk>,
        market_id: u64,
        asset_count: u32,
    ) -> Result<()> {
        instructions::initialize_risk::handler(ctx, market_id, asset_count)
    }

    /// Move the depth mirror into the rollup, where the book it mirrors is.
    /// Create the venue's own monotonic clock. Run on base, before delegation.
    pub fn initialize_venue_clock(
        ctx: Context<InitializeVenueClock>,
        group_id: u64,
    ) -> Result<()> {
        instructions::initialize_venue_clock::handler(ctx, group_id)
    }

    /// Send the clock into the rollup with the risk group it belongs to.
    pub fn delegate_venue_clock(
        ctx: Context<DelegateVenueClock>,
        group_id: u64,
    ) -> Result<()> {
        instructions::initialize_venue_clock::delegate_handler(ctx, group_id)
    }

    pub fn delegate_depth(ctx: Context<DelegateDepth>, market_id: u64) -> Result<()> {
        instructions::delegate_depth::handler(ctx, market_id)
    }

    /// Rollup: make the book unreadable from outside. This is the
    /// instruction that actually creates the dark book — see `set_private`.
    pub fn set_book_private(
        ctx: Context<SetBookPrivate>,
        market_id: u64,
        members: Vec<PermissionMemberArg>,
    ) -> Result<()> {
        instructions::set_private::book_handler(ctx, market_id, members)
    }

    /// Rollup: hide a trader's own position, entry and liquidation price.
    pub fn set_portfolio_private(
        ctx: Context<SetPortfolioPrivate>,
        members: Vec<PermissionMemberArg>,
    ) -> Result<()> {
        instructions::set_private::portfolio_handler(ctx, members)
    }

    /// Base layer: create the book's public depth mirror.
    pub fn initialize_depth(ctx: Context<InitializeDepth>, market_id: u64) -> Result<()> {
        instructions::publish_depth::initialize_handler(ctx, market_id)
    }

    /// Rollup: refresh the depth mirror from the book. Permissionless — it
    /// publishes totals per price level and never who placed them.
    pub fn publish_depth(ctx: Context<PublishDepth>) -> Result<()> {
        instructions::publish_depth::publish_handler(ctx)
    }

    /// Base layer: create a trader's private mirror of their own resting
    /// orders. The book is unreadable to them by design, so this is how a
    /// trader sees what they left on it.
    pub fn initialize_trader_orders(
        ctx: Context<InitializeTraderOrders>,
        market_id: u64,
    ) -> Result<()> {
        instructions::trader_orders::initialize_handler(ctx, market_id)
    }

    /// Base layer: record who may read a trader's order mirror. Must run
    /// before delegation and before the rollup-side hide — the ephemeral
    /// permission extends this record rather than creating one.
    pub fn create_trader_orders_permission(
        ctx: Context<CreateTraderOrdersPermission>,
        market_id: u64,
    ) -> Result<()> {
        instructions::trader_orders::create_permission_handler(ctx, market_id)
    }

    /// Delegate a trader's order mirror into the rollup, beside the book it
    /// projects.
    pub fn delegate_trader_orders(
        ctx: Context<DelegateTraderOrders>,
        market_id: u64,
    ) -> Result<()> {
        instructions::trader_orders::delegate_handler(ctx, market_id)
    }

    /// Hide a trader's order mirror from everyone but its owner. Without this
    /// the mirrors would collectively undo the dark book.
    /// Permissionless: the member list is fixed by the program to the owner
    /// and the venue engine, so a caller gains nothing by driving it — which
    /// is what lets the engine provision mirrors without a trader signature.
    pub fn set_trader_orders_private(ctx: Context<SetTraderOrdersPrivate>) -> Result<()> {
        instructions::trader_orders::set_private_handler(ctx)
    }

    /// Rollup: rebuild one trader's mirror from the book. Permissionless —
    /// the seeds fix whose rows are copied, and the caller cannot read the
    /// account they just wrote.
    pub fn publish_trader_orders(ctx: Context<PublishTraderOrders>) -> Result<()> {
        instructions::trader_orders::publish_handler(ctx)
    }

    /// Base layer: create the collateral vault. Never delegated to the rollup.
    pub fn initialize_vault(ctx: Context<InitializeVault>, market_id: u64) -> Result<()> {
        instructions::initialize_vault::handler(ctx, market_id)
    }

    /// Base layer: create the deposit ledger, empty. Must exist before any
    /// deposit — it is the permanent record the rollup reads.
    pub fn initialize_ledger(ctx: Context<InitializeLedger>) -> Result<()> {
        instructions::initialize_ledger::handler(ctx)
    }

    /// Move the portfolio into the rollup. Session-based: the trader chooses when
    /// their state goes in and when it comes home.
    pub fn delegate_portfolio(ctx: Context<DelegatePortfolio>, market_id: u64) -> Result<()> {
        instructions::delegate_portfolio::handler(ctx, market_id)
    }

    /// Checkpoint the portfolio to base layer without leaving the rollup.
    pub fn commit_portfolio(ctx: Context<CommitPortfolio>) -> Result<()> {
        instructions::commit_portfolio::handler(ctx)
    }

    /// Commit and return the portfolio to base layer.
    pub fn undelegate_portfolio(ctx: Context<CommitPortfolio>) -> Result<()> {
        instructions::undelegate_portfolio::handler(ctx)
    }

    /// Base layer: open a margin account. This is also the trader's seat.
    pub fn open_portfolio(ctx: Context<OpenPortfolio>) -> Result<()> {
        instructions::open_portfolio::handler(ctx)
    }

    /// Base layer: deposit collateral. One of only two instructions that move
    /// tokens. With `queue_claim` a deposit receipt is delegated to the rollup
    /// with `claim_deposit` queued behind it, so deposit → credited is one
    /// signature; the receipt then closes itself via `close_deposit_receipt`.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, queue_claim: bool) -> Result<()> {
        instructions::deposit::handler(ctx, amount, queue_claim)
    }

    /// Base layer: close a landed deposit receipt, rent back to the trader.
    /// Signerless — dispatched by the validator, retryable by anyone.
    pub fn close_deposit_receipt(ctx: Context<CloseDepositReceipt>) -> Result<()> {
        instructions::close_deposit_receipt::handler(ctx)
    }

    /// Promote proven-backed profit from junior `pnl` into withdrawable
    /// `capital`. Without this a winner can close a profitable position and
    /// still be unabl
    /// e to take the profit home. Permissionless.
    pub fn realize_pnl(ctx: Context<RealizePnl>) -> Result<()> {
        instructions::realize_pnl::handler(ctx)
    }

    /// Rollup: liquidate a position against its OWN collateral — isolated
    /// margin's enforcement. Permissionless; refuses while the position's own
    /// margin survives. The account-level `liquidate` is the backstop.
    pub fn liquidate_isolated<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClosePosition<'info>>,
        worst_price_in_ticks: u64,
    ) -> Result<()> {
        instructions::close_position::liquidate_isolated_handler(ctx, worst_price_in_ticks)
    }

    /// Base layer: withdraw collateral. Requires a flat account — the kernel
    /// will not release funds out from under an open position.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Credit a portfolio with deposits recorded on the base-layer ledger.
    /// Runs wherever the portfolio lives; idempotent via its high-water mark.
    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::claim_deposit::handler(ctx)
    }

    /// Base layer: reserve collateral, open a withdrawal receipt, and delegate
    /// it to the rollup. With `queue_authorize` the validator dispatches the
    /// rollup leg itself; without it a keeper (or the client) drives it.
    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        amount: u64,
        queue_authorize: bool,
    ) -> Result<()> {
        instructions::request_withdraw::handler(ctx, amount, queue_authorize)
    }

    /// Rollup: let the risk engine judge the request, write the verdict into
    /// the receipt, and send it home with the settle queued behind it.
    pub fn authorize_withdraw(ctx: Context<AuthorizeWithdraw>) -> Result<()> {
        instructions::authorize_withdraw::handler(ctx)
    }

    /// Base layer: pay out a settled receipt and release the reservation.
    /// Signerless — dispatched by the validator, retryable by anyone.
    pub fn settle_withdraw(ctx: Context<SettleWithdraw>) -> Result<()> {
        instructions::settle_withdraw::handler(ctx)
    }

    /// Base layer: settle a trader out against the last committed state of
    /// their portfolio — the non-custodial escape hatch. Owner-signed always;
    /// permissionless while the market is paused.
    pub fn forced_exit(ctx: Context<ForceExit>) -> Result<()> {
        instructions::forced_exit::handler(ctx)
    }

    /// Rollup, once per asset after delegation: jump the accrual clock into
    /// the rollup's slot domain. Kernel-gated to empty markets, so it can
    /// never skip funding or hide losses. Permissionless.
    pub fn reanchor_oracle(ctx: Context<ReanchorOracle>, asset_index: u32) -> Result<()> {
        instructions::reanchor_oracle::handler(ctx, asset_index)
    }

    /// Activate one more asset in an existing group — cross-margin markets
    /// after the first, each priced by its own oracle.
    pub fn activate_asset(ctx: Context<ActivateAsset>) -> Result<()> {
        instructions::activate_asset::handler(ctx)
    }

    /// Expire a lapsed source-backing bucket. Permissionless maintenance:
    /// without it, one expired bucket wedges every refresh in its domain.
    pub fn sweep_backing(ctx: Context<SweepBacking>, domain: u32) -> Result<()> {
        instructions::sweep_backing::handler(ctx, domain)
    }

    /// Owner grants (or renews) a browser-held session key: one wallet
    /// signature, then popup-free trading until expiry.
    pub fn grant_session(
        ctx: Context<GrantSession>,
        session_key: Pubkey,
        duration_secs: i64,
    ) -> Result<()> {
        instructions::grant_session::grant(ctx, session_key, duration_secs)
    }

    /// Owner kills the grant early. Base-layer, so it never depends on the
    /// session key's cooperation.
    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        instructions::grant_session::revoke(ctx)
    }

    /// Base layer: create the public fill tape — the one account in the dark
    /// set the whole world may read.
    pub fn initialize_tape(ctx: Context<InitializeTape>, market_id: u64) -> Result<()> {
        instructions::initialize_tape::handler(ctx, market_id)
    }

    /// Base layer, admin: flip a market between lit and dark matching.
    pub fn set_dark(ctx: Context<SetDark>, dark: bool) -> Result<()> {
        instructions::set_dark::handler(ctx, dark)
    }

    /// Rollup: settle the oldest pending fill on a dark market through the
    /// risk kernel and print it to the public tape. Strictly FIFO; driven by
    /// the engine keeper, callable by anyone.
    pub fn settle_fill(ctx: Context<SettleFill>) -> Result<()> {
        instructions::settle_fill::handler(ctx)
    }

    /// Base layer, admin: permission the book — on a TEE validator only the
    /// listed members (the engine) can read it. The program signs for the
    /// book PDA.
    pub fn create_book_permission(
        ctx: Context<CreateBookPermission>,
        market_id: u64,
        members: Vec<PermissionMember>,
    ) -> Result<()> {
        instructions::create_book_permission::handler(ctx, market_id, members)
    }

    /// Base layer, trader: permission your portfolio — on a TEE validator
    /// only you and the members you list (the engine) can read it.
    pub fn create_portfolio_permission(
        ctx: Context<CreatePortfolioPermission>,
        market_id: u64,
        members: Vec<PermissionMember>,
    ) -> Result<()> {
        instructions::create_portfolio_permission::handler(ctx, market_id, members)
    }

    // ── delegation: one instruction per account, so each seed validation gets
    //    its own stack frame. All five must run before the first rollup trade.

    pub fn delegate_book(ctx: Context<DelegateBook>, market_id: u64) -> Result<()> {
        instructions::delegate_book::handler(ctx, market_id)
    }

    pub fn delegate_market_config(
        ctx: Context<DelegateMarketConfig>,
        market_id: u64,
    ) -> Result<()> {
        instructions::delegate_market_config::handler(ctx, market_id)
    }

    pub fn delegate_risk_group(ctx: Context<DelegateRiskGroup>, market_id: u64) -> Result<()> {
        instructions::delegate_risk_group::handler(ctx, market_id)
    }

    pub fn delegate_asset_slots(ctx: Context<DelegateAssetSlots>, market_id: u64) -> Result<()> {
        instructions::delegate_asset_slots::handler(ctx, market_id)
    }

    pub fn delegate_internal_oracle(
        ctx: Context<DelegateInternalOracle>,
        market_id: u64,
    ) -> Result<()> {
        instructions::delegate_internal_oracle::handler(ctx, market_id)
    }

    pub fn delegate_oracle_state(
        ctx: Context<DelegateOracleState>,
        market_id: u64,
    ) -> Result<()> {
        instructions::delegate_oracle_state::handler(ctx, market_id)
    }

    pub fn delegate_tape(ctx: Context<DelegateTape>, market_id: u64) -> Result<()> {
        instructions::delegate_tape::handler(ctx, market_id)
    }

    /// Place an order. Crosses the resting book, then rests the remainder; every
    /// fill is handed to the risk kernel, which may refuse it.
    ///
    /// `hidden` withholds whatever rests from the published depth mirror. It
    /// changes nothing else: the order keeps its price-time place in the same
    /// queue, crosses on the same terms, and prints to the same public tape
    /// when it fills. Dark markets only.
    ///
    /// `remaining_accounts`: one `Portfolio` per maker this order may cross.
    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
        side: Side,
        order_type: OrderType,
        price_in_ticks: u64,
        base_lots: u64,
        client_order_id: u64,
        collateral_usd: u128,
        hidden: bool,
    ) -> Result<()> {
        instructions::place_order::handler(
            ctx,
            side,
            order_type,
            price_in_ticks,
            base_lots,
            client_order_id,
            collateral_usd,
            hidden,
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
    pub fn crank(ctx: Context<Crank>, asset_index: u32, funding_rate_e9: i128) -> Result<()> {
        instructions::crank::handler(ctx, asset_index, funding_rate_e9)
    }

    /// Settle one account against the latest accrual.
    pub fn refresh_portfolio(ctx: Context<RefreshPortfolio>) -> Result<()> {
        instructions::refresh_portfolio::handler(ctx)
    }

    /// Create the protocol vault — venue revenue, held apart from both trader
    /// collateral and insurance.
    pub fn initialize_protocol_vault(
        ctx: Context<InitializeProtocolVault>,
        market_id: u64,
        insurance_target_bps: u16,
        post_target_insurance_bps: u16,
    ) -> Result<()> {
        instructions::initialize_protocol_vault::handler(
            ctx,
            market_id,
            insurance_target_bps,
            post_target_insurance_bps,
        )
    }

    /// Collect accrued protocol revenue. Cannot reach collateral or insurance.
    pub fn collect_fees(ctx: Context<CollectFees>, amount: u64) -> Result<()> {
        instructions::collect_protocol_fees::handler(ctx, amount)
    }

    /// Create the insurance vault — layer 2 of the loss waterfall, held apart
    /// from custody so it cannot be paid out as trader collateral.
    pub fn initialize_insurance_vault(
        ctx: Context<InitializeInsuranceVault>,
        market_id: u64,
    ) -> Result<()> {
        instructions::initialize_insurance_vault::handler(ctx, market_id)
    }

    /// Fund an asset's insurance, long and short domains separately.
    /// Permissionless — anyone may strengthen the backstop.
    pub fn fund_insurance(
        ctx: Context<FundInsurance>,
        asset_index: u32,
        long_amount: u64,
        short_amount: u64,
    ) -> Result<()> {
        instructions::fund_insurance::handler(ctx, asset_index, long_amount, short_amount)
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
        instructions::cancel_all::handler(ctx)
    }

    /// Pull only quotes at or more aggressive than a price, leaving the passive
    /// remainder working. The everyday risk tool for a maker.
    pub fn cancel_up_to(
        ctx: Context<CancelBulk>,
        side: Side,
        price_in_ticks: u64,
    ) -> Result<()> {
        instructions::cancel_up_to::handler(ctx, side, price_in_ticks)
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
        instructions::place_trigger_order::handler(
            ctx,
            trigger_id,
            trigger_price,
            direction,
            limit_price_in_ticks,
            max_base_lots,
        )
    }

    /// Disarm a trigger slot.
    pub fn cancel_trigger_order(ctx: Context<CancelTriggerOrder>, trigger_id: u64) -> Result<()> {
        instructions::cancel_trigger_order::handler(ctx, trigger_id)
    }

    /// Fire an armed trigger. Permissionless — a stop-loss is worthless if it
    /// depends on its owner being online. Pair with `close_position` in the
    /// same transaction.
    pub fn fire_trigger_order(ctx: Context<FireTriggerOrder>, trigger_id: u64) -> Result<()> {
        instructions::fire_trigger_order::handler(ctx, trigger_id)
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
        instructions::commit_book::handler(ctx)
    }

    /// Rollup: commit and return the book to base chain.
    pub fn commit_and_undelegate_book(ctx: Context<CommitBook>) -> Result<()> {
        instructions::undelegate_book::handler(ctx)
    }
}
