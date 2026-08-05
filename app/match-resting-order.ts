/**
 * Operator utility: cross one exact resting order with the funded demo maker.
 *
 * Safety properties:
 * - requires target owner, price and lots explicitly;
 * - refuses unless exactly one matching target order is live and the queue is clear;
 * - cancels only the demo maker's bids ahead of the target (never another trader's);
 * - re-reads the private book before submitting an exact IOC counter-order.
 *
 * Run:
 *   ANQA_GROUP=930 ANQA_MARKET=930 ANQA_TARGET=<owner> \
 *   ANQA_PRICE=64580 ANQA_LOTS=154 npx ts-node --transpile-only app/match-resting-order.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { teeRpcFor } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? "");
const MARKET_ID = new BN(process.env.ANQA_MARKET ?? "");
const TARGET = new PublicKey(process.env.ANQA_TARGET ?? "");
const PRICE = new BN(process.env.ANQA_PRICE ?? "");
const LOTS = new BN(process.env.ANQA_LOTS ?? "");

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const value = (x: any, snake: string, camel: string) => x?.[snake] ?? x?.[camel];
const live = (side: any) => (side?.orders ?? []).filter((o: any) => o?.active === 1);

async function main() {
  if (GROUP_ID.isZero() || MARKET_ID.isZero() || PRICE.isZero() || LOTS.isZero()) {
    throw new Error("ANQA_GROUP, ANQA_MARKET, ANQA_TARGET, ANQA_PRICE and ANQA_LOTS are required");
  }

  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
    process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"
  ))));
  const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
    `app/.demo-maker-${GROUP_ID.toString()}.json`, "utf-8"
  ))));
  if (maker.publicKey.equals(TARGET)) throw new Error("target cannot be the demo maker");

  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const keeperEr = new Connection(await teeRpcFor(keeper, ER_RPC), "processed");
  const makerEr = new Connection(await teeRpcFor(maker, ER_RPC), "processed");
  const program = (c: Connection, signer: Keypair) => new Program(
    idl,
    new anchor.AnchorProvider(c, new anchor.Wallet(signer), {
      commitment: "processed", preflightCommitment: "processed", skipPreflight: true,
    })
  ) as any;
  const inspect = program(keeperEr, keeper);
  const trade = program(makerEr, maker);

  const mpda = (seed: string) => PublicKey.findProgramAddressSync(
    [S(seed), le8(MARKET_ID)], PROGRAM_ID
  )[0];
  const gpda = (seed: string, extra: Buffer[] = []) => PublicKey.findProgramAddressSync(
    [S(seed), le8(GROUP_ID), ...extra], PROGRAM_ID
  )[0];
  const market = mpda("anqa_market");
  const book = mpda("anqa_book");
  const oracleState = mpda("anqa_oracle");
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const portfolio = gpda("anqa_portfolio", [maker.publicKey.toBuffer()]);

  const read = () => inspect.account.book.fetch(book);
  const targetOrders = (bk: any) => live(bk.bids).filter((o: any) =>
    new PublicKey(o.trader).equals(TARGET) &&
    new BN(value(o, "price_in_ticks", "priceInTicks").toString()).eq(PRICE) &&
    new BN(value(o, "base_lots", "baseLots").toString()).eq(LOTS)
  );

  let bk: any = await read();
  const pending = Number(value(bk, "pending_count", "pendingCount"));
  if (pending !== 0) throw new Error(`refusing with ${pending} fill(s) already pending`);
  if (targetOrders(bk).length !== 1) {
    throw new Error("the exact target bid is not uniquely live; nothing changed");
  }

  // Any bid priced above the target has priority over it. Only remove quotes
  // owned by this test maker; another trader ahead of the target is a hard stop.
  const ahead = live(bk.bids).filter((o: any) =>
    new BN(value(o, "price_in_ticks", "priceInTicks").toString()).gte(PRICE)
  );
  const foreignAhead = ahead.filter((o: any) =>
    !new PublicKey(o.trader).equals(maker.publicKey) && !new PublicKey(o.trader).equals(TARGET)
  );
  if (foreignAhead.length) throw new Error("another trader has bid priority; refusing to fill the wrong account");

  for (const o of ahead.filter((x: any) => new PublicKey(x.trader).equals(maker.publicKey))) {
    const coid = new BN(value(o, "client_order_id", "clientOrderId").toString());
    await trade.methods.cancelOrder({ bid: {} }, coid)
      .accounts({ trader: maker.publicKey, session: null, market, book, portfolio })
      .rpc();
    console.log(`cancelled venue bid ${value(o, "base_lots", "baseLots")}@${value(o, "price_in_ticks", "priceInTicks")}`);
  }

  bk = await read();
  if (Number(value(bk, "pending_count", "pendingCount")) !== 0 || targetOrders(bk).length !== 1) {
    throw new Error("target changed while clearing venue quotes; refusing to submit");
  }
  const bestBid = Math.max(...live(bk.bids).map((o: any) =>
    Number(value(o, "price_in_ticks", "priceInTicks"))
  ));
  if (bestBid !== PRICE.toNumber()) throw new Error(`target is not next in queue (best bid ${bestBid})`);

  await trade.methods.refreshPortfolio()
    .accounts({ market, riskGroup, assetSlots, portfolio })
    .rpc();

  const sig = await trade.methods.placeOrder(
    { ask: {} }, { immediateOrCancel: {} }, PRICE, LOTS,
    new BN(Date.now() % 1_000_000_000), new BN(0), false
  )
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .accounts({
      trader: maker.publicKey, session: null, market, book,
      riskGroup, assetSlots, oracleState, portfolio,
    })
    .rpc();

  bk = await read();
  const count = Number(value(bk, "pending_count", "pendingCount"));
  const head = Number(value(bk, "pending_head", "pendingHead"));
  if (count !== 1) throw new Error(`order submitted (${sig}) but expected one pending fill, found ${count}`);
  const fill = bk.pending[head];
  if (!new PublicKey(fill.maker).equals(TARGET) ||
      new BN(value(fill, "price_in_ticks", "priceInTicks").toString()).cmp(PRICE) !== 0 ||
      new BN(value(fill, "base_lots", "baseLots").toString()).cmp(LOTS) !== 0) {
    throw new Error(`order submitted (${sig}) but pending fill does not match the requested target`);
  }
  console.log(`queued exact fill ${LOTS.toString()}@${PRICE.toString()} maker=${TARGET.toBase58()} sig=${sig}`);
}

main().catch((e: any) => {
  console.error(e?.logs ?? e?.message ?? e);
  process.exit(1);
});
