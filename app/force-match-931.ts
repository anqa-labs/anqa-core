/** One-shot: take the best non-maker resting order on market 931 at its price.
 *  Copies devnet-auto-match.ts's exact flow, restricted to one market, verbose. */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { teeRpcFor } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN("930");
const MARKET_ID = Number(process.env.ANQA_FORCE_MARKET ?? 931);
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
  const maker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`app/.mm-maker-930.json`, "utf-8")))
  );
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ??
            path.join(os.homedir(), ".config/solana/id.json"),
          "utf-8"
        )
      )
    )
  );
  console.log("maker", maker.publicKey.toBase58());
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
  const trade = prog(maker, new Connection(await teeRpcFor(maker, ER_RPC), "processed"));
  const inspect = prog(keeper, new Connection(await teeRpcFor(keeper, ER_RPC), "processed"));
  const gpda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(GROUP_ID), ...extra], PROGRAM_ID)[0];
  const mpda = (seed: string, marketId: number) =>
    PublicKey.findProgramAddressSync([S(seed), le8(marketId)], PROGRAM_ID)[0];
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const portfolio = gpda("anqa_portfolio", [maker.publicKey.toBuffer()]);
  const market = mpda("anqa_market", MARKET_ID);
  const book = mpda("anqa_book", MARKET_ID);
  const oracleState = mpda("anqa_oracle", MARKET_ID);

  console.log("fetching book…");
  let bk: any = await inspect.account.book.fetch(book);
  console.log("pending_count", Number(field(bk, "pending_count", "pendingCount")));
  const bids = walk(bk.bids);
  console.log("bid queue:", bids.map((o: any) =>
    `${new PublicKey(o.trader).toBase58().slice(0, 6)} ${asBn(field(o, "base_lots", "baseLots"))}@${asBn(field(o, "price_in_ticks", "priceInTicks"))}${Number(o.hidden ?? 0) === 1 ? " hidden" : ""}`
  ).join(" | "));

  const idx = bids.findIndex((o: any) => !new PublicKey(o.trader).equals(maker.publicKey));
  if (idx < 0) throw new Error("no non-maker bid found");
  const target = bids[idx];
  const tPrice = asBn(field(target, "price_in_ticks", "priceInTicks"));
  const tLots = asBn(field(target, "base_lots", "baseLots"));
  console.log("target", new PublicKey(target.trader).toBase58(), `${tLots}@${tPrice}`);

  // Cancel every maker rung ahead of the target.
  for (const order of bids.slice(0, idx)) {
    const id = asBn(field(order, "client_order_id", "clientOrderId"));
    console.log("cancel ahead", id.toString());
    await trade.methods
      .cancelOrder({ bid: {} }, id)
      .accounts({ trader: maker.publicKey, session: null, market, book, portfolio })
      .rpc();
  }

  bk = await inspect.account.book.fetch(book);
  const head = walk(bk.bids)[0];
  if (!head || !new PublicKey(head.trader).equals(new PublicKey(target.trader)))
    throw new Error("target is not head after clearing — aborting");

  console.log("refresh portfolio…");
  await trade.methods
    .refreshPortfolio()
    .accounts({ market, riskGroup, assetSlots, portfolio })
    .rpc();

  console.log("placing IOC ask", `${tLots}@${tPrice}`);
  const sig = await trade.methods
    .placeOrder({ ask: {} }, { immediateOrCancel: {} }, tPrice, tLots,
      new BN(Date.now() % 1_000_000_000), new BN(0), false)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .accounts({
      trader: maker.publicKey, session: null, market, book,
      riskGroup, assetSlots, oracleState, portfolio,
    })
    .rpc();
  console.log("MATCHED", sig);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e?.msg ?? e?.message ?? e);
    process.exit(1);
  }
);
