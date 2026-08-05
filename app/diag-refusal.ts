/**
 * Why does the kernel refuse fills on this market?
 *
 * `settle_fill` treats a kernel refusal as a normal outcome: it logs
 * `anqa: kernel refused dark fill: …`, drops the fill, prints nothing to the
 * tape and opens no position — but the transaction itself succeeds, so the
 * keeper reports "settled" and every surface upstream looks healthy. The only
 * place the reason exists is the program log.
 *
 * This simulates the head settle and prints those logs verbatim.
 *
 * Run: ANQA_DEMO_MARKET=929 npx ts-node --transpile-only app/diag-refusal.ts
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
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 929);
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);

async function main() {
  const conn = baseConnection(RPC);
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(
      process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"
    )))
  );
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(keeper), {
    commitment: "confirmed", skipPreflight: true,
  })) as any;

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  const book = mpda("anqa_book", MARKET_ID);
  const bk: any = await p.account.book.fetch(book);
  const n = Number(bk.pending_count ?? bk.pendingCount);
  console.log(`market ${MARKET_ID}: pending=${n}`);
  if (n === 0) return console.log("nothing pending to settle — place an order first");

  const head = bk.pending[Number(bk.pending_head ?? bk.pendingHead)];
  console.log(`head: ${head.base_lots ?? head.baseLots}@${head.price_in_ticks ?? head.priceInTicks}`);

  const sim = await p.methods
    .settleFill()
    .accounts({
      caller: keeper.publicKey,
      market: mpda("anqa_market", MARKET_ID),
      book,
      riskGroup: gpda("anqa_risk"),
      assetSlots: gpda("anqa_assets"),
      oracleState: mpda("anqa_oracle", MARKET_ID),
      takerPortfolio: gpda("anqa_portfolio", [new PublicKey(head.taker).toBuffer()]),
      makerPortfolio: gpda("anqa_portfolio", [new PublicKey(head.maker).toBuffer()]),
      tape: mpda("anqa_tape", MARKET_ID),
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .simulate()
    .catch((e: any) => ({ raw: e }));

  const logs: string[] = (sim as any)?.raw?.simulationResponse?.logs ?? (sim as any)?.raw?.logs ?? (sim as any)?.logs ?? [];
  console.log("\n── program logs ──");
  for (const l of logs) console.log(" ", l);
  if (!logs.length) console.log(JSON.stringify(sim, null, 1).slice(0, 2000));
}

main().catch((e) => { console.error(e); process.exit(1); });
