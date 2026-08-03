//! Activate one more asset in an existing risk group.
//!
//! Cross-margin means one group carries many markets, but the kernel takes
//! its assets one per slot-cooldown: `initialize_risk` activates asset 0 and
//! every further market activates here, in its own transaction, priced by
//! its own oracle — not even the authority chooses an opening mark.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{ASSET_SLOTS_SEED, MARKET_SEED, MAX_ASSETS, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{read_pyth, AssetSlots, Market, RiskGroup};

#[derive(Accounts)]
pub struct ActivateAsset<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.group_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.group_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    pub price_update: Account<'info, PriceUpdateV2>,
}

pub fn handler(ctx: Context<ActivateAsset>) -> Result<()> {
    let m = &ctx.accounts.market;
    let asset_index = m.asset_index;
    require!((asset_index as usize) < MAX_ASSETS, AnqaError::BadAssetIndex);

    let opening_mark = read_pyth(
        &ctx.accounts.price_update,
        &m.oracle.feed_id,
        m.oracle.max_age_secs,
        m.oracle.max_conf_bps,
    )?
    .to_quote_atoms(m.quote_decimals)?;

    let slot = Clock::get()?.slot;
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let header = group.header_mut();
    let engine = &mut slots.markets_mut()[asset_index as usize].engine;
    map_risk(header.activate_empty_asset_slot_not_atomic(
        asset_index,
        engine,
        opening_mark,
        slot,
    ))?;

    msg!(
        "anqa: asset {} activated in group {} at mark {}",
        asset_index,
        m.group_id,
        opening_mark
    );
    Ok(())
}
