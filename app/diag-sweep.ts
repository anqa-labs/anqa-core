/**
 * Probe `sweep_backing` on every domain and report what the kernel says.
 *
 * A `Fresh` backing bucket past its expiry makes the kernel refuse to create a
 * counterparty lien — `prepare_counterparty_lien_create_delta` returns
 * `LockActive` — which is exactly the error `settle_fill` swallows when it
 * drops a dark fill. The keeper calls this instruction blind on both domains
 * of every asset and discards the error with `.catch(() => {})`, so a sweep
 * that *fails* is indistinguishable from one that had nothing to do.
 *
 * Domains are `asset * 2` and `asset * 2 + 1`.
 *
 * Run: npx ts-node --transpile-only app/diag-sweep.ts
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
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);
/** Any market in the hub works — sweep only reads group-scoped state. */
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 929);
const DOMAINS = (process.env.ANQA_DOMAINS ?? "0,1,2,3").split(",").map(Number);

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
    commitment: "confirmed", skipPreflight: false,
  })) as any;

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string) => PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID)], PROGRAM_ID)[0];

  const accounts = {
    caller: keeper.publicKey,
    market: mpda("anqa_market", MARKET_ID),
    riskGroup: gpda("anqa_risk"),
    assetSlots: gpda("anqa_assets"),
  };

  for (const domain of DOMAINS) {
    process.stdout.write(`domain ${domain} (asset ${Math.floor(domain / 2)} ${domain % 2 ? "short" : "long"}): `);
    try {
      await p.methods.sweepBacking(domain)
        .accounts(accounts)
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc();
      console.log("SWEPT");
    } catch (e: any) {
      const sim: any = await p.methods.sweepBacking(domain)
        .accounts(accounts)
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .simulate()
        .catch((x: any) => ({ raw: x }));
      const logs: string[] = sim?.raw?.simulationResponse?.logs ?? sim?.raw?.logs ?? sim?.logs ?? [];
      const reason = logs.find((l) => l.includes("anqa:") || l.includes("Error Message"));
      console.log(`refused — ${reason?.replace("Program log: ", "") ?? String(e?.msg ?? e?.message ?? e).slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
