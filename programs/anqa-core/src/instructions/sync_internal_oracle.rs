//! Relay a verified Pyth price into the internal oracle account.
//!
//! Runs on **base layer**, where the real `PriceUpdateV2` is readable and every
//! gate still applies — feed identity, staleness, confidence. Only a price that
//! passes all of them is written.
//!
//! Permissionless on purpose: the keeper supplies no data of its own, it merely
//! pays for a transaction that copies a verified number. Anyone may keep the
//! venue's prices fresh, and no one can poison them by doing so.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{INTERNAL_ORACLE_SEED, MARKET_SEED};
use crate::errors::AnqaError;
use crate::state::{InternalOracle, Market, Price};

#[event]
pub struct InternalOracleSynced {
    pub market_id: u64,
    pub mantissa: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

#[derive(Accounts)]
pub struct SyncInternalOracle<'info> {
    /// Permissionless. Pays rent-exempt top-up only if the account is new.
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = keeper,
        space = 8 + InternalOracle::INIT_SPACE,
        seeds = [INTERNAL_ORACLE_SEED, &market.market_id.to_le_bytes()],
        bump
    )]
    pub internal_oracle: Account<'info, InternalOracle>,

    /// The real thing, read on base layer where its signature still means
    /// something.
    pub price_update: Account<'info, PriceUpdateV2>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SyncInternalOracle>) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;

    // Feed identity, staleness and confidence are all enforced here — the
    // rollup will never get a chance to check them again.
    let p = ctx
        .accounts
        .price_update
        .get_price_no_older_than(&clock, market.oracle.max_age_secs, &market.oracle.feed_id)
        .map_err(|e| {
            msg!("anqa: pyth rejected the price: {:?}", e);
            AnqaError::OracleUnavailable
        })?;
    require!(p.price > 0, AnqaError::OracleUnavailable);

    let price = Price::new(p.price as u64, p.exponent);
    let conf_bps = (p.conf as u128)
        .checked_mul(10_000)
        .ok_or(AnqaError::MathOverflow)?
        / p.price as u128;
    require!(
        conf_bps <= market.oracle.max_conf_bps as u128,
        AnqaError::OracleConfidenceTooWide
    );

    let io = &mut ctx.accounts.internal_oracle;

    // Refuse to move a relay backwards. Replaying an older update would let a
    // keeper re-pin the rollup to a stale price of its choosing.
    require!(
        p.publish_time >= io.publish_time,
        AnqaError::OracleUnavailable
    );

    io.market_id = market.market_id;
    io.feed_id = market.oracle.feed_id;
    io.bump = ctx.bumps.internal_oracle;
    io.set(
        price,
        p.conf,
        p.publish_time,
        ctx.accounts.keeper.key(),
        clock.slot,
    );
    io.update_ema(price, market.oracle.ema_weight_bps)?;

    emit!(InternalOracleSynced {
        market_id: market.market_id,
        mantissa: price.mantissa,
        exponent: price.exponent,
        publish_time: p.publish_time,
    });

    msg!(
        "anqa: relayed {} x10^{} (conf {}bps) to the internal oracle",
        price.mantissa,
        price.exponent,
        conf_bps
    );
    Ok(())
}
