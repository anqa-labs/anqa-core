/**
 * Why won't 920 take an ask?
 *
 * Dumps the full bid ladder with active flags and owners, the pending-fill
 * ring, and then attempts one post-only ask at the maker's price — printing
 * the *entire* error object, because the thing that has been hiding this bug
 * is an exception whose `.message` is the empty string.
 *
 * Read-only except for the single probe order, which is post-only (it either
 * rests or is refused; it can never take liquidity).
 *
 * Run: npx ts-node --transpile-only app/diag-920.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { teeRpcFor } from "./tee-auth";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 920);
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);
const PROBE = process.env.ANQA_PROBE !== "0";

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);

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
  const maker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`app/.demo-maker-${GROUP_ID}.json`, "utf-8")))
  );

  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const erKeeper = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const erMaker = new Connection(await teeRpcFor(maker, ER_RPC), "confirmed");
  const mk = (c: Connection, kp: Keypair) =>
    new Program(
      idl,
      new anchor.AnchorProvider(c, new anchor.Wallet(kp), { commitment: "confirmed" })
    ) as any;
  const pKeeper = mk(erKeeper, keeper);
  const pMaker = mk(erMaker, maker);

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  const market = mpda("anqa_market", MARKET_ID);
  const book = mpda("anqa_book", MARKET_ID);
  const oracleState = mpda("anqa_oracle", MARKET_ID);
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const portfolio = gpda("anqa_portfolio", [maker.publicKey.toBuffer()]);

  console.log(`market ${MARKET_ID} · maker ${maker.publicKey.toBase58()}\n`);

  const bk: any = await pKeeper.account.book.fetch(book);
  const os1: any = await pKeeper.account.oracleState.fetch(oracleState).catch(() => null);
  // The keeper reads the mark as oracleState.lastPrice / 1e6.
  const markTicks = os1 ? Math.round(Number(os1.lastPrice) / 1e3) : 0;
  console.log(`oracleState.lastPrice = ${os1?.lastPrice} → mark $${(Number(os1?.lastPrice ?? 0) / 1e6).toLocaleString()} → ~${markTicks} ticks`);
  console.log(`seq=${bk.seq} fills=${bk.fill_count ?? bk.fillCount} pending=${bk.pending_count ?? bk.pendingCount} head=${bk.pending_head ?? bk.pendingHead}\n`);

  const dump = (label: string, side: any) => {
    console.log(`${label}:`);
    (side.orders ?? []).forEach((o: any, i: number) => {
      if (!o || o.active !== 1) return;
      const px = Number(o.price_in_ticks ?? o.priceInTicks);
      console.log(
        `  [${String(i).padStart(2)}] px=${String(px).padStart(7)}` +
          ` lots=${String(o.base_lots ?? o.baseLots).padStart(6)}` +
          ` rem=${String(o.remaining_lots ?? o.remainingLots ?? "-").padStart(6)}` +
          ` seq=${String(o.seq ?? "-").padStart(4)}` +
          ` hidden=${o.hidden ?? "-"}` +
          ` owner=${(o.owner?.toBase58?.() ?? String(o.owner)).slice(0, 8)}` +
          (markTicks && px > markTicks ? "   <-- ABOVE MARK" : "")
      );
    });
  };
  dump("BIDS", bk.bids);
  dump("ASKS", bk.asks);

  console.log("\nPENDING RING:");
  (bk.pending ?? []).forEach((p: any, i: number) => {
    const lots = Number(p?.base_lots ?? p?.baseLots ?? 0);
    if (!lots) return;
    console.log(
      `  [${i}] px=${p.price_in_ticks ?? p.priceInTicks} lots=${lots}` +
        ` taker=${(p.taker?.toBase58?.() ?? String(p.taker)).slice(0, 8)}` +
        ` maker=${(p.maker?.toBase58?.() ?? String(p.maker)).slice(0, 8)}`
    );
  });

  if (!PROBE) return;

  const surface = (e: any) => {
    console.log("   name        :", e?.name);
    console.log("   message     :", JSON.stringify(e?.message));
    console.log("   msg         :", JSON.stringify(e?.msg));
    console.log("   code        :", JSON.stringify(e?.code));
    console.log("   error.code  :", JSON.stringify(e?.error?.errorCode));
    console.log("   logs        :", JSON.stringify(e?.logs ?? e?.transactionLogs, null, 1)?.slice(0, 3000));
    console.log("   toString    :", String(e).slice(0, 400));
  };

  // 1) Why is the FIFO stuck? Settle the head fill as the keeper would.
  const n = Number(bk.pending_count ?? bk.pendingCount ?? 0);
  if (n > 0) {
    const head = bk.pending[Number(bk.pending_head ?? bk.pendingHead)];
    console.log(
      `\nprobing settleFill on head [${bk.pending_head ?? bk.pendingHead}]` +
        ` ${head.base_lots ?? head.baseLots}@${head.price_in_ticks ?? head.priceInTicks}…`
    );
    try {
      const sig = await pKeeper.methods
        .settleFill()
        .accounts({
          caller: keeper.publicKey,
          market, book, riskGroup, assetSlots, oracleState,
          takerPortfolio: gpda("anqa_portfolio", [new PublicKey(head.taker).toBuffer()]),
          makerPortfolio: gpda("anqa_portfolio", [new PublicKey(head.maker).toBuffer()]),
          tape: mpda("anqa_tape", MARKET_ID),
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
        .rpc({ skipPreflight: false });
      console.log(`  SETTLED — ${sig}`);
    } catch (e: any) {
      console.log("  settleFill FAILED:");
      surface(e);
    }
  }

  if (process.env.ANQA_SETTLE_ONLY === "1") return;

  // 2) One post-only ask, exactly where the maker's level 1 would go.
  const off = Math.max(1, Math.round((markTicks * 2 * 1) / 10_000));
  const px = markTicks + off;
  console.log(`\nprobing post-only ASK at ${px} (mark ${markTicks} + ${off})…`);
  try {
    const sig = await pMaker.methods
      .placeOrder({ ask: {} }, { postOnly: {} }, new BN(px), new BN(100), new BN(Date.now() % 1e9), new BN(0), false)
      .accounts({
        trader: maker.publicKey, session: null, market, book, riskGroup, assetSlots, oracleState, portfolio,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
      .rpc({ skipPreflight: false });
    console.log(`  RESTED — ${sig}`);
  } catch (e: any) {
    console.log("  placeOrder FAILED:");
    surface(e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
