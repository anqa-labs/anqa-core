/**
 * Re-anchor a market's oracle and report what actually happens.
 *
 * `reanchor_oracle` snaps an asset's effective price onto its raw oracle
 * target. Until it lands, the gap between the two keeps the kernel's lock
 * armed and every risk-increasing trade is refused with `LockActive` — which
 * `settle_fill` then swallows: the fill is consumed, no position opens, and
 * the keeper still logs "settled".
 *
 * The provisioning script calls this too, but reports failures through
 * `String(e?.message ?? e)`, which is the empty string for rollup errors — so
 * a reanchor that never succeeded looks like a blank line.
 *
 * Run: ANQA_DEMO_MARKET=929 ANQA_ASSET_INDEX=0 npx ts-node --transpile-only app/diag-reanchor.ts
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
const ASSET = Number(process.env.ANQA_ASSET_INDEX ?? 0);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Rollup errors hide their text in `.msg`; `.message` is often "". */
const err = (e: any) => String(e?.msg ?? (e?.message || String(e))).slice(0, 160);

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
    commitment: "confirmed", skipPreflight: false,
  })) as any;

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string) => PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID)], PROGRAM_ID)[0];

  const accounts = {
    cranker: keeper.publicKey,
    market: mpda("anqa_market", MARKET_ID),
    riskGroup: gpda("anqa_risk"),
    assetSlots: gpda("anqa_assets"),
    oracleState: mpda("anqa_oracle", MARKET_ID),
    internalOracle: mpda("anqa_int_oracle", MARKET_ID),
    venueClock: gpda("anqa_clock"),
  };

  const showMark = async (label: string) => {
    const os1: any = await p.account.oracleState.fetch(accounts.oracleState).catch(() => null);
    const io: any = await p.account.internalOracle.fetch(accounts.internalOracle).catch(() => null);
    console.log(`${label}: oracleState.lastPrice=${os1?.lastPrice} · relay.publishTime=${io?.publishTime}`);
  };

  await showMark("before");

  console.log(`\nreanchor_oracle(asset ${ASSET}) on market ${MARKET_ID}…`);
  try {
    const sig = await p.methods.reanchorOracle(ASSET)
      .accounts(accounts)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    console.log(`  ✓ re-anchored — ${sig}`);
  } catch (e: any) {
    console.log(`  ✗ FAILED: ${err(e)}`);
    const sim: any = await p.methods.reanchorOracle(ASSET)
      .accounts(accounts)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .simulate()
      .catch((x: any) => ({ raw: x }));
    const logs: string[] = sim?.raw?.simulationResponse?.logs ?? sim?.raw?.logs ?? sim?.logs ?? [];
    console.log("  logs:"); for (const l of logs) console.log("   ", l);
  }

  await sleep(1500);
  console.log(`\ncrank(asset ${ASSET})…`);
  try {
    await p.methods.crank(ASSET, new BN(0))
      .accounts(accounts)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
      .rpc();
    console.log("  ✓ cranked");
  } catch (e: any) {
    console.log(`  ✗ crank FAILED: ${err(e)}`);
  }

  await sleep(1500);
  await showMark("after");
}

main().catch((e) => { console.error(e); process.exit(1); });
