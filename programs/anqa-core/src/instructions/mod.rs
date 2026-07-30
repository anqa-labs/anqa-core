//! One module per instruction — one file, one `Accounts` struct, one `handler`.
//!
//! The rare exceptions are paired instructions that share an `Accounts` struct
//! (`undelegate_portfolio` uses `commit_portfolio`'s, `undelegate_book` uses
//! `commit_book`'s, `cancel_up_to` uses `cancel_all`'s) — the struct lives with
//! the primary and the sibling imports it.
//!
//! ## About the glob re-exports
//!
//! Every module here defines `handler`, so `pub use x::*` across all of them
//! makes that name ambiguous and rustc says so. The lint is suppressed rather
//! than fixed, deliberately:
//!
//! - Nothing resolves `handler` through the glob. `lib.rs` calls each one by
//!   its full path (`instructions::place_order::handler`), so the ambiguous
//!   name is never actually used.
//! - The globs cannot simply be narrowed to the `Accounts` structs. Anchor's
//!   `#[program]` macro expects the `__client_accounts_*` modules that
//!   `#[derive(Accounts)]` generates to be in scope here; exporting only the
//!   named types breaks codegen with an unresolved `crate` import.

#![allow(ambiguous_glob_reexports)]

pub mod adl;
pub mod authorize_withdraw;
pub mod cancel_all;
pub mod cancel_order;
pub mod cancel_trigger_order;
pub mod cancel_up_to;
pub mod claim_deposit;
pub mod close_deposit_receipt;
pub mod close_position;
pub mod collect_protocol_fees;
pub mod commit_book;
pub mod commit_portfolio;
pub mod crank;
pub mod delegate_asset_slots;
pub mod delegate_book;
pub mod delegate_internal_oracle;
pub mod delegate_market_config;
pub mod delegate_oracle_state;
pub mod delegate_portfolio;
pub mod delegate_risk_group;
pub mod deposit;
pub mod fire_trigger_order;
pub mod forced_exit;
pub mod fund_insurance;
pub mod initialize_insurance_vault;
pub mod initialize_ledger;
pub mod initialize_market;
pub mod initialize_protocol_vault;
pub mod initialize_risk;
pub mod initialize_vault;
pub mod liquidate;
pub mod modify_order;
pub mod open_portfolio;
pub mod place_multiple;
pub mod place_order;
pub mod place_trigger_order;
pub mod realize_pnl;
pub mod reanchor_oracle;
pub mod refresh_portfolio;
pub mod request_withdraw;
pub mod settle_withdraw;
pub mod sync_internal_oracle;
pub mod undelegate_book;
pub mod undelegate_portfolio;
pub mod withdraw;

pub use adl::*;
pub use authorize_withdraw::*;
pub use cancel_all::*;
pub use cancel_order::*;
pub use cancel_trigger_order::*;
pub use claim_deposit::*;
pub use close_deposit_receipt::*;
pub use close_position::*;
pub use collect_protocol_fees::*;
pub use commit_book::*;
pub use commit_portfolio::*;
pub use crank::*;
pub use delegate_asset_slots::*;
pub use delegate_book::*;
pub use delegate_internal_oracle::*;
pub use delegate_market_config::*;
pub use delegate_oracle_state::*;
pub use delegate_portfolio::*;
pub use delegate_risk_group::*;
pub use deposit::*;
pub use fire_trigger_order::*;
pub use forced_exit::*;
pub use fund_insurance::*;
pub use initialize_insurance_vault::*;
pub use initialize_ledger::*;
pub use initialize_market::*;
pub use initialize_protocol_vault::*;
pub use initialize_risk::*;
pub use initialize_vault::*;
pub use liquidate::*;
pub use modify_order::*;
pub use open_portfolio::*;
pub use place_multiple::*;
pub use place_order::*;
pub use place_trigger_order::*;
pub use realize_pnl::*;
pub use reanchor_oracle::*;
pub use refresh_portfolio::*;
pub use request_withdraw::*;
pub use settle_withdraw::*;
pub use sync_internal_oracle::*;
pub use withdraw::*;
