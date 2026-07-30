//! Delegate the market config into the ephemeral rollup. **Contingency only —
//! not part of the normal delegation set.**
//!
//! Delegating the market flips its base-layer owner to the delegation program,
//! which breaks every base instruction that reads `market` through Anchor's
//! owner check (`deposit`, the withdraw legs, `forced_exit`) — verified the
//! hard way on devnet. The rollup clone-reads the undelegated config instead.
//! This instruction exists only as an escape hatch in case a future rollup
//! runtime stops serving clone-reads.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::MARKET_SEED;

#[delegate]
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct DelegateMarketConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: market config, read by `place_order`.
    #[account(mut, del, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump)]
    pub market: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DelegateMarketConfig>, market_id: u64) -> Result<()> {
    ctx.accounts.delegate_market(
        &ctx.accounts.payer,
        &[MARKET_SEED, &market_id.to_le_bytes()],
        crate::constants::delegate_config(),
    )?;
    msg!("anqa: market config delegated for market {}", market_id);
    Ok(())
}
