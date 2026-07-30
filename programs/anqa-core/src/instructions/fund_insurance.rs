//! Fund the insurance pot — layer two of the loss waterfall.
//!
//! When a trader goes bankrupt, losses are absorbed in a strict order and each
//! layer only fires when the one before it runs out:
//!
//! ```text
//!   1. counterparty   the losing trader's own collateral
//!   2. insurance      this fund
//!   3. haircut        winners' unrealised gains impaired (junior PnL)
//!   4. ADL            profitable opposite side force-closed at bankruptcy price
//! ```
//!
//! Layer 2 exists so that layer 3 does not have to happen. Without a funded
//! insurance pot, every bankruptcy goes straight to haircutting the people who
//! were *right* about the market — which is the fastest way to lose the traders
//! you most want to keep.
//!
//! ## Per asset, per side
//!
//! Insurance is compartmentalised by **domain**, where `domain = asset_index * 2`
//! for longs and `+ 1` for shorts. A blowup among BTC longs cannot reach the
//! backing for BTC shorts or for ETH. That containment is the same reasoning as
//! isolated source domains elsewhere in the kernel: a single market's bad day
//! must not become everyone's.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use percolator::MarketGroupV16ViewMut;

use crate::constants::{ASSET_SLOTS_SEED, INSURANCE_VAULT_SEED, MARKET_SEED, RISK_GROUP_SEED};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Market, RiskGroup};

#[event]
pub struct InsuranceFunded {
    pub market_id: u64,
    pub asset_index: u32,
    pub long_amount: u64,
    pub short_amount: u64,
}

#[derive(Accounts)]
pub struct FundInsurance<'info> {
    /// Permissionless. Anyone may strengthen the backstop; nobody can weaken it
    /// here, because there is no withdrawal path in this instruction.
    pub funder: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.market_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.market_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    #[account(mut)]
    pub funder_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [INSURANCE_VAULT_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Fund one asset's insurance, split across its long and short domains.
///
/// Both sides are funded in one call because they fail independently: a market
/// that gaps down bankrupts longs, one that gaps up bankrupts shorts, and a
/// backstop that only covers one direction is half a backstop.
pub fn handler(
    ctx: Context<FundInsurance>,
    asset_index: u32,
    long_amount: u64,
    short_amount: u64,
) -> Result<()> {
    let total = long_amount
        .checked_add(short_amount)
        .ok_or(AnqaError::MathOverflow)?;
    require!(total > 0, AnqaError::InvalidSize);

    // 1. Tokens first, so the accounting can never claim backing that is absent.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_token_account.to_account_info(),
                to: ctx.accounts.insurance_vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        total,
    )?;

    // 2. Then tell the kernel, per domain.
    let mut group = ctx.accounts.risk_group.load_mut()?;
    let n_assets = group.asset_count();
    require!((asset_index as usize) < n_assets, AnqaError::BadAssetIndex);
    let mut slots = ctx.accounts.asset_slots.load_mut()?;
    let mut view =
        MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);

    let long_domain = (asset_index as usize) * 2;
    let short_domain = long_domain + 1;

    if long_amount > 0 {
        map_risk(view.deposit_domain_insurance_not_atomic(long_domain, long_amount as u128))?;
    }
    if short_amount > 0 {
        map_risk(view.deposit_domain_insurance_not_atomic(short_domain, short_amount as u128))?;
    }

    emit!(InsuranceFunded {
        market_id: ctx.accounts.market.market_id,
        asset_index,
        long_amount,
        short_amount,
    });
    msg!(
        "anqa: insurance funded — asset {} long {} short {}",
        asset_index,
        long_amount,
        short_amount
    );
    Ok(())
}
