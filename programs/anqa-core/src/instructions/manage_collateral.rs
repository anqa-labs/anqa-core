//! Move collateral behind an existing position — the missing lever of
//! isolated margin.
//!
//! Isolation means a position can only lose what stands behind it
//! (`Portfolio::asset_collateral`). Until now that number was written exactly
//! twice: set by fills, released in full by close or liquidation. A trader
//! watching their liquidation price approach had no remedy short of adding
//! size or closing — the one thing isolated margin exists to let you do,
//! re-margining a live position, was missing.
//!
//! Two instructions, one accounts shape, no tokens moved (like fills, this is
//! bookkeeping between pools the portfolio already holds):
//!
//!   * `add_collateral`    — commit free equity behind the position. Checked
//!     against `free_for_commit`, the strict measure that counts what is
//!     already committed across assets, so equity cannot be committed twice.
//!   * `remove_collateral` — take excess back out. With a position open the
//!     remainder plus unrealised PnL must still clear **initial** margin at
//!     the live mark — the same price liquidation trusts — so a removal can
//!     never hand the liquidator a position it just made eligible. Flat slots
//!     (collateral stranded by cancelled orders) can be drained freely.
//!
//! Both run inside the rollup where the portfolio lives, signed by the owner
//! or a granted session key — the same authority that could place the order.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, POS_SCALE};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, ORACLE_STATE_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::instructions::initialize_risk::INITIAL_MARGIN_BPS;
use crate::state::{AssetSlots, Market, OracleState, Portfolio, RiskGroup};

#[event]
pub struct CollateralAdded {
    pub market_id: u64,
    pub owner: Pubkey,
    pub asset_index: u32,
    pub amount: u128,
    pub total: u128,
}

#[event]
pub struct CollateralRemoved {
    pub market_id: u64,
    pub owner: Pubkey,
    pub asset_index: u32,
    pub amount: u128,
    pub total: u128,
}

#[derive(Accounts)]
pub struct ManageCollateral<'info> {
    /// The portfolio owner, or a session key the owner granted.
    pub trader: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    /// Present when a session key signs for the owner. Checked in the handler
    /// via `trade_authorized`, like `place_order`.
    pub session: Option<Account<'info, crate::state::TradeSession>>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.group_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.group_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// Read for `remove_collateral`'s margin check; never written. Removal
    /// prices the position at the same guarded mark liquidation uses.
    #[account(seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    #[account(
        mut,
        constraint = portfolio.load()?.market_id == market.group_id.to_le_bytes() @ AnqaError::NotOrderOwner
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

/// Owner-or-session authority, resolved against the owner recorded in the
/// portfolio rather than the signer, exactly as trading does.
fn authorize(ctx: &Context<ManageCollateral>) -> Result<()> {
    let owner = ctx.accounts.portfolio.load()?.owner;
    require!(
        crate::state::trade_authorized(
            owner,
            ctx.accounts.market.market_id,
            ctx.accounts.trader.key(),
            ctx.accounts.session.as_ref(),
        )?,
        AnqaError::NotOrderOwner
    );
    Ok(())
}

/// Settle the account against the latest accrual so `certified` (and with it
/// `free_for_commit`) speaks about now, not about the last time anything
/// touched this portfolio.
fn refresh(ctx: &Context<ManageCollateral>) -> Result<()> {
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let now_slot = group.header().current_slot.get();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut portfolio = ctx.accounts.portfolio.load_mut()?;
    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    // Same inline sweep as settle_fill/place_order, same reason: a refresh
    // refuses (`Stale`) while any domain the account touches holds a lapsed
    // backing bucket, and a keeper-driven sweep loses that race. Done here
    // against the same header clock, the race cannot exist.
    for domain in 0..n_assets * 2 {
        let _ = view.expire_source_backing_bucket_not_atomic(domain, now_slot);
    }
    let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());
    map_risk(view.full_account_refresh_not_atomic(&mut pv))?;
    Ok(())
}

pub fn add_handler(ctx: Context<ManageCollateral>, amount: u128) -> Result<()> {
    require!(amount > 0, AnqaError::ZeroCollateralAmount);
    authorize(&ctx)?;
    refresh(&ctx)?;

    let asset_index = ctx.accounts.market.asset_index;
    let mut pf = ctx.accounts.portfolio.load_mut()?;

    // Adding margin to nothing is a footgun, not a feature: with no position
    // the commitment buys no protection and only strands free equity.
    require!(
        pf.current_position(asset_index).is_some(),
        AnqaError::NoOpenPosition
    );
    require!(
        amount <= pf.free_for_commit()?,
        AnqaError::InsufficientFreeCollateral
    );

    pf.add_collateral(asset_index, amount);
    let total = pf.collateral_of(asset_index);
    let owner = pf.owner;
    drop(pf);

    emit!(CollateralAdded {
        market_id: ctx.accounts.market.market_id,
        owner,
        asset_index,
        amount,
        total,
    });
    Ok(())
}

pub fn remove_handler(ctx: Context<ManageCollateral>, amount: u128) -> Result<()> {
    // Adding margin is allowed even on a paused market — it only reduces risk.
    // Taking it out is not.
    require!(!ctx.accounts.market.paused, AnqaError::MarketPaused);
    require!(amount > 0, AnqaError::ZeroCollateralAmount);
    authorize(&ctx)?;
    refresh(&ctx)?;

    let market = &ctx.accounts.market;
    let asset_index = market.asset_index;
    let mut pf = ctx.accounts.portfolio.load_mut()?;

    let committed = pf.collateral_of(asset_index);
    require!(amount <= committed, AnqaError::RemovalExceedsCommitted);

    if let Some((is_long, size_q)) = pf.current_position(asset_index) {
        // Same arithmetic as `isolated_underwater`, held to the *initial*
        // requirement instead of maintenance: what remains must be enough to
        // have opened the position, not merely enough to not be liquidated.
        let mark = ctx.accounts.oracle_state.live_mark(&market.oracle)? as u128;
        let lots = size_q / POS_SCALE;
        let entry = pf.entry_of(asset_index);
        let remaining = committed - amount;
        let pnl: i128 = if is_long {
            (mark as i128 - entry as i128) * lots as i128
        } else {
            (entry as i128 - mark as i128) * lots as i128
        };
        let initial = mark
            .saturating_mul(lots)
            .saturating_mul(INITIAL_MARGIN_BPS as u128)
            / 10_000u128;
        require!(
            remaining > 0 && remaining as i128 + pnl >= initial as i128,
            AnqaError::CollateralRemovalUnsafe
        );
    }
    // Flat slot: collateral stranded by an order that never filled (or was
    // cancelled after committing). Nothing stands behind it, so it drains
    // freely back to the account's pool.

    pf.remove_collateral(asset_index, amount);
    let total = pf.collateral_of(asset_index);
    let owner = pf.owner;
    drop(pf);

    emit!(CollateralRemoved {
        market_id: market.market_id,
        owner,
        asset_index,
        amount,
        total,
    });
    Ok(())
}
