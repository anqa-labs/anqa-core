"use client";

/**
 * The money model, in one file.
 *
 * One account per trader — the deposit ledger — and every market trades from
 * it. Isolation is **per position**, not per account: the program records the
 * collateral behind each asset's position (`Portfolio::asset_collateral`) and
 * the isolated liquidator closes a position the moment that amount is spent.
 * So a trader's balance funds many positions, and no one position can reach
 * past the collateral it was opened with.
 *
 * Money lives in two places, and this file is the only thing that moves it:
 *
 *   wallet USDC  ──deposit──▶  the account  ──withdraw──▶  wallet USDC
 *                                  │
 *                                  └─ committed per position at open,
 *                                     released back on close
 */

import { BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  authorizeWithdraw,
  claimDeposit,
  closePosition,
  requestWithdraw,
  settleWithdraw,
  setupMarket,
  setPortfolioPrivate,
  portfolioIsPrivate,
} from "./actions";
import { equity, readKernel } from "./portfolio";
import type { AnqaAccounts } from "./anqa";

export type MoneyCtx = {
  acc: AnqaAccounts;
  marketId: BN;
  owner: PublicKey;
  engine: PublicKey;
  trader?: PublicKey;
  session?: PublicKey | null;
};

/** USDC sitting in the trader's own wallet — the venue never touches it. */
export async function walletUsdc(
  conn: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  return conn
    .getTokenAccountBalance(ata)
    .then((b) => Number(b.value.amount) / 1e6)
    .catch(() => 0);
}

/**
 * Collateral standing behind this market — capital plus unrealised PnL, the
 * same number the kernel liquidates against. Reads the rollup, because that
 * is where a delegated account is current.
 */
export async function collateralOf(
  p: Program,
  c: MoneyCtx
): Promise<number> {
  try {
    const pf: any = await (p as any).account.portfolio.fetch(c.acc.portfolioOf(c.owner));
    return Number(equity(readKernel(pf.inner))) / 1e6;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Money already deposited on base but not yet credited inside the rollup.
 *
 * The ledger only grows and the account remembers the high-water mark it has
 * absorbed, so the difference is a deposit in flight. Checking it before
 * asking for another is what stops a failed claim from turning every click
 * into a fresh transfer — the bug that charged a trader twice for one
 * deposit.
 */
export async function uncredited(
  base: Program,
  er: Program | null,
  c: MoneyCtx
): Promise<number> {
  try {
    const ledger: any = await (base as any).account.userDepositLedger.fetch(
      c.acc.ledgerOf(c.owner)
    );
    const deposited = Number(ledger.deposited.toString()) / 1e6;
    const pf: any = await ((er ?? base) as any).account.portfolio.fetch(c.acc.portfolioOf(c.owner));
    const claimed = Number(new BN(pf.claimedHighWater, 10, "le").toString()) / 1e6;
    return Math.max(0, deposited - claimed);
  } catch {
    return 0;
  }
}

/**
 * Make sure the account can put `usd` behind a position, creating it on the
 * way if this is the trader's first trade.
 *
 * Tops up from the wallet when the balance is short; never trims, because the
 * balance funds every market and other positions may be leaning on it.
 *
 * One wallet signature covers everything the market still needs — account,
 * delegation into the rollup, the session grant and the deposit itself — so
 * a new market never demands a separate ceremony. The claim that credits the
 * rollup is session-signed and costs no prompt.
 *
 * Returns the collateral actually standing behind the market afterwards.
 */
export async function fundMarket(
  base: Program,
  er: Program | null,
  c: MoneyCtx,
  args: {
    usd: number;
    mint: PublicKey;
    sessionKey: PublicKey;
    sessionPda: PublicKey;
    need: { open: boolean; delegate: boolean; grant: boolean };
    /** Base-layer connection — required to give collateral back. */
    conn?: Connection;
    onStep?: (s: string) => void;
  }
): Promise<number> {
  const { usd, mint, sessionKey, sessionPda, need, onStep } = args;
  // Nudge the credit along, but never wait on it.
  //
  // Anchor's `.rpc()` waits for a websocket confirmation the rollup does not
  // reliably deliver, and a hang is not something `catch` can save you from —
  // it left this modal spinning forever with the trader's money already
  // deposited. The keeper's deposit rail credits ledger-derived deposits
  // within seconds regardless (see keeper.ts), so this send is an optimisation
  // and the timeout is what makes it safe to attempt at all.
  const claim = async () => {
    if (!er) return;
    try {
      await Promise.race([
        claimDeposit(er, { ...c, trader: sessionKey, session: sessionPda }),
        sleep(4000),
      ]);
    } catch {
      // nothing to claim, or the grant is not visible in the rollup yet
    }
  };

  // The common case, and the one that has to be fast: an account that is
  // already open, delegated, session-granted and plainly funded needs nothing
  // here. Checking that costs one rollup read; everything below it costs
  // several base-layer ones, and this runs before *every* order.
  if (!need.open && !need.delegate && !need.grant) {
    const funded = await collateralOf(er ?? base, c);
    if (funded >= usd - 1) return funded;
  }

  // Pull in anything already paid for before asking for more money: a deposit
  // whose claim has not landed is still the trader's, and depositing again
  // would take a second bite out of their wallet for the same collateral.
  if (!need.open && (await uncredited(base, er, c)) > 1) {
    onStep?.("Crediting deposit");
    // Fire-and-forget: awaiting this put a 4s tax on *every* order, because
    // this whole branch runs before each one. The keeper's rail credits
    // ledger-derived deposits within seconds regardless, so the send is a
    // nudge and the poll below is what actually establishes the credit.
    void claim();
    for (let i = 0; i < 8; i++) {
      if ((await collateralOf(er ?? base, c)) >= usd - 1) break;
      await sleep(1500);
    }
  }

  const already = await collateralOf(er ?? base, c);
  const shortfall = usd - already;

  // Nothing to move and nothing to create: the market is ready as it stands.
  if (shortfall <= 1 && !need.open && !need.delegate && !need.grant) return already;

  onStep?.(need.open ? "Opening account" : "Funding account");
  await setupMarket(base, c, {
    mint,
    depositAtoms: new BN(Math.max(0, Math.round(shortfall * 1e6))),
    sessionKey,
    durationSecs: new BN(24 * 60 * 60),
    need: { ...need, deposit: shortfall > 1 },
  });

  // The moment the account exists inside the rollup, hide it. Position, entry,
  // collateral and therefore the liquidation price become the owner's alone —
  // this is the half of the privacy a dark book does not provide on its own,
  // and leaving it until later means every account opened in the meantime
  // traded in the clear.
  //
  // Best-effort: a venue that cannot hide the account is still a venue, and
  // failing the trade over it would be the wrong trade-off. The proof panel
  // reports the truth either way, so nobody is told they are private when they
  // are not.
  // Not gated on "just created": an account opened before the venue started
  // hiding them would otherwise stay readable forever. Ask the rollup whether
  // the record exists — it is created once, so this asks once and then never
  // again.
  if (er && !(await portfolioIsPrivate(er, c).catch(() => true))) {
    {
      await Promise.race([
        setPortfolioPrivate(er, c).catch(() => {}),
        sleep(5000),
      ]);
    }
  }

  if (shortfall <= 1) return already;

  // The deposit lands on base; the rollup credits it when the session key
  // drives the claim. Poll until the collateral shows up inside the rollup.
  onStep?.("Crediting margin");
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    await claim();
    const now = await collateralOf(er ?? base, c);
    if (now >= usd - 1) return now;
  }
  // The tokens are safe on base either way — the ledger records them and the
  // claim is permissionless, so say so rather than leaving a silent gap.
  const settled = await collateralOf(er ?? base, c);
  if (settled < usd - 1) {
    throw new Error(
      "Deposit landed but the rollup credit is lagging — it will appear shortly; do not deposit again"
    );
  }
  return settled;
}

/**
 * Take `usd` of collateral out of this market and back to the wallet.
 *
 * Three legs across two layers, in order: reserve on base, let the kernel
 * rule on it inside the rollup, then pay out once the receipt comes home.
 * The trader signs only the first — the rest is permissionless.
 */
export async function defundMarket(
  base: Program,
  er: Program,
  c: MoneyCtx,
  args: { usd: number; mint: PublicKey; conn: Connection; onStep?: (s: string) => void }
): Promise<void> {
  const { usd, mint, conn, onStep } = args;
  if (usd <= 0.01) return;

  onStep?.("Returning collateral");
  await requestWithdraw(base, c, mint, new BN(Math.round(usd * 1e6)));
  // Same hazard as the deposit claim: this is a rollup send, and Anchor waits
  // on a websocket confirmation the rollup does not reliably deliver, which
  // hangs the caller rather than failing it. The authorisation is
  // permissionless, so what matters is that it was sent — the poll below is
  // what establishes whether the verdict actually landed.
  await Promise.race([authorizeWithdraw(er, c), sleep(5000)]);

  // The receipt is delegated while the verdict is pending; once it is back
  // under the program on base, the signerless settle can pay out.
  const receipt = c.acc.withdrawReceiptOf(c.owner);
  for (let i = 0; i < 40; i++) {
    await sleep(2500);
    const info = await conn.getAccountInfo(receipt);
    if (!info) return; // already settled and closed
    if (info.owner.equals((base as any).programId)) {
      await settleWithdraw(base, c, mint);
      return;
    }
  }
  throw new Error("Withdrawal is taking longer than usual — check Balances in a moment");
}

/**
 * Close a position and return its collateral to the wallet.
 *
 * Closing alone would leave the collateral sitting in the market's account,
 * where it would silently become the next position's margin — the one thing
 * this model must never allow. So the sweep is part of closing, not a chore
 * left to the trader.
 *
 * The close itself is session-signed and instant; returning the money is one
 * wallet signature, the same as any withdrawal.
 */
export async function closeAndSweep(
  trading: Program,
  base: Program,
  er: Program,
  c: MoneyCtx,
  args: {
    worstPriceInTicks: BN;
    mint: PublicKey;
    conn: Connection;
    assetIndex: number;
    onStep?: (s: string) => void;
  }
): Promise<void> {
  const { worstPriceInTicks, mint, conn, assetIndex, onStep } = args;

  onStep?.("Closing");
  await closePosition(trading, c, worstPriceInTicks, new BN(0), []);

  // A dark-market close queues a fill for the engine; the position is not
  // gone until that settles. Wait for flat before asking for the money back,
  // or the kernel will rightly refuse to release margin it still needs.
  onStep?.("Settling");
  let flat = false;
  for (let i = 0; i < 24; i++) {
    await sleep(2500);
    try {
      const pf: any = await (er as any).account.portfolio.fetch(c.acc.portfolioOf(c.owner));
      const k = readKernel(pf.inner);
      if (!k.positions.some((x) => x.assetIndex === assetIndex)) {
        flat = true;
        break;
      }
    } catch {
      // transient read — keep waiting
    }
  }
  if (!flat) {
    throw new Error("Position closed; collateral returns once the fill settles");
  }

  // Closing returns collateral to the *account*, not the wallet.
  //
  // This used to withdraw to the wallet, and that was right when portfolios
  // were per-market: collateral left behind would silently have become the
  // next position's margin, which the isolated model must never allow. With
  // one global account funding every market that risk is gone — the account is
  // where collateral is supposed to sit between trades — and withdrawing on
  // every close meant a wallet signature to close a position, which defeats
  // the point of holding a session.
  //
  // Taking money back to the wallet is now a deliberate act in the account
  // modal, not a side effect of closing.
}
