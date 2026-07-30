//! Program-wide constants.

/// PDA seeds.
pub const MARKET_SEED: &[u8] = b"anqa_market";
pub const BOOK_SEED: &[u8] = b"anqa_book";
pub const SEAT_SEED: &[u8] = b"anqa_seat";

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

/// Assets per risk group: BTC, ETH, SOL. Each is an isolated source domain in
/// the risk kernel, so losses in one market cannot reach another's backing.
pub const MAX_ASSETS: usize = 3;

/// PDA seeds for the risk-engine accounts.
pub const RISK_GROUP_SEED: &[u8] = b"anqa_risk";
pub const ASSET_SLOTS_SEED: &[u8] = b"anqa_assets";
pub const PORTFOLIO_SEED: &[u8] = b"anqa_portfolio";
/// Protocol custody for collateral. Never delegated to the rollup.
pub const VAULT_SEED: &[u8] = b"anqa_vault";
pub const ORACLE_STATE_SEED: &[u8] = b"anqa_oracle";
/// Relay account mirroring the oracle into the rollup. See state/internal_oracle.rs.
pub const INTERNAL_ORACLE_SEED: &[u8] = b"anqa_int_oracle";
