//! Layout offsets the web client depends on.
//!
//! The terminal decodes a Portfolio's kernel bytes to show a position, and it
//! must not guess at where those fields live. This test prints the offsets and
//! asserts the ones `web/lib/portfolio.ts` has pinned — so a Percolator bump
//! that moves a field fails here rather than silently mis-rendering somebody's
//! position.

use core::mem::{offset_of, size_of};
use percolator::{
    HealthCertV16Account, PortfolioAccountV16Account, PortfolioLegV16Account,
};

#[test]
fn portfolio_offsets_match_the_web_client() {
    let capital = offset_of!(PortfolioAccountV16Account, capital);
    let pnl = offset_of!(PortfolioAccountV16Account, pnl);
    let legs = offset_of!(PortfolioAccountV16Account, legs);
    let cert = offset_of!(PortfolioAccountV16Account, health_cert);
    let leg_stride = size_of::<PortfolioLegV16Account>();
    let leg_active = offset_of!(PortfolioLegV16Account, active);
    let leg_asset = offset_of!(PortfolioLegV16Account, asset_index);
    let leg_side = offset_of!(PortfolioLegV16Account, side);
    let leg_basis = offset_of!(PortfolioLegV16Account, basis_pos_q);
    let cert_equity = offset_of!(HealthCertV16Account, certified_equity);
    let cert_initial = offset_of!(HealthCertV16Account, certified_initial_req);
    let cert_valid = offset_of!(HealthCertV16Account, valid);

    println!("PORTFOLIO_BYTES  {}", size_of::<PortfolioAccountV16Account>());
    println!("capital          {capital}");
    println!("pnl              {pnl}");
    println!("legs             {legs}");
    println!("leg_stride       {leg_stride}");
    println!("leg.active       {leg_active}");
    println!("leg.asset_index  {leg_asset}");
    println!("leg.side         {leg_side}");
    println!("leg.basis_pos_q  {leg_basis}");
    println!("health_cert      {cert}");
    println!("cert.equity      {cert_equity}");
    println!("cert.initial_req {cert_initial}");
    println!("cert.valid       {cert_valid}");

    // Pinned in web/lib/portfolio.ts — keep the two in step.
    assert_eq!(capital, 132, "capital moved");
    assert_eq!(pnl, 148, "pnl moved");
    assert_eq!(leg_active, 0, "leg.active moved");
    assert_eq!(leg_asset, 1, "leg.asset_index moved");
    assert_eq!(leg_side, 13, "leg.side moved");
    assert_eq!(leg_basis, 14, "leg.basis_pos_q moved");
}

#[test]
fn asset_slot_offsets() {
    use percolator::{EngineAssetSlotV16Account, Market as PercMarket};
    type Slot = PercMarket<[u8; 8]>;
    println!("SLOT_STRIDE {}", size_of::<Slot>());
    println!("engine_slot_size {}", size_of::<EngineAssetSlotV16Account>());
    println!("asset_off {}", offset_of!(EngineAssetSlotV16Account, asset));
}

#[test]
fn asset_lifecycle_offset() {
    use percolator::{AssetStateV16Account, EngineAssetSlotV16Account, Market as PercMarket};
    type Slot = PercMarket<[u8; 8]>;
    println!("STRIDE {}", size_of::<Slot>());
    println!("engine_off {}", size_of::<Slot>() - size_of::<EngineAssetSlotV16Account>());
    println!("asset_in_slot {}", offset_of!(EngineAssetSlotV16Account, asset));
    println!("lifecycle_in_asset {}", offset_of!(AssetStateV16Account, lifecycle));
    println!("effective_price_in_asset {}", offset_of!(AssetStateV16Account, effective_price));
    println!("slot_last_in_asset {}", offset_of!(AssetStateV16Account, slot_last));
}

#[test]
fn asset_side_mode_offsets() {
    use percolator::AssetStateV16Account;
    println!("mode_long {}", offset_of!(AssetStateV16Account, mode_long));
    println!("mode_short {}", offset_of!(AssetStateV16Account, mode_short));
    println!("oi_long {}", offset_of!(AssetStateV16Account, oi_eff_long_q));
    println!("oi_short {}", offset_of!(AssetStateV16Account, oi_eff_short_q));
}
