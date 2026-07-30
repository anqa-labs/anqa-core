//! Auto-deleveraging — layer four, and the one nobody wants to reach.
//!
//! When counterparty collateral, insurance, and haircutting winners' unrealised
//! gains have all failed to clear a bankruptcy, the only remaining way to keep
//! the book solvent is to **force-close profitable positions on the opposite
//! side** at the bankruptcy price.
//!
//! It costs the protocol nothing and costs the trader everything they were about
//! to earn. Being deleveraged out of a position you called correctly, because
//! somebody *else* blew up, is the single most resented thing a perps venue can
//! do — which is why every layer above exists, and why a thin insurance fund is
//! a user-experience problem long before it is a solvency one.
//!
//! Two properties keep it defensible:
//!
//! - **Permissionless.** Anyone may run it. A venue whose solvency depends on
//!   the operator being awake is not solvent, it is supervised.
//! - **Bounded.** The caller names how much to reduce and the kernel reduces no
//!   more than the position and the shortfall require. A keeper cannot use ADL
//!   to close a position that did not need closing.
//!
//! Every invocation emits an event, because a venue that deleverages quietly
//! deserves the reputation it will get.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, RebalanceRequestV16, POS_SCALE};

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, Portfolio, RiskGroup};

#[event]
pub struct AutoDeleveraged {
    pub market_id: u64,
    pub asset_index: u32,
    pub account: Pubkey,
    pub reduced_base_lots: u64,
}

#[derive(Accounts)]
pub struct Adl<'info> {
    /// Permissionless.
    pub keeper: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// The profitable account being deleveraged.
    #[account(mut)]
    pub portfolio: AccountLoader<'info, Portfolio>,
}

pub fn handler(ctx: Context<Adl>, asset_index: u32, reduce_base_lots: u64) -> Result<()> {
    require!(reduce_base_lots > 0, AnqaError::InvalidSize);

    let market_id = ctx.accounts.market.market_id;
    let account_key = ctx.accounts.portfolio.key();

    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    require!((asset_index as usize) < n_assets, AnqaError::BadAssetIndex);
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut pf = ctx.accounts.portfolio.load_mut()?;

    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
    let mut pv = PortfolioV16ViewMut::new(pf.account_mut());

    let reduce_q = (reduce_base_lots as u128)
        .checked_mul(POS_SCALE)
        .ok_or(AnqaError::MathOverflow)?;

    // The kernel refuses if this account is not actually eligible, so a keeper
    // cannot deleverage someone who simply happens to be winning.
    let outcome = map_risk(view.rebalance_reduce_position_not_atomic(
        &mut pv,
        RebalanceRequestV16 {
            asset_index: asset_index as usize,
            reduce_q,
        },
    ))?;

    let reduced_lots = u64::try_from(outcome.reduced_q / POS_SCALE).unwrap_or(0);

    // If deleveraging closed the position entirely, its triggers go too — an
    // orphaned stop attaches to the trader's next position.
    if pf.current_position(asset_index).is_none() {
        pf.clear_asset_triggers(asset_index as u8);
    }

    emit!(AutoDeleveraged {
        market_id,
        asset_index,
        account: account_key,
        reduced_base_lots: reduced_lots,
    });
    msg!(
        "anqa: ADL reduced {} lots on asset {} — insurance and haircut were exhausted",
        reduced_lots,
        asset_index
    );
    Ok(())
}
