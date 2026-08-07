/** One-shot: cancel every resting order the retired demo-maker key still has
 *  across the hub's markets, so the auto-matcher stops servicing a stale
 *  backlog ahead of real user orders. */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { teeRpcFor } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN("930");
const MARKETS = [930, 931, 932, 933, 934, 935, 936, 937, 938];
const NIL = 0xffff;

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const field = (x: any, snake: string, camel: string) => x?.[snake] ?? x?.[camel];
const asBn = (x: any) => new BN(x?.toString?.() ?? String(x));

function walk(side: any): any[] {
  const result: any[] = [];
  const orders = side?.orders ?? [];
  let cursor = Number(side?.head ?? NIL);
  const visited = new Set<number>();
  while (cursor !== NIL && cursor >= 0 && cursor < orders.length && !visited.has(cursor)) {
    visited.add(cursor);
    const order = orders[cursor];
    if (!order) break;
    if (order.active === 1) result.push(order);
    cursor = Number(order.next ?? NIL);
  }
  return result;
}

async function main() {
  const demo = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("app/.demo-maker-930.json", "utf-8")))
  );
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
  console.log("demo maker", demo.publicKey.toBase58());
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const prog = (signer: Keypair, conn: Connection) =>
    new Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(signer), {
        commitment: "processed",
        preflightCommitment: "processed",
        skipPreflight: true,
      })
    ) as any;
  const trade = prog(demo, new Connection(await teeRpcFor(demo, ER_RPC), "processed"));
  const inspect = prog(keeper, new Connection(await teeRpcFor(keeper, ER_RPC), "processed"));
  const gpda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(GROUP_ID), ...extra], PROGRAM_ID)[0];
  const mpda = (seed: string, marketId: number) =>
    PublicKey.findProgramAddressSync([S(seed), le8(marketId)], PROGRAM_ID)[0];
  const portfolio = gpda("anqa_portfolio", [demo.publicKey.toBuffer()]);

  let total = 0;
  for (const marketId of MARKETS) {
    const market = mpda("anqa_market", marketId);
    const book = mpda("anqa_book", marketId);
    const bk: any = await inspect.account.book.fetch(book).catch(() => null);
    if (!bk) {
      console.log(marketId, "book unreadable, skipping");
      continue;
    }
    for (const side of ["bid", "ask"] as const) {
      const mine = walk(side === "bid" ? bk.bids : bk.asks).filter((o: any) =>
        new PublicKey(o.trader).equals(demo.publicKey)
      );
      for (const order of mine) {
        const id = asBn(field(order, "client_order_id", "clientOrderId"));
        try {
          await trade.methods
            .cancelOrder(side === "bid" ? { bid: {} } : { ask: {} }, id)
            .accounts({ trader: demo.publicKey, session: null, market, book, portfolio })
            .rpc();
          total++;
        } catch (e: any) {
          console.log(marketId, side, id.toString(), "cancel failed:",
            String(e?.msg ?? e?.message ?? e).slice(0, 80));
        }
      }
      if (mine.length) console.log(marketId, side, `cancelled ${mine.length}`);
    }
  }
  console.log("DONE", total, "stale orders cancelled");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e?.msg ?? e?.message ?? e);
    process.exit(1);
  }
);
