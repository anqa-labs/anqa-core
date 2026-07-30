//! Risk-engine accounts.
//!
//! Anqa does not implement margin arithmetic. It wraps
//! [Percolator](https://github.com/anqa-labs/percolator) — a zero-copy perpetual
//! futures risk kernel with a machine-checked proof suite — and supplies the
//! parts a kernel deliberately does not own: account loading, authorization,
//! oracle authentication, token custody, and matching.
//!
//! The division, in one line: **the book decides who trades at what price; the
//! kernel decides whether they may, and what it does to their accounts.**
//!
//! ## Why the kernel state is stored as bytes
//!
//! Each account below holds the kernel's Pod struct as a raw byte array and
//! casts to it on access. Two reasons, one practical and one architectural:
//!
//! - Anchor's IDL generator cannot describe foreign types, so embedding them
//!   directly breaks `anchor build`. Bytes are describable.
//! - It states the boundary honestly: kernel internals are opaque to Anqa and to
//!   clients. Only the kernel interprets them, and it does so over the exact
//!   bytes we persist — so its invariants and proofs apply unchanged.
//!
//! The casts are infallible: every wrapped type is alignment-1 by construction
//! (Percolator only permits alignment-1 market wrappers so `Market` carries no
//! padding), so a `[u8; N]` field is always correctly aligned for it.

use anchor_lang::prelude::*;
use percolator::{Market as PercMarket, MarketGroupV16HeaderAccount, PortfolioAccountV16Account};

use crate::constants::MAX_ASSETS;

/// Wrapper stored alongside each asset's engine state: the asset id, little-endian.
pub type AssetTag = [u8; 8];

pub const RISK_GROUP_BYTES: usize = core::mem::size_of::<MarketGroupV16HeaderAccount>();
pub const MARKET_BYTES: usize = core::mem::size_of::<PercMarket<AssetTag>>();
pub const PORTFOLIO_BYTES: usize = core::mem::size_of::<PortfolioAccountV16Account>();

/// Global risk state for a market group: config, insurance, vault totals, and
/// the solvency accounting shared across every asset in the group.
#[account(zero_copy)]
pub struct RiskGroup {
    pub inner: [u8; RISK_GROUP_BYTES],
}

impl RiskGroup {
    pub fn header(&self) -> &MarketGroupV16HeaderAccount {
        bytemuck::from_bytes(&self.inner)
    }
    pub fn header_mut(&mut self) -> &mut MarketGroupV16HeaderAccount {
        bytemuck::from_bytes_mut(&mut self.inner)
    }

    /// Assets actually activated in this group.
    ///
    /// The kernel validates that the slice it is handed matches the slot count
    /// its config was built with, so passing the full `MAX_ASSETS` array to a
    /// group configured for fewer is rejected as `InvalidConfig`. Always slice
    /// with this.
    pub fn asset_count(&self) -> usize {
        self.header().config.max_market_slots.get() as usize
    }
}

/// Per-asset engine state for every market in the group.
///
/// The kernel's view constructor takes a contiguous `&mut [Market<T>]`, so all
/// assets live in **one** account rather than one account per asset. Each is an
/// isolated source domain, which is what bounds a blowup in one market to that
/// market.
#[account(zero_copy)]
pub struct AssetSlots {
    pub inner: [u8; MARKET_BYTES * MAX_ASSETS],
}

impl AssetSlots {
    pub fn markets_mut(&mut self) -> &mut [PercMarket<AssetTag>] {
        bytemuck::cast_slice_mut(&mut self.inner)
    }
}

/// A trader's margin account: collateral, positions, PnL, funding counters.
///
/// Large (9,291 bytes of kernel state), and deliberately so — it is bounded
/// storage the kernel can walk without ever scanning a global table, which is
/// what keeps margin checks and liquidation cranks compute-bounded and, later,
/// feasible inside an enclave.
#[account(zero_copy)]
pub struct Portfolio {
    /// Anqa-side owner check, independent of the kernel's provenance header.
    pub owner: Pubkey,
    /// Market group id, little-endian (a `u64` here would force 8-byte
    /// alignment and introduce padding, which `bytemuck::Pod` rejects).
    pub market_id: AssetTag,
    pub bump: u8,
    /// Initial margin reserved by this trader's **resting orders**, in quote
    /// atoms, little-endian u128.
    ///
    /// The kernel only knows about positions — an order that has not filled yet
    /// is invisible to it. Without this, a trader could rest orders far beyond
    /// what their collateral can support and only discover it at match time,
    /// when the fill is refused and the book has already been walked. Anqa
    /// therefore reserves margin at placement and releases it on cancel or fill.
    pub reserved_margin: [u8; 16],
    pub inner: [u8; PORTFOLIO_BYTES],
}

impl Portfolio {
    pub fn market_id(&self) -> u64 {
        u64::from_le_bytes(self.market_id)
    }
    pub fn account(&self) -> &PortfolioAccountV16Account {
        bytemuck::from_bytes(&self.inner)
    }
    pub fn account_mut(&mut self) -> &mut PortfolioAccountV16Account {
        bytemuck::from_bytes_mut(&mut self.inner)
    }

    pub fn reserved(&self) -> u128 {
        u128::from_le_bytes(self.reserved_margin)
    }
    pub fn reserve(&mut self, amount: u128) {
        self.reserved_margin = self.reserved().saturating_add(amount).to_le_bytes();
    }
    pub fn release(&mut self, amount: u128) {
        self.reserved_margin = self.reserved().saturating_sub(amount).to_le_bytes();
    }

    /// Equity and the margin already committed to open positions, as certified
    /// by the kernel. Only meaningful straight after a refresh — the certificate
    /// is stamped with the epochs it was computed against and goes stale.
    ///
    /// Equity is **signed**: an account whose losses exceeded its collateral is
    /// bankrupt and reports negative equity, so callers must not cast blindly.
    pub fn certified(&self) -> Result<(i128, u128)> {
        let cert = self
            .account()
            .health_cert
            .try_to_runtime()
            .map_err(|_| crate::errors::AnqaError::RiskEngine)?;
        Ok((cert.certified_equity, cert.certified_initial_req))
    }

    /// This trader's open position on `asset_index`, as `(is_long, size_q)`.
    /// `None` when flat.
    ///
    /// Needed because the book knows nothing about positions — it only knows
    /// orders. Anything that must not increase exposure (closing, stops,
    /// reduce-only) has to ask the kernel what is actually open.
    pub fn current_position(&self, asset_index: u32) -> Option<(bool, u128)> {
        let acct = self.account();
        for leg_slot in acct.legs.iter() {
            let leg = leg_slot.try_to_runtime().ok()?;
            if leg.active && leg.asset_index == asset_index && leg.basis_pos_q != 0 {
                let is_long = matches!(leg.side, percolator::SideV16::Long);
                return Some((is_long, leg.basis_pos_q.unsigned_abs()));
            }
        }
        None
    }

    /// Free collateral: equity minus margin already committed to positions and
    /// to resting orders. Zero when bankrupt or fully committed.
    pub fn free_margin(&self) -> Result<u128> {
        let (equity, position_margin) = self.certified()?;
        if equity <= 0 {
            return Ok(0);
        }
        let committed = position_margin.saturating_add(self.reserved());
        Ok((equity as u128).saturating_sub(committed))
    }
}
