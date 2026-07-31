/**
 * The Anqa client.
 *
 * One idea shapes this file: a dark venue speaks through **two** connections.
 * Base chain holds custody and the permanent record; the rollup holds the
 * book, the portfolios and the tape. Reads and writes go to whichever side
 * owns the account, and the UI never has to think about it.
 */

import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "./anqa_core.json";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ANQA_PROGRAM ?? "4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j"
);
export const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

export const BASE_RPC =
  process.env.NEXT_PUBLIC_BASE_RPC ?? "https://api.devnet.solana.com";
export const ER_RPC =
  process.env.NEXT_PUBLIC_ER_RPC ?? "https://devnet.magicblock.app";

/** The market the terminal trades. Set per deployment. */
export const MARKET_ID = new BN(process.env.NEXT_PUBLIC_MARKET_ID ?? "0");

const seed = (s: string) => Buffer.from(s);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);

function pda(tag: string, extra: Buffer[] = [], marketId: BN = MARKET_ID) {
  return PublicKey.findProgramAddressSync(
    [seed(tag), le8(marketId), ...extra],
    PROGRAM_ID
  )[0];
}

/** Every account the terminal touches, derived once. */
export function anqaAccounts(marketId: BN = MARKET_ID) {
  return {
    market: pda("anqa_market", [], marketId),
    book: pda("anqa_book", [], marketId),
    riskGroup: pda("anqa_risk", [], marketId),
    assetSlots: pda("anqa_assets", [], marketId),
    oracleState: pda("anqa_oracle", [], marketId),
    internalOracle: pda("anqa_int_oracle", [], marketId),
    vault: pda("anqa_vault", [], marketId),
    tape: pda("anqa_tape", [], marketId),
    portfolioOf: (owner: PublicKey) => pda("anqa_portfolio", [owner.toBuffer()], marketId),
    ledgerOf: (owner: PublicKey) => pda("anqa_ledger", [owner.toBuffer()], marketId),
    depositReceiptOf: (owner: PublicKey) => pda("anqa_dreceipt", [owner.toBuffer()], marketId),
    withdrawReceiptOf: (owner: PublicKey) => pda("anqa_wreceipt", [owner.toBuffer()], marketId),
    permissionOf: (account: PublicKey) =>
      PublicKey.findProgramAddressSync([seed("permission:"), account.toBuffer()], ACL)[0],
    delegationOf: (account: PublicKey) => ({
      buffer: PublicKey.findProgramAddressSync(
        [seed("buffer"), account.toBuffer()],
        PROGRAM_ID
      )[0],
      delegationRecord: PublicKey.findProgramAddressSync(
        [seed("delegation"), account.toBuffer()],
        DLP
      )[0],
      delegationMetadata: PublicKey.findProgramAddressSync(
        [seed("delegation-metadata"), account.toBuffer()],
        DLP
      )[0],
    }),
  };
}

export type AnqaAccounts = ReturnType<typeof anqaAccounts>;

/** A read-only program handle bound to one connection. */
export function readProgram(connection: Connection): Program {
  const provider = new AnchorProvider(
    connection,
    // Reads never sign; a throwaway identity keeps the provider happy.
    { publicKey: PublicKey.default } as never,
    { commitment: "confirmed" }
  );
  return new Program(idl as Idl, provider);
}

/** Both sides of the venue, side by side — the shape of a dark market. */
export function connections() {
  return {
    base: new Connection(BASE_RPC, "confirmed"),
    er: new Connection(ER_RPC, "confirmed"),
  };
}

// ─────────────────────────────── units ───────────────────────────────

/** Quote atoms → display. Collateral is 6-decimal USDC. */
export const QUOTE_DECIMALS = 6;

export function usd(
  atoms: number | bigint | BN | string | undefined,
  digits = 2
): string {
  if (atoms === undefined) return "—";
  const n = Number(atoms.toString()) / 10 ** QUOTE_DECIMALS;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Book prices are tick counts; the mark is quote atoms. */
export function ticksToUsd(ticks: number | BN, tickSize: number | BN): number {
  return (Number(ticks.toString()) * Number(tickSize.toString())) / 10 ** QUOTE_DECIMALS;
}

export function usdToTicks(price: number, tickSize: number | BN): number {
  return Math.round((price * 10 ** QUOTE_DECIMALS) / Number(tickSize.toString()));
}

export const shortKey = (k: PublicKey | string, n = 4) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

// ───────────────────────── account interpretation ─────────────────────────

/** A resting order as the book stores it. */
export type RestingOrder = {
  clientOrderId: BN;
  priceInTicks: BN;
  baseLots: BN;
  seq: BN;
  trader: PublicKey;
  next: number;
  active: number;
};

/** Walk one side of the book in priority order (best first). */
export function walkSide(side: { orders: RestingOrder[]; head: number }): RestingOrder[] {
  const NIL = 65535;
  const out: RestingOrder[] = [];
  let cursor = side.head;
  let guard = 0;
  while (cursor !== NIL && guard++ < 64) {
    const o = side.orders[cursor];
    if (!o) break;
    if (o.active === 1) out.push(o);
    cursor = o.next;
  }
  return out;
}

/** Tape prints, newest first. The ring is written modulo capacity. */
export function readTape(tape: {
  count: BN;
  entries: { fillSeq: BN; priceInTicks: BN; baseLots: BN; timestamp: BN }[];
}) {
  const total = Number(tape.count.toString());
  const cap = tape.entries.length;
  const n = Math.min(total, cap);
  const out = [];
  for (let i = 0; i < n; i++) {
    const slot = (total - 1 - i + cap * 2) % cap;
    const e = tape.entries[slot];
    if (!e || Number(e.fillSeq.toString()) === 0) continue;
    out.push({
      seq: Number(e.fillSeq.toString()),
      priceInTicks: Number(e.priceInTicks.toString()),
      baseLots: Number(e.baseLots.toString()),
      timestamp: Number(e.timestamp.toString()),
    });
  }
  return out;
}

/** Little-endian byte arrays the on-chain Pod types use for wide integers. */
export function leBytesToBN(bytes: number[] | Uint8Array): BN {
  return new BN(Array.from(bytes), 10, "le");
}

export type TriggerSlot = {
  triggerId: number[];
  triggerPrice: number[];
  limitPriceInTicks: number[];
  maxBaseLots: number[];
  armedAtSlot: number[];
  assetIndex: number;
  direction: number;
  active: number;
};

export function readTriggers(triggers: TriggerSlot[]) {
  return triggers
    .filter((t) => t.active === 1)
    .map((t) => ({
      id: leBytesToBN(t.triggerId).toString(),
      price: leBytesToBN(t.triggerPrice),
      limitTicks: leBytesToBN(t.limitPriceInTicks),
      maxLots: leBytesToBN(t.maxBaseLots),
      direction: t.direction === 0 ? ("above" as const) : ("below" as const),
    }));
}

/** Anchor errors are verbose; the trader wants the sentence, not the stack. */
export function readableError(e: any): string {
  const msg = String(e?.message ?? e);
  const anchor = e?.error?.errorMessage ?? e?.errorMessage;
  if (anchor) return anchor;
  const m = msg.match(/Error Message: ([^.]+)\./);
  if (m) return m[1];
  if (msg.includes("User rejected")) return "Rejected in wallet";
  if (msg.includes("insufficient lamports") || msg.includes("Attempt to debit"))
    return "Not enough devnet SOL for rent";
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}
