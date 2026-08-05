/**
 * What does the venue actually think this trader has?
 *
 * Reads a specific owner's portfolio as the keeper (a member of every
 * portfolio permission, so private accounts answer), decodes the kernel legs
 * the terminal decodes, and then lists every resting order that owner holds on
 * each market's book plus anything of theirs stuck in a pending ring.
 *
 * Run: ANQA_OWNER=<pubkey> npx ts-node --transpile-only app/diag-owner.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { teeRpcFor } from "./tee-auth";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);
const OWNER = new PublicKey(process.env.ANQA_OWNER ?? "6mEKGhcXmCT6dj2Wssyqqov77T6e3rgPiY67QXiYYT62");
/** Markets to sweep: the live nine plus the retired BTC book. */
const IDS = (process.env.ANQA_IDS ?? "920,921,922,923,924,925,926,927,928,929").split(",").map(Number);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);

// Mirrors web/lib/portfolio.ts
const PF_HEADER = 73;
const PF_MAX_ASSETS = 12;
const PF_COLL = PF_HEADER;
const PF_ENTRY = PF_COLL + PF_MAX_ASSETS * 16;
const PF_INNER = PF_ENTRY + PF_MAX_ASSETS * 16;
const CAPITAL = 132;

const u128 = (b: Buffer, off: number) => {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};

async function main() {
  const conn = baseConnection(RPC);
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(
      process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"
    )))
  );
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const pEr = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(keeper), {
    commitment: "confirmed",
  })) as any;

  const mpda = (t: string, id: number) =>
    PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  const portfolio = gpda("anqa_portfolio", [OWNER.toBuffer()]);
  console.log(`\nowner     ${OWNER.toBase58()}`);
  console.log(`portfolio ${portfolio.toBase58()}\n`);

  const info = await er.getAccountInfo(portfolio);
  if (!info) {
    console.log("portfolio unreadable from the ER (even as keeper)");
  } else {
    const b = Buffer.from(info.data);
    console.log(`capital        : ${Number(u128(b, PF_INNER + CAPITAL)) / 1e6}`);

    // Kernel legs — the same decode the terminal's Positions tab performs.
    const LEGS = 340, LEG_STRIDE = 144, MAX_LEGS = 4, POS_SCALE = 1_000_000n;
    const inner = b.subarray(PF_INNER);
    const i128 = (off: number) => {
      const v = u128(Buffer.from(inner), off);
      return v >= 1n << 127n ? v - (1n << 128n) : v;
    };
    console.log(`pnl            : ${Number(i128(148)) / 1e6}`);
    console.log(`initial req    : ${Number(u128(Buffer.from(inner), 2484 + 16)) / 1e6}`);
    console.log(`cert valid     : ${inner[2484 + 120] === 1}`);
    let any = false;
    for (let n = 0; n < MAX_LEGS; n++) {
      const base = LEGS + n * LEG_STRIDE;
      if (inner[base] !== 1) continue;
      const basis = i128(base + 14);
      if (basis === 0n) continue;
      any = true;
      const lots = (basis < 0n ? -basis : basis) / POS_SCALE;
      console.log(`  POSITION asset ${Number(u128(Buffer.from(inner), base + 1) & 0xffffffffn)} ` +
        `${inner[base + 13] === 0 ? "LONG" : "SHORT"} ${lots} lots`);
    }
    if (!any) console.log("  (no active kernel positions)");
    for (let a = 0; a < PF_MAX_ASSETS; a++) {
      const coll = Number(u128(b, PF_COLL + a * 16)) / 1e6;
      const entry = Number(u128(b, PF_ENTRY + a * 16)) / 1e6;
      if (coll || entry) console.log(`  asset ${a}: collateral $${coll}  entry ${entry}`);
    }
  }

  console.log("\n── resting orders and pending fills by market ──");
  for (const id of IDS) {
    const book = mpda("anqa_book", id);
    let bk: any;
    try {
      bk = await pEr.account.book.fetch(book);
    } catch {
      console.log(`${id}: book unreadable`);
      continue;
    }
    const mine: string[] = [];
    for (const [label, side] of [["bid", bk.bids], ["ask", bk.asks]] as const) {
      for (const o of side.orders ?? []) {
        if (o?.active !== 1) continue;
        if (new PublicKey(o.trader).equals(OWNER))
          mine.push(`${label} ${o.base_lots ?? o.baseLots}@${o.price_in_ticks ?? o.priceInTicks} hidden=${o.hidden}`);
      }
    }
    const pendMine: string[] = [];
    const head = Number(bk.pending_head ?? bk.pendingHead);
    const cnt = Number(bk.pending_count ?? bk.pendingCount);
    for (let i = 0; i < cnt; i++) {
      const p = bk.pending[(head + i) % 16];
      const t = new PublicKey(p.taker), m = new PublicKey(p.maker);
      if (t.equals(OWNER) || m.equals(OWNER))
        pendMine.push(`${p.base_lots ?? p.baseLots}@${p.price_in_ticks ?? p.priceInTicks} as ${t.equals(OWNER) ? "taker" : "maker"}`);
    }
    if (mine.length || pendMine.length || cnt) {
      console.log(`${id}: resting=[${mine.join(", ") || "-"}] pendingTotal=${cnt} minePending=[${pendMine.join(", ") || "-"}]`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
