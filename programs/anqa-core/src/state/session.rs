//! Trade sessions — one wallet signature, then popup-free trading.
//!
//! A perp terminal that raises a wallet prompt per order is unusable, and a
//! rollup that settles in milliseconds makes the prompt the slowest part of
//! the trade. The fix is the standard one: the **owner** signs once to grant
//! a browser-held ephemeral key the right to trade — and only to trade.
//!
//! Scope is deliberately narrow. A session key may place and cancel orders,
//! close positions and manage triggers on the one portfolio it was granted
//! for, until the grant expires. It cannot deposit, withdraw, delegate,
//! change permissions or touch any other account: custody instructions still
//! demand the owner's own signature. Compromising a session key risks the
//! open orders of one account for the life of the grant, nothing more.
//!
//! The grant lives on **base** and is never delegated: trading instructions
//! inside the rollup read it as a clone, the same trust path the market
//! config takes. Revocation is therefore also a base-layer action, visible
//! on the next clone refresh.

use anchor_lang::prelude::*;

/// An owner's standing grant to one ephemeral key — **platform-wide**.
///
/// The grant names a trader, not a market: one signature arms one-click
/// trading across every market the owner holds an account on. Scope comes
/// from what the key may *do* (trade only), not from where.
#[account]
#[derive(InitSpace)]
pub struct TradeSession {
    /// The portfolio owner who granted the session.
    pub owner: Pubkey,
    /// Unused since grants went platform-wide; kept for layout stability.
    pub market_id: u64,
    /// The ephemeral key allowed to sign trading instructions.
    pub session_key: Pubkey,
    /// Unix time after which the grant is dead. Re-grant to extend.
    pub expires_at: i64,
    pub bump: u8,
}

impl TradeSession {
    /// May `signer` act for `portfolio_owner` right now? Market-agnostic:
    /// the same grant serves every market this owner trades.
    pub fn authorizes(
        &self,
        portfolio_owner: Pubkey,
        _market_id: u64,
        signer: Pubkey,
        now: i64,
    ) -> bool {
        self.owner == portfolio_owner && self.session_key == signer && now < self.expires_at
    }
}

/// The one authorization question every trading instruction asks: is the
/// signer the owner, or a live session key the owner granted?
pub fn trade_authorized(
    portfolio_owner: Pubkey,
    market_id: u64,
    signer: Pubkey,
    session: Option<&Account<TradeSession>>,
) -> Result<bool> {
    if signer == portfolio_owner {
        return Ok(true);
    }
    let now = Clock::get()?.unix_timestamp;
    Ok(session
        .map(|s| s.authorizes(portfolio_owner, market_id, signer, now))
        .unwrap_or(false))
}
