//! Advance the risk engine: mark price and funding.
//!
//! Cadence is a solvency parameter, not an ops detail. The kernel refuses any
//! configuration where maintenance margin cannot cover the worst case between
//! accruals, which is why Anqa's 20x launch cap pins the mark to at most 1%
//! movement per crank. Miss cranks during a fast move and the shortfall becomes
//! bad debt against the vault rather than the trader's collateral.
//!
//! The mark price comes from **Pyth**, never from the caller. A cranker that
//! could name its own price could mark every position wherever it liked and
//! liquidate at will; the signer here is untrusted and permissionless by design.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, ORACLE_STATE_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{accept_mark, read_pyth, AssetSlots, Market, OracleState, Portfolio, RiskGroup};

#[derive(Accounts)]
pub struct Crank<'info> {
    /// Permissionless — anyone may advance the market. They supply no prices,
    /// only the transaction.
    pub cranker: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(mut, seeds = [ORACLE_STATE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub oracle_state: Account<'info, OracleState>,

    /// Pyth price update. The feed id is checked against the market's own, so a
    /// caller cannot substitute a cheaper asset's oracle.
    pub price_update: Account<'info, PriceUpdateV2>,
    // remaining_accounts: optional secondary PriceUpdateV2 for cross-checking.
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Crank<'info>>,
    asset_index: u32,
    funding_rate_e9: i128,
) -> Result<()> {
    require!(
        (asset_index as usize) < crate::constants::MAX_ASSETS,
        AnqaError::BadAssetIndex
    );

    let market = &ctx.accounts.market;
    let primary = read_pyth(
        &ctx.accounts.price_update,
        &market.oracle.feed_id,
        market.oracle.max_age_secs,
        market.oracle.max_conf_bps,
    )?;

    // Optional second source. When configured, the two must agree or the
    // breaker trips — disagreement means one is wrong and we cannot tell which.
    let secondary = if market.oracle.secondary_feed_id != [0u8; 32] {
        let sec_ai = ctx
            .remaining_accounts
            .first()
            .ok_or(AnqaError::OracleUnavailable)?;
        let sec: Account<PriceUpdateV2> = Account::try_from(sec_ai)?;
        Some(read_pyth(
            &sec,
            &market.oracle.secondary_feed_id,
            market.oracle.max_age_secs,
            market.oracle.max_conf_bps,
        )?)
    } else {
        None
    };

    let mark_price = accept_mark(
        &mut ctx.accounts.oracle_state,
        &market.oracle,
        primary,
        secondary,
        market.quote_decimals,
    )?;
    let ema = ctx.accounts.oracle_state.ema_price;

    let slot = Clock::get()?.slot;
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

    map_risk(view.accrue_asset_to_not_atomic(
        asset_index as usize,
        slot,
        mark_price,
        funding_rate_e9,
        true,
    ))?;

    msg!(
        "anqa: crank -> mark {} (ema {}) funding {}",
        mark_price,
        ema,
        funding_rate_e9
    );
    Ok(())
}

/// Settle one account against the latest accrual: funding paid or received,
/// losses booked, health certificate refreshed.
#[derive(Accounts)]
pub struct RefreshPortfolio<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn refresh_handler(ctx: Context<RefreshPortfolio>) -> Result<()> {
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut portfolio = ctx.accounts.portfolio.load_mut()?;

    let mut view = MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    let mut pv = PortfolioV16ViewMut::new(portfolio.account_mut());
    map_risk(view.full_account_refresh_not_atomic(&mut pv))?;

    Ok(())
}
