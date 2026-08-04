//! Program-wide constants.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

/// PDA seeds.
pub const MARKET_SEED: &[u8] = b"anqa_market";
pub const BOOK_SEED: &[u8] = b"anqa_book";
pub const SEAT_SEED: &[u8] = b"anqa_seat";
/// The book's public face: totals per price level, no owners. Unpermissioned
/// on purpose — see `state::depth`.
pub const DEPTH_SEED: &[u8] = b"anqa_depth";

/// The venue's own monotonic clock, one per risk group.
pub const CLOCK_SEED: &[u8] = b"anqa_clock";

/// Resting-order capacity per side of the book.
///
/// Fixed capacity keeps the account a known size, which matters because the book
/// is delegated into an ephemeral rollup and committed back — commit cost scales
/// with account size. 32 per side keeps the book near ~4KB. Tunable; the free
/// list and linked ordering below are capacity-agnostic.
pub const ORDERS_PER_SIDE: usize = 32;

/// Sentinel for "no index" in the intrusive linked lists.
pub const NIL: u16 = u16::MAX;

/// Maximum orders a single taker may cross in one instruction, so matching stays
/// compute-bounded regardless of book depth.
pub const MAX_FILLS_PER_ORDER: usize = 8;

/// Asset capacity per risk group. Each is an isolated source domain in the
/// risk kernel, so losses in one market cannot reach another's backing.
///
/// This sizes `AssetSlots` (~1.3KB per slot, delegated and committed), not
/// portfolios — a trader's concurrent-position cap is the kernel's
/// `V16_MAX_PORTFOLIO_ASSETS_N`. 12 leaves headroom over the 9 listed markets.
pub const MAX_ASSETS: usize = 12;

/// PDA seeds for the risk-engine accounts.
pub const RISK_GROUP_SEED: &[u8] = b"anqa_risk";
pub const ASSET_SLOTS_SEED: &[u8] = b"anqa_assets";
pub const PORTFOLIO_SEED: &[u8] = b"anqa_portfolio";
pub const SESSION_SEED: &[u8] = b"anqa_session";
/// Base-layer record of a trader's deposits. Read from the rollup, never delegated.
pub const LEDGER_SEED: &[u8] = b"anqa_ledger";
pub const WITHDRAW_RECEIPT_SEED: &[u8] = b"anqa_wreceipt";
pub const DEPOSIT_RECEIPT_SEED: &[u8] = b"anqa_dreceipt";
/// Protocol custody for collateral. Never delegated to the rollup.
pub const VAULT_SEED: &[u8] = b"anqa_vault";
/// Layer 2 of the loss waterfall. Kept apart from custody so a bug in the
/// withdraw path cannot pay out insurance as trader collateral.
pub const INSURANCE_VAULT_SEED: &[u8] = b"anqa_insurance";
/// Venue revenue. Separate from custody and insurance so an accounting bug in
/// one cannot drain another.
pub const PROTOCOL_VAULT_SEED: &[u8] = b"anqa_protocol";
pub const PROTOCOL_VAULT_TOKENS_SEED: &[u8] = b"anqa_protocol_tok";
pub const ORACLE_STATE_SEED: &[u8] = b"anqa_oracle";
/// Relay account mirroring the oracle into the rollup. See state/internal_oracle.rs.
pub const INTERNAL_ORACLE_SEED: &[u8] = b"anqa_int_oracle";
pub const TRIGGER_SEED: &[u8] = b"anqa_trigger";
/// Public fill tape for dark markets. Deliberately never permissioned.
pub const TAPE_SEED: &[u8] = b"anqa_tape";
/// Trigger-order slots per portfolio. Triggers ride inside the portfolio so
/// they delegate with it and fire inside the rollup; a fixed arena keeps the
/// account `Pod` and its size known. ~48 bytes per slot.
pub const MAX_TRIGGERS_PER_PORTFOLIO: usize = 4;

// ───────────────────────────── delegation ─────────────────────────────

/// MagicBlock's **private** devnet validator — the TEE one.
///
/// This is what makes the book dark, and nothing else does. On the shared
/// validator (`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`) every delegated
/// account is served to anyone who asks: a stranger can `getAccountInfo` the
/// book and decode each resting order with its owner, exactly as they could
/// on any lit venue. The ACL permission does not prevent that — it gates
/// program access, not RPC reads.
///
/// Pinning delegations here is therefore load-bearing for the whole product,
/// not an ops detail.
pub const MAGICBLOCK_DEVNET_VALIDATOR: Pubkey =
    pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// The validator every delegation is pinned to.
///
/// Pinning is load-bearing, not cosmetic: all of a market's delegated accounts
/// (book, router, slabs, oracle, portfolios, receipts) must land on the **same**
/// validator, because a fill mutates several of them in one rollup transaction.
/// An account delegated with `validator: None` can be claimed by a different
/// validator, and state stranded there is unreachable from where the rest of
/// the market lives.
///
/// The `local-er` feature returns `None` so a locally run ephemeral validator
/// (whose identity differs per machine) can claim the accounts during tests.
pub fn delegation_validator() -> Option<Pubkey> {
    if cfg!(feature = "local-er") {
        None
    } else {
        Some(MAGICBLOCK_DEVNET_VALIDATOR)
    }
}

/// The one `DelegateConfig` used everywhere.
///
/// `commit_frequency_ms: u32::MAX` means the validator never auto-commits;
/// every commit is explicit and program-driven, so the set of base-layer
/// snapshots is exactly the set the program asked for.
pub fn delegate_config() -> DelegateConfig {
    DelegateConfig {
        commit_frequency_ms: u32::MAX,
        validator: delegation_validator(),
    }
}

/// The `#[action]` attribute appends two accounts (`escrow_auth`, `escrow`) to
/// a settle instruction's account struct. The validator injects both at
/// dispatch time, so when a rollup leg builds the account list for a settle
/// action it must truncate them off the generated metas.
pub const ACTION_INJECTED_TRAILING_ACCOUNTS: usize = 2;

/// Compute budget requested for a validator-dispatched settle action.
pub const SETTLE_ACTION_COMPUTE_UNITS: u32 = 200_000;
