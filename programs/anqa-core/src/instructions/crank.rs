//! Advance the risk engine: mark price and funding.
//!
//! Cadence is a solvency parameter, not an ops detail. The kernel refuses any
//! configuration where maintenance margin cannot cover the worst case between
//! accruals, which is why Anqa's 20x launch cap pins the mark to at most 1%
//! movement per crank. Miss cranks during a fast move and the shortfall becomes
//! bad debt against the vault rather than the trader's collateral.
//!
//! The mark price comes from the **internal oracle relay**, never from the
//! caller. A cranker that could name its own price could mark every position
//! wherever it liked and liquidate at will; the signer here is untrusted and
//! permissionless by design.
//!
//! It reads the relay rather than Pyth directly because this instruction must
//! run **inside the rollup**, where Pyth's accounts are not delegated to us and
//! cannot be read at all. `sync_internal_oracle` refreshes the relay on base
//! layer, where Pyth's signature is still verifiable; this side re-checks feed
//! identity, staleness and confidence before marking anyone against it.

use anchor_lang::prelude::*;
use percolator::{MarketGroupV16ViewMut, MAX_MARGIN_BPS};

use crate::constants::{
    ASSET_SLOTS_SEED, INTERNAL_ORACLE_SEED, MARKET_SEED, ORACLE_STATE_SEED, RISK_GROUP_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::instructions::initialize_risk::{MAX_ACCRUAL_DT_SLOTS, MAX_PRICE_MOVE_BPS_PER_SLOT};
use crate::state::{
    accept_mark, read_internal, AssetSlots, InternalOracle, Market, OracleState, RiskGroup,
};

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

    /// The relayed price. Delegated into the rollup alongside the book, which is
    /// the only way this instruction can read a price there at all.
    #[account(seeds = [INTERNAL_ORACLE_SEED, &market.market_id.to_le_bytes()], bump)]
    pub internal_oracle: Account<'info, InternalOracle>,
}

pub fn handler(ctx: Context<Crank>, asset_index: u32, funding_rate_e9: i128) -> Result<()> {
    require!(
        (asset_index as usize) < crate::constants::MAX_ASSETS,
        AnqaError::BadAssetIndex
    );

    let market = &ctx.accounts.market;
    let primary = read_internal(
        &ctx.accounts.internal_oracle,
        &market.oracle.feed_id,
        market.oracle.max_age_secs,
        market.oracle.max_conf_bps,
    )?;
    let secondary = None;

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

    // How far the kernel will let the mark travel in this accrual, and where
    // it currently sits. Both are needed *before* the view borrows the slots.
    let (stored_price, budget_bps_x_slots) = {
        let asset = slots.markets()[asset_index as usize].engine.asset;
        (
            asset.effective_price.get(),
            (MAX_PRICE_MOVE_BPS_PER_SLOT as u128)
                .saturating_mul(MAX_ACCRUAL_DT_SLOTS as u128),
        )
    };
    let accrual_price = step_toward(stored_price, mark_price, budget_bps_x_slots);

    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

    map_risk(view.accrue_asset_to_not_atomic(
        asset_index as usize,
        slot,
        accrual_price,
        funding_rate_e9,
        true,
    ))?;

    if accrual_price != mark_price {
        msg!(
            "anqa: crank -> {} of {} (catching up, {} bps/accrual)",
            accrual_price,
            mark_price,
            budget_bps_x_slots
        );
    } else {
        msg!(
            "anqa: crank -> mark {} (ema {}) funding {}",
            mark_price,
            ema,
            funding_rate_e9
        );
    }
    Ok(())
}

/// Move `from` toward `to` by at most the kernel's per-accrual price budget.
///
/// **This is what stops a stalled crank from wedging the market for good.**
/// The kernel refuses an accrual whose price jump exceeds
/// `max_price_move_bps_per_slot x max_accrual_dt_slots` — 1% here — and the
/// refusal is not self-healing: the gap between the stored price and the real
/// one only widens while the crank is down, so every later crank is refused
/// too, and the venue stays frozen until the price happens to wander back.
///
/// Feeding the kernel a clamped price instead converges in a few ticks
/// without ever asking it to accept a jump it considers unsafe. Marks move at
/// most 1% per accrual either way; the only thing that changes is that the
/// venue recovers on its own.
fn step_toward(from: u64, to: u64, budget_bps: u128) -> u64 {
    if from == 0 || from == to {
        return to;
    }
    // Guard the edge the kernel checks: strictly less than the budget.
    let max_move = (from as u128)
        .saturating_mul(budget_bps)
        .saturating_div(MAX_MARGIN_BPS as u128)
        .saturating_sub(1);
    let diff = (from as u128).abs_diff(to as u128);
    if diff <= max_move {
        return to;
    }
    let step = u64::try_from(max_move).unwrap_or(0);
    if to > from {
        from.saturating_add(step)
    } else {
        from.saturating_sub(step)
    }
}

#[cfg(test)]
mod tests {
    use super::step_toward;

    /// 1 bps/slot x 100 slots = 1% of the stored price per accrual.
    const BUDGET: u128 = 100;

    #[test]
    fn a_small_move_is_taken_whole() {
        // 0.1% — well inside the budget, so the mark tracks exactly.
        assert_eq!(step_toward(64_000_000_000, 64_064_000_000, BUDGET), 64_064_000_000);
    }

    #[test]
    fn a_move_past_the_budget_is_clamped_not_refused() {
        // The failure this exists for: the crank stalled, BTC moved ~1.01%,
        // and the kernel would reject the jump outright — permanently, since
        // the gap never shrinks on its own.
        let from = 64_306_180_000u64;
        let to = 63_657_000_000u64;
        let stepped = step_toward(from, to, BUDGET);
        assert!(stepped > to, "must not overshoot the target");
        assert!(stepped < from, "must move toward it");
        // Strictly inside the kernel's gate: diff * 10_000 <= budget * dt * from.
        let diff = (from - stepped) as u128;
        assert!(diff * 10_000 < BUDGET * from as u128);
    }

    #[test]
    fn repeated_steps_converge() {
        let mut price = 64_306_180_000u64;
        let target = 63_657_000_000u64;
        // A couple of ticks is all it takes to close a 1% gap.
        for _ in 0..8 {
            price = step_toward(price, target, BUDGET);
        }
        assert_eq!(price, target, "the mark must catch up, not creep forever");
    }

    #[test]
    fn a_zero_stored_price_takes_the_target() {
        // A freshly activated asset has nothing to step from.
        assert_eq!(step_toward(0, 64_000_000_000, BUDGET), 64_000_000_000);
    }
}
