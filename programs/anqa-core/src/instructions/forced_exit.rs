//! Forced exit — leave with your funds, without the rollup.
//!
//! The non-custodial guarantee, made concrete: settle a trader out of the
//! venue against the **last committed state** of their portfolio, with no
//! rollup, no keeper, and no operator goodwill in the path.
//!
//! ## Why this is safe to expose
//!
//! Every risk account here is a typed Anchor account, so all of them must be
//! **program-owned on base layer** — which for the portfolio means committed
//! and undelegated. While a portfolio is delegated this instruction physically
//! cannot run; the moment the rollup hands it back (voluntarily, or via the
//! delegation program's escape once a validator goes dark), it always can.
//! The rollup's death can strand *freshness*, never custody.
//!
//! ## Authority
//!
//! The owner may always exit themselves. Anyone may exit anyone **only while
//! the market is paused** — pausing is the admin's declaration of emergency,
//! and in an emergency a trader must not need their own key ceremony to be
//! made whole (think: custodial wallets, dead clients).
//!
//! ## What it pays
//!
//! Everything the kernel will certify: junior PnL is promoted where the kernel
//! allows it, then the full capital balance is withdrawn through every kernel
//! gate (flat account, losses settled, equity non-negative). An account with
//! open positions cannot force-exit — close or liquidate on base first, which
//! becomes possible as soon as the trading state is undelegated too.
//!
//! Resting-order margin: if the book is reachable (undelegated), this
//! trader's orders are cancelled properly. If the book died with the rollup,
//! the orders it held are gone, so the reservation backing them is released —
//! bookkeeping must not outlive the thing it booked.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

use crate::constants::{
    ASSET_SLOTS_SEED, BOOK_SEED, LEDGER_SEED, MARKET_SEED, PORTFOLIO_SEED, RISK_GROUP_SEED,
    VAULT_SEED,
};
use crate::errors::{map_risk, AnqaError};
use crate::state::{AssetSlots, Book, Market, Portfolio, RiskGroup, Side, UserDepositLedger};

#[event]
pub struct ForcedExit {
    pub market_id: u64,
    pub owner: Pubkey,
    pub paid: u64,
}

#[derive(Accounts)]
pub struct ForceExit<'info> {
    /// The owner, or — while the market is paused — anyone.
    pub caller: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(mut, seeds = [RISK_GROUP_SEED, &market.group_id.to_le_bytes()], bump)]
    pub risk_group: AccountLoader<'info, RiskGroup>,

    #[account(mut, seeds = [ASSET_SLOTS_SEED, &market.group_id.to_le_bytes()], bump)]
    pub asset_slots: AccountLoader<'info, AssetSlots>,

    /// Must be program-owned, i.e. committed and undelegated — Anchor's owner
    /// check is the whole "against last committed state" guarantee.
    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, &market.group_id.to_le_bytes(), portfolio.load()?.owner.as_ref()],
        bump
    )]
    pub portfolio: AccountLoader<'info, Portfolio>,

    /// CHECK: the book, inspected manually. If it is still delegated (owned by
    /// the delegation program) the trader's resting orders died with the
    /// rollup and only the reservation is cleaned up; if it is ours, the
    /// orders are cancelled properly.
    #[account(mut, seeds = [BOOK_SEED, &market.market_id.to_le_bytes()], bump)]
    pub book: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [LEDGER_SEED, &market.group_id.to_le_bytes(), portfolio.load()?.owner.as_ref()],
        bump = ledger.bump
    )]
    pub ledger: Account<'info, UserDepositLedger>,

    /// Where the money goes. Must belong to the portfolio's owner — a
    /// permissionless exit can free someone's funds, never redirect them.
    #[account(
        mut,
        constraint = payout_to.owner == portfolio.load()?.owner @ AnqaError::NotOrderOwner
    )]
    pub payout_to: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [VAULT_SEED, &market.group_id.to_le_bytes()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ForceExit>) -> Result<()> {
    // The custody vault is group-scoped; its signer seeds must match.
    let market_id = ctx.accounts.market.group_id;
    let owner = ctx.accounts.portfolio.load()?.owner;

    require!(
        ctx.accounts.caller.key() == owner || ctx.accounts.market.paused,
        AnqaError::Unauthorized
    );

    // 1. Resting orders. Cancel them if the book is here; release the
    //    reservation either way — margin must not stay locked behind a book
    //    that no longer exists.
    if ctx.accounts.book.owner == &crate::ID {
        // Zero-copy by hand: the seeds constraint has already pinned this to
        // the market's book PDA; verify the discriminator and cancel.
        let mut data = ctx.accounts.book.try_borrow_mut_data()?;
        require!(
            data.len() >= 8 + core::mem::size_of::<Book>()
                && data[..8] == Book::DISCRIMINATOR[..],
            AnqaError::WrongMarket
        );
        let book: &mut Book =
            bytemuck::from_bytes_mut(&mut data[8..8 + core::mem::size_of::<Book>()]);
        book.bids.cancel_matching(&owner, Side::Bid, None);
        book.asks.cancel_matching(&owner, Side::Ask, None);
    }
    {
        let mut pf = ctx.accounts.portfolio.load_mut()?;
        let residual = pf.reserved();
        pf.release(residual);
    }

    // 2. The kernel decides what leaves: promote junior PnL where permitted,
    //    then withdraw the entire capital balance through every gate. Open
    //    positions refuse here — forced exit frees money, it does not close
    //    exposure.
    let paid: u64 = {
        let mut group = ctx.accounts.risk_group.load_mut()?;
        let n_assets = group.asset_count();
        let mut slots = ctx.accounts.asset_slots.load_mut()?;
        let mut pf = ctx.accounts.portfolio.load_mut()?;

        let mut view =
            MarketGroupV16ViewMut::new(group.header_mut(), &mut slots.markets_mut()[..n_assets]);
        let mut pv = PortfolioV16ViewMut::new(pf.account_mut());

        map_risk(view.full_account_refresh_not_atomic(&mut pv))?;
        // Best effort: realizable winnings come along when the kernel can
        // prove their backing; refusal here only means they stay junior.
        let _ = view.convert_released_pnl_to_capital_not_atomic(&mut pv);

        let capital = pf.account().capital.get();
        if capital > 0 {
            let mut pv = PortfolioV16ViewMut::new(pf.account_mut());
            map_risk(view.withdraw_not_atomic(&mut pv, capital))?;
        }
        u64::try_from(capital).map_err(|_| AnqaError::MathOverflow)?
    };

    // 3. Record and pay.
    ctx.accounts.ledger.withdrawn = ctx
        .accounts
        .ledger
        .withdrawn
        .checked_add(paid)
        .ok_or(AnqaError::MathOverflow)?;

    if paid > 0 {
        let market_id_bytes = market_id.to_le_bytes();
        let seeds: &[&[u8]] = &[VAULT_SEED, &market_id_bytes, &[ctx.bumps.vault]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.payout_to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            paid,
        )?;
    }

    emit!(ForcedExit {
        market_id,
        owner,
        paid,
    });
    msg!("anqa: forced exit — {} paid out to {}", paid, owner);
    Ok(())
}
