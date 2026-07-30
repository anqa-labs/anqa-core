//! The accrual window has to fit two things at once.
//!
//! It must be **wide enough for the rollup**: MagicBlock devnet produces ~20
//! slots/sec against base chain's ~2.7, and the kernel advances its clock by
//! at most `max_accrual_dt_slots` per crank. Too narrow and the clock never
//! converges — loss staleness stays armed, fills are refused, and (quietly,
//! which is worse) funding under-accrues by whatever factor it is behind.
//!
//! And it must be **narrow enough for the solvency envelope**: the kernel
//! bounds the combined price-and-funding budget of one accrual against
//! maintenance margin, and rejects the configuration outright otherwise.
//!
//! This test pins both ends, so neither a Percolator bump nor a well-meaning
//! parameter tweak can quietly break the venue.

use anqa_core::instructions::initialize_risk::{
    anqa_risk_config, MAX_ACCRUAL_DT_SLOTS, MAX_FUNDING_E9_PER_SLOT,
    MAX_PRICE_MOVE_BPS_PER_SLOT,
};
use percolator::V16Config;

/// Rollup slots per second, measured on MagicBlock devnet 2026-07-30.
const ROLLUP_SLOTS_PER_SEC: u64 = 20;
/// The keeper's crank period. See `app/keeper.ts`.
const CRANK_PERIOD_SECS: u64 = 2;

fn probe(dt: u64) -> V16Config {
    let mut c = V16Config::public_user_fund_with_market_slots(1, 1, 0, 10);
    c.initial_margin_bps = 500;
    c.maintenance_margin_bps = 250;
    c.max_price_move_bps_per_slot = MAX_PRICE_MOVE_BPS_PER_SLOT;
    c.max_accrual_dt_slots = dt;
    c.min_funding_lifetime_slots = dt;
    c.max_abs_funding_e9_per_slot = MAX_FUNDING_E9_PER_SLOT;
    c.liquidation_fee_bps = 0;
    c
}

#[test]
fn the_shipped_risk_config_is_accepted() {
    assert!(
        anqa_risk_config(1).validate_public_user_fund().is_ok(),
        "the kernel rejects Anqa's risk configuration"
    );
}

#[test]
fn the_accrual_window_keeps_up_with_the_rollup() {
    let covered_secs = MAX_ACCRUAL_DT_SLOTS / ROLLUP_SLOTS_PER_SEC;
    assert!(
        covered_secs >= CRANK_PERIOD_SECS,
        "one crank covers {covered_secs}s of rollup time but the keeper cranks \
         every {CRANK_PERIOD_SECS}s — the clock would fall behind for good"
    );
}

#[test]
fn the_accrual_window_stays_inside_the_solvency_envelope() {
    assert!(
        probe(MAX_ACCRUAL_DT_SLOTS)
            .validate_public_user_fund()
            .is_ok(),
        "{MAX_ACCRUAL_DT_SLOTS} slots exceeds the envelope"
    );

    // Report the ceiling, so the headroom is visible when someone tunes this.
    let mut ceiling = 0;
    for dt in 1..=400 {
        if probe(dt).validate_public_user_fund().is_ok() {
            ceiling = dt;
        }
    }
    println!(
        "accrual window: {MAX_ACCRUAL_DT_SLOTS} slots shipped, {ceiling} is the kernel's ceiling \
         ({}s of rollup time)",
        ceiling / ROLLUP_SLOTS_PER_SEC
    );
    assert!(MAX_ACCRUAL_DT_SLOTS <= ceiling);
}
