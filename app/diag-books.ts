/**
 * Read-only venue triage: what does every book in the hub actually hold?
 *
 * Answers the only question worth asking first when nothing fills — is one
 * market broken, or is the venue broken everywhere? Reads as the keeper, which
 * is permissioned on the book, so empty here means empty, not filtered.
 *
 * Run: npx ts-node --transpile-only app/diag-books.ts
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
const COUNT = Number(process.env.ANQA_DIAG_COUNT ?? 9);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const NAMES = ["BTC", "SOL", "ETH", "XRP", "DOGE", "LINK", "AVAX", "SUI", "BNB"];

/** Live levels on a side, however the kernel spells "empty". */
function liveLevels(side: any): { n: number; top: string } {
  const levels: any[] = side?.levels ?? side?.orders ?? [];
  const live = levels.filter((l: any) => {
    const q = l?.base_lots ?? l?.baseLots ?? l?.lots ?? l?.size;
    return q && !new BN(q.toString()).isZero();
  });
  const top = live.length
    ? live
        .slice(0, 3)
        .map((l: any) => {
          const p = l?.price_in_ticks ?? l?.priceInTicks ?? l?.price;
          const q = l?.base_lots ?? l?.baseLots ?? l?.lots ?? l?.size;
          return `${p?.toString?.() ?? p}×${q?.toString?.() ?? q}`;
        })
        .join(" ")
    : "—";
  return { n: live.length, top };
}

async function main() {
  const conn = baseConnection(RPC);
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"),
          "utf-8"
        )
      )
    )
  );
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mk = (c: Connection) =>
    new Program(
      idl,
      new anchor.AnchorProvider(c, new anchor.Wallet(keeper), { commitment: "confirmed" })
    ) as any;
  const pEr = mk(er);
  const pBase = mk(conn);

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];

  console.log(`keeper ${keeper.publicKey.toBase58()}`);
  console.log(`hub ${GROUP_ID.toString()} · ER ${ER_RPC}\n`);
  console.log("mkt   sym   owner(ER)     bids  asks  seq  fills  pend   top bid / top ask");

  for (let i = 0; i < COUNT; i++) {
    const id = GROUP_ID.addn(i);
    const book = mpda("anqa_book", id);
    const market = mpda("anqa_market", id);
    const depth = mpda("anqa_depth", id);

    let owner = "?";
    try {
      const ai = await er.getAccountInfo(book);
      owner = ai ? ai.owner.toBase58().slice(0, 8) : "MISSING";
    } catch (e: any) {
      owner = `err:${String(e.message ?? e).slice(0, 12)}`;
    }

    let row = `${id.toString()}  ${(NAMES[i] ?? "?").padEnd(5)} ${owner.padEnd(12)}`;
    try {
      const bk: any = await pEr.account.book.fetch(book);
      const b = liveLevels(bk.bids);
      const a = liveLevels(bk.asks);
      row +=
        ` ${String(b.n).padStart(4)} ${String(a.n).padStart(5)}` +
        ` ${String(bk.seq).padStart(4)} ${String(bk.fill_count ?? bk.fillCount).padStart(6)}` +
        ` ${String(bk.pending_count ?? bk.pendingCount).padStart(5)}   ${b.top} / ${a.top}`;
    } catch (e: any) {
      row += `  book unreadable: ${String(e.message ?? e).slice(0, 60)}`;
    }
    console.log(row);

    // Market + depth: the pair that disagreed on 920.
    try {
      const mkt: any = await pEr.account.market.fetch(market);
      const d: any = await pEr.account.depth.fetch(depth).catch(() => null);
      const paused = mkt.paused ?? mkt.halted ?? "?";
      console.log(
        `        market: dark=${mkt.dark ?? mkt.is_dark ?? "?"} paused=${paused}` +
          ` tick=${mkt.tick_size ?? mkt.tickSize} lot=${mkt.base_lot_size ?? mkt.baseLotSize}` +
          (d ? ` · depth bid/ask=${d.bid_lots ?? d.bidLots}/${d.ask_lots ?? d.askLots}` : " · depth —")
      );
    } catch (e: any) {
      console.log(`        market unreadable: ${String(e.message ?? e).slice(0, 70)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
