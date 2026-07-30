"use client";

import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ACL, DLP, MAGIC_CONTEXT, MAGIC_PROGRAM, PROGRAM_ID, type AnqaAccounts } from "./anqa";

/** Full read/write flags on a permission member. */
export const ALL_FLAGS = 31;

type Ctx = {
  acc: AnqaAccounts;
  marketId: BN;
  owner: PublicKey;
  /** The venue's engine key — permitted to read the book and settle fills. */
  engine: PublicKey;
};

/**
 * Onboarding, in the order the protocol requires.
 *
 * The sequence is not arbitrary: the ledger is a permanent record that must
 * exist before any deposit, the permission must exist before the account
 * enters a private rollup, and delegation must come last because a delegated
 * account can no longer be written from base.
 */
export async function openAccount(p: Program, c: Ctx) {
  const portfolio = c.acc.portfolioOf(c.owner);
  await p.methods
    .openPortfolio()
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      portfolio,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await p.methods
    .initializeLedger()
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      ledger: c.acc.ledgerOf(c.owner),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Make the portfolio private: only the trader and the engine may read it. */
export async function permissionPortfolio(p: Program, c: Ctx) {
  const portfolio = c.acc.portfolioOf(c.owner);
  return p.methods
    .createPortfolioPermission(c.marketId, [
      { pubkey: c.owner, flags: ALL_FLAGS },
      { pubkey: c.engine, flags: ALL_FLAGS },
    ])
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      portfolio,
      permission: c.acc.permissionOf(portfolio),
      permissionProgram: ACL,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Base layer: tokens into the vault, recorded on the monotonic ledger. */
export async function deposit(p: Program, c: Ctx, mint: PublicKey, amount: BN) {
  const receipt = c.acc.depositReceiptOf(c.owner);
  const d = c.acc.delegationOf(receipt);
  return p.methods
    .deposit(amount, false)
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      ledger: c.acc.ledgerOf(c.owner),
      traderTokenAccount: getAssociatedTokenAddressSync(mint, c.owner),
      vault: c.acc.vault,
      receipt,
      buffer: d.buffer,
      delegationRecord: d.delegationRecord,
      delegationMetadata: d.delegationMetadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DLP,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Session start: the portfolio moves into the rollup. */
export async function delegatePortfolio(p: Program, c: Ctx) {
  const portfolio = c.acc.portfolioOf(c.owner);
  const d = c.acc.delegationOf(portfolio);
  return p.methods
    .delegatePortfolio(c.marketId)
    .accounts({
      trader: c.owner,
      portfolio,
      bufferPortfolio: d.buffer,
      delegationRecordPortfolio: d.delegationRecord,
      delegationMetadataPortfolio: d.delegationMetadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DLP,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Rollup: credit the portfolio from the base-layer ledger. Idempotent. */
export async function claimDeposit(p: Program, c: Ctx) {
  return p.methods
    .claimDeposit()
    .accounts({
      caller: c.owner,
      market: c.acc.market,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      portfolio: c.acc.portfolioOf(c.owner),
      ledger: c.acc.ledgerOf(c.owner),
      // Keeper rail: no receipt, so no magic accounts either. The credit is
      // ledger-derived, which is what makes this path always available.
      receipt: null,
      magicContext: null,
      magicProgram: null,
    } as never)
    .rpc();
}

/**
 * Place an order.
 *
 * On a **dark** market no counterparty accounts are supplied — the taker
 * cannot see who it crosses, so fills queue for the engine to settle. On a
 * lit market the caller passes maker portfolios it read off the book.
 */
export async function placeOrder(
  p: Program,
  c: Ctx,
  args: {
    side: "bid" | "ask";
    orderType: "limit" | "postOnly" | "immediateOrCancel" | "fillOrKill";
    priceInTicks: BN;
    baseLots: BN;
    clientOrderId: BN;
    makers?: PublicKey[];
  }
) {
  const side = args.side === "bid" ? { bid: {} } : { ask: {} };
  const type = { [args.orderType]: {} } as Record<string, object>;
  return p.methods
    .placeOrder(side, type, args.priceInTicks, args.baseLots, args.clientOrderId)
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      book: c.acc.book,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      oracleState: c.acc.oracleState,
      portfolio: c.acc.portfolioOf(c.owner),
    })
    .remainingAccounts(
      (args.makers ?? []).map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      }))
    )
    .rpc();
}

export async function cancelOrder(
  p: Program,
  c: Ctx,
  side: "bid" | "ask",
  clientOrderId: BN
) {
  return p.methods
    .cancelOrder(side === "bid" ? { bid: {} } : { ask: {} }, clientOrderId)
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      book: c.acc.book,
      portfolio: c.acc.portfolioOf(c.owner),
    })
    .rpc();
}

export async function cancelAll(p: Program, c: Ctx) {
  return p.methods
    .cancelAllOrders()
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      book: c.acc.book,
      portfolio: c.acc.portfolioOf(c.owner),
    })
    .rpc();
}

/** Reduce-only exit. Dark markets queue it like any other cross. */
export async function closePosition(
  p: Program,
  c: Ctx,
  worstPriceInTicks: BN,
  maxBaseLots: BN,
  makers: PublicKey[] = []
) {
  return p.methods
    .closePosition(worstPriceInTicks, maxBaseLots)
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      book: c.acc.book,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      oracleState: c.acc.oracleState,
      portfolio: c.acc.portfolioOf(c.owner),
    })
    .remainingAccounts(
      makers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
    )
    .rpc();
}

/** Arm a stop / take-profit in a portfolio slot. */
export async function placeTrigger(
  p: Program,
  c: Ctx,
  args: {
    triggerId: BN;
    triggerPrice: BN;
    direction: "above" | "below";
    limitPriceInTicks: BN;
    maxBaseLots: BN;
  }
) {
  return p.methods
    .placeTriggerOrder(
      args.triggerId,
      args.triggerPrice,
      args.direction === "above" ? { above: {} } : { below: {} },
      args.limitPriceInTicks,
      args.maxBaseLots
    )
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      portfolio: c.acc.portfolioOf(c.owner),
    })
    .rpc();
}

export async function cancelTrigger(p: Program, c: Ctx, triggerId: BN) {
  return p.methods
    .cancelTriggerOrder(triggerId)
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      portfolio: c.acc.portfolioOf(c.owner),
    })
    .rpc();
}

/**
 * The engine's crank: settle the oldest queued fill and print it.
 *
 * Permissionless by design — it can only execute what the book already
 * matched, at the price the book recorded, between the parties it named.
 */
export async function settleFill(
  p: Program,
  c: Ctx,
  taker: PublicKey,
  maker: PublicKey
) {
  return p.methods
    .settleFill()
    .accounts({
      caller: c.owner,
      market: c.acc.market,
      book: c.acc.book,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      oracleState: c.acc.oracleState,
      takerPortfolio: c.acc.portfolioOf(taker),
      makerPortfolio: c.acc.portfolioOf(maker),
      tape: c.acc.tape,
    })
    .rpc();
}

/** Base: reserve and open a withdrawal receipt, delegated to the rollup. */
export async function requestWithdraw(
  p: Program,
  c: Ctx,
  mint: PublicKey,
  amount: BN
) {
  const receipt = c.acc.withdrawReceiptOf(c.owner);
  const d = c.acc.delegationOf(receipt);
  return p.methods
    .requestWithdraw(amount, false)
    .accounts({
      trader: c.owner,
      market: c.acc.market,
      ledger: c.acc.ledgerOf(c.owner),
      payoutTo: getAssociatedTokenAddressSync(mint, c.owner),
      receipt,
      buffer: d.buffer,
      delegationRecord: d.delegationRecord,
      delegationMetadata: d.delegationMetadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DLP,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Rollup: the kernel's verdict, then the receipt goes home. */
export async function authorizeWithdraw(p: Program, c: Ctx) {
  return p.methods
    .authorizeWithdraw()
    .accounts({
      payer: c.owner,
      market: c.acc.market,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      portfolio: c.acc.portfolioOf(c.owner),
      receipt: c.acc.withdrawReceiptOf(c.owner),
      magicProgram: MAGIC_PROGRAM,
      magicContext: MAGIC_CONTEXT,
    })
    .rpc();
}

/** Base: pay out. Signerless — anyone may drive it. */
export async function settleWithdraw(p: Program, c: Ctx, mint: PublicKey) {
  return p.methods
    .settleWithdraw()
    .accounts({
      market: c.acc.market,
      ledger: c.acc.ledgerOf(c.owner),
      receipt: c.acc.withdrawReceiptOf(c.owner),
      owner: c.owner,
      payoutTo: getAssociatedTokenAddressSync(mint, c.owner),
      vault: c.acc.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      escrowAuth: c.owner,
      escrow: c.owner,
    })
    .rpc();
}

/** End the session: commit and hand the portfolio back to base. */
export async function undelegatePortfolio(p: Program, c: Ctx) {
  return p.methods
    .undelegatePortfolio()
    .accounts({
      trader: c.owner,
      portfolio: c.acc.portfolioOf(c.owner),
      magicProgram: MAGIC_PROGRAM,
      magicContext: MAGIC_CONTEXT,
    })
    .rpc();
}
