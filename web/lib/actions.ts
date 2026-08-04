"use client";

import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction , ConfirmOptions } from "@solana/web3.js";
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
  /** The trading signer: the owner, or a granted session key. */
  trader?: PublicKey;
  /** The session grant PDA, when a session key signs. */
  session?: PublicKey | null;
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
    // Isolated margin: portfolios are market-seeded, so the permission binds
    // to this market's id and market account.
    .createPortfolioPermission(c.acc.groupId, [
      { pubkey: c.owner, flags: ALL_FLAGS },
      { pubkey: c.engine, flags: ALL_FLAGS },
    ])
    .accounts({
      trader: c.owner,
      market: c.acc.groupMarket,
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
    .delegatePortfolio(c.acc.groupId)
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

/**
 * The whole onboarding for one market in a single transaction: open the
 * margin account, create the ledger, deposit, delegate into the rollup,
 * grant the session key and float it fee SOL — whichever of those this
 * wallet still needs. One signature covers a brand-new market end to end;
 * the faucet mints the test USDC server-side just before this runs.
 */
export async function setupMarket(
  p: Program,
  c: Ctx,
  args: {
    mint: PublicKey;
    depositAtoms: BN;
    sessionKey: PublicKey;
    durationSecs: BN;
    need: { open: boolean; deposit: boolean; delegate: boolean; grant: boolean };
  }
) {
  const portfolio = c.acc.portfolioOf(c.owner);
  const ledger = c.acc.ledgerOf(c.owner);
  const ixs = [];

  if (args.need.open) {
    ixs.push(
      await p.methods
        .openPortfolio()
        .accounts({ trader: c.owner, market: c.acc.market, portfolio, systemProgram: SystemProgram.programId })
        .instruction(),
      await p.methods
        .initializeLedger()
        .accounts({ trader: c.owner, market: c.acc.market, ledger, systemProgram: SystemProgram.programId })
        .instruction()
    );
  }
  if (args.need.deposit) {
    const receipt = c.acc.depositReceiptOf(c.owner);
    const d = c.acc.delegationOf(receipt);
    ixs.push(
      await p.methods
        .deposit(args.depositAtoms, false)
        .accounts({
          trader: c.owner,
          market: c.acc.market,
          ledger,
          traderTokenAccount: getAssociatedTokenAddressSync(args.mint, c.owner),
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
        .instruction()
    );
  }
  if (args.need.delegate) {
    const d = c.acc.delegationOf(portfolio);
    ixs.push(
      await p.methods
        .delegatePortfolio(c.acc.groupId)
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
        .instruction()
    );
  }
  if (args.need.grant) {
    ixs.push(
      await p.methods
        .grantSession(args.sessionKey, args.durationSecs)
        .accounts({
          owner: c.owner,
          session: c.acc.sessionOf(c.owner),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      SystemProgram.transfer({ fromPubkey: c.owner, toPubkey: args.sessionKey, lamports: 30_000_000 })
    );
  }
  if (ixs.length === 0) return null;
  const tx = new Transaction().add(...ixs);
  return (p.provider as any).sendAndConfirm(tx);
}

/**
 * One signature, whole session: delegate the portfolio into the rollup,
 * grant the browser's session key, and float it enough SOL for fees — a
 * single base-layer transaction, the only wallet prompt trading ever costs.
 */
export async function delegateAndGrant(
  p: Program,
  c: Ctx,
  sessionKey: PublicKey,
  durationSecs: BN
) {
  const portfolio = c.acc.portfolioOf(c.owner);
  const d = c.acc.delegationOf(portfolio);
  const grant = await p.methods
    .grantSession(sessionKey, durationSecs)
    .accounts({
      owner: c.owner,
      session: c.acc.sessionOf(c.owner),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return p.methods
    .delegatePortfolio(c.acc.groupId)
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
    .postInstructions([
      grant,
      SystemProgram.transfer({
        fromPubkey: c.owner,
        toPubkey: sessionKey,
        lamports: 30_000_000, // 0.03 SOL of devnet fee float
      }),
    ])
    .rpc();
}

/** Re-arm one-click trading on an already-delegated account. One signature. */
export async function grantSessionOnly(
  p: Program,
  c: Ctx,
  sessionKey: PublicKey,
  durationSecs: BN
) {
  return p.methods
    .grantSession(sessionKey, durationSecs)
    .accounts({
      owner: c.owner,
      session: c.acc.sessionOf(c.owner),
      systemProgram: SystemProgram.programId,
    })
    .postInstructions([
      SystemProgram.transfer({
        fromPubkey: c.owner,
        toPubkey: sessionKey,
        lamports: 30_000_000,
      }),
    ])
    .rpc();
}

/** Rollup: credit the portfolio from the base-layer ledger. Idempotent. */
export async function claimDeposit(p: Program, c: Ctx) {
  return p.methods
    .claimDeposit()
    .accounts({
      caller: c.trader ?? c.owner,
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
 * Confirmation options for the rollup's own instructions.
 *
 * Anchor's default `.rpc()` waits for a websocket confirmation the rollup does
 * not reliably deliver — the same behaviour that hung the deposit modal, and
 * the reason an order that executes in tens of milliseconds took seconds to
 * come back. `processed` is the right level here: the rollup has a single
 * sequencer, so once it has processed the order there is nothing further to
 * wait for.
 */

/** MagicBlock's permission program, and the TEE validator that enforces it. */
const ACL_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/** Rent for permission records comes from the validator's fee vault. */
const MAGIC_FEE_VAULT = PublicKey.findProgramAddressSync(
  [Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()],
  DLP
)[0];
/** The venue's engine — see `setPortfolioPrivate` for why it must be a member. */
const VENUE_KEEPER = new PublicKey("A1iQJhg25EPc8VwXXngJ58GwVJAsCzsMnt2ybSu93yvD");

const ROLLUP: ConfirmOptions = {
  commitment: "processed",
  preflightCommitment: "processed",
  skipPreflight: true,
};

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
    /** Collateral to stand behind this market's position, quote atoms.
     *  Isolated margin: this is the whole risk of the resulting position. */
    collateralAtoms?: BN;
    /** Withhold whatever rests from the public depth ladder. The order keeps
     *  its price-time priority and prints to the tape when it fills — it is
     *  invisible beforehand, not privileged. Dark markets only. */
    hidden?: boolean;
    makers?: PublicKey[];
  }
) {
  const side = args.side === "bid" ? { bid: {} } : { ask: {} };
  const type = { [args.orderType]: {} } as Record<string, object>;
  return p.methods
    .placeOrder(
      side,
      type,
      args.priceInTicks,
      args.baseLots,
      args.clientOrderId,
      args.collateralAtoms ?? new BN(0),
      args.hidden ?? false
    )
    // Crossing several book levels costs more compute than the 200k default.
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .accounts({
      trader: c.trader ?? c.owner,
      session: c.session ?? null,
      market: c.acc.market,
      book: c.acc.book,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      oracleState: c.acc.oracleState,
      portfolio: c.acc.portfolioOf(c.owner),
    } as never)
    .remainingAccounts(
      (args.makers ?? []).map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      }))
    )
    .rpc(ROLLUP);
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
      trader: c.trader ?? c.owner,
      session: c.session ?? null,
      market: c.acc.market,
      book: c.acc.book,
      portfolio: c.acc.portfolioOf(c.owner),
    } as never)
    .rpc(ROLLUP);
}

export async function cancelAll(p: Program, c: Ctx) {
  return p.methods
    .cancelAllOrders()
    .accounts({
      trader: c.trader ?? c.owner,
      session: c.session ?? null,
      market: c.acc.market,
      book: c.acc.book,
      portfolio: c.acc.portfolioOf(c.owner),
    } as never)
    .rpc(ROLLUP);
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
    // Same budget story as placeOrder: a close can walk the whole ladder.
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .accounts({
      trader: c.trader ?? c.owner,
      session: c.session ?? null,
      market: c.acc.market,
      book: c.acc.book,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      oracleState: c.acc.oracleState,
      portfolio: c.acc.portfolioOf(c.owner),
    } as never)
    .remainingAccounts(
      makers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
    )
    .rpc(ROLLUP);
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
      trader: c.trader ?? c.owner,
      session: c.session ?? null,
      market: c.acc.market,
      portfolio: c.acc.portfolioOf(c.owner),
    } as never)
    .rpc();
}

export async function cancelTrigger(p: Program, c: Ctx, triggerId: BN) {
  return p.methods
    .cancelTriggerOrder(triggerId)
    .accounts({
      trader: c.trader ?? c.owner,
      session: c.session ?? null,
      market: c.acc.market,
      portfolio: c.acc.portfolioOf(c.owner),
    } as never)
    .rpc(ROLLUP);
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

/** Rollup: promote proven-backed junior profit into withdrawable capital.
 *  Wins land junior ("losses are senior, wins are junior"); until this runs
 *  a winner's realized PnL is not withdrawable. Permissionless, and a no-op
 *  when nothing qualifies — safe to fire before every withdrawal. */
export async function realizePnl(p: Program, c: Ctx) {
  return p.methods
    .realizePnl()
    .accounts({
      caller: c.owner,
      market: c.acc.market,
      riskGroup: c.acc.riskGroup,
      assetSlots: c.acc.assetSlots,
      portfolio: c.acc.portfolioOf(c.owner),
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

/**
 * Hide a trader's own account: position, entry, collateral — and therefore the
 * price at which they would be liquidated.
 *
 * This is the half of the privacy that costs nobody anything. No taker needs
 * to read a stranger's position to size their own trade, and it is what every
 * other perp venue gives away, which is why liquidation hunting is a sport.
 *
 * Two members, and the second one is a limitation worth stating plainly:
 *
 * - the **owner**, who must sign — the seeds bind this to them, so nobody can
 *   hide or expose somebody else's account
 * - the **keeper**, because the engine that marks positions to market,
 *   liquidates the underwater ones and credits deposits has to be able to read
 *   them. Lock it out and liquidations silently stop firing on live leverage,
 *   which is worse than the exposure it was meant to fix.
 *
 * So the position is hidden from every other trader and from anyone scanning
 * the rollup. It is not hidden from the venue's own engine. That exception is
 * the only one; on every other venue the whole book is the exception.
 *
 * Runs inside the rollup — the permission record can only be made there — and
 * is idempotent enough to retry, since a second call simply finds the record.
 */
export function permissionOf(account: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("permission:"), account.toBuffer()],
    ACL_PROGRAM
  )[0];
}

/**
 * Does this account already carry a permission record?
 *
 * One rollup read. Accounts opened before the venue started hiding them have
 * none, and would otherwise stay readable forever — the record is created
 * once, not on every trade, so asking is what makes this self-limiting.
 */
export async function portfolioIsPrivate(p: Program, c: Ctx): Promise<boolean> {
  const rec = permissionOf(c.acc.portfolioOf(c.owner));
  const info = await p.provider.connection.getAccountInfo(rec).catch(() => null);
  return !!info;
}

export async function setPortfolioPrivate(p: Program, c: Ctx) {
  const portfolio = c.acc.portfolioOf(c.owner);
  const permission = permissionOf(portfolio);
  return p.methods
    .setPortfolioPrivate([
      { pubkey: c.owner, flags: 31 },
      { pubkey: VENUE_KEEPER, flags: 31 },
    ])
    .accounts({
      owner: c.owner,
      portfolio,
      market: c.acc.market,
      permission,
      vault: MAGIC_FEE_VAULT,
      magicProgram: MAGIC_PROGRAM,
      permissionProgram: ACL_PROGRAM,
    } as never)
    .rpc(ROLLUP);
}
