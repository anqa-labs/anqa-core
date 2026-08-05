/**
 * Drive the counterparty-backing lifecycle by hand and report every step.
 *
 * A backing bucket is what lets the kernel create the counterparty lien a
 * risk-increasing fill needs. Buckets are born only as a by-product of a
 * *losing* account's capital being crystallized (`reserve_new_capital_backed_
 * loss_for_source_domain`), they carry an expiry, and once `Expired` with no
 * fresh backing every fill in that domain is refused `LockActive` — which
 * `settle_fill` then swallows, so the venue looks healthy while accepting
 * nothing.
 *
 * The keeper already calls `realize_pnl` and `sweep_backing` over the group,
 * but discards their errors, so nobody has ever seen whether they work. This
 * runs the same calls out loud.
 *
 * Run: ANQA_GROUP=930 npx ts-node --transpile-only app/diag-backing.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { teeRpcFor } from "./tee-auth";
import { explain } from "./errs";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 930);
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? GROUP_ID.toString());
/** disc + owner + market tag + bump + reserved_margin + claimed_high_water … */
const PORTFOLIO_BYTES = Number(process.env.ANQA_PF_BYTES ?? 0);

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
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  const market = mpda("anqa_market", MARKET_ID);
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");

  // Every portfolio in the hub, the way the keeper finds them.
  const seed = gpda("anqa_portfolio", [Buffer.alloc(0)]); // not used; scan instead
  void seed;
  const all = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: PORTFOLIO_BYTES ? [{ dataSize: PORTFOLIO_BYTES }] : undefined,
  });
  // Portfolios are the biggest accounts the program owns; pick by size mode.
  const sizes = new Map<number, number>();
  for (const a of all) sizes.set(a.account.data.length, (sizes.get(a.account.data.length) ?? 0) + 1);
  const pfSize = [...sizes.entries()].filter(([s]) => s > 9000).sort((a, b) => b[1] - a[1])[0]?.[0];
  const portfolios = all.filter((a) => a.account.data.length === pfSize).map((a) => a.pubkey);
  console.log(`portfolio size ${pfSize} → ${portfolios.length} portfolios in hub ${GROUP_ID}\n`);

  console.log("── realize_pnl (promotes positive PnL; crystallizes the loser's capital) ──");
  for (const pf of portfolios) {
    try {
      await p.methods.realizePnl()
        .accounts({ caller: keeper.publicKey, market, riskGroup, assetSlots, portfolio: pf })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
        .rpc();
      console.log(`  ✓ ${pf.toBase58().slice(0, 8)} realized`);
    } catch (e: any) {
      console.log(`  · ${pf.toBase58().slice(0, 8)} ${explain(e, 90)}`);
    }
  }

  console.log("\n── refresh_portfolio (marks to market; may crystallize losses) ──");
  for (const pf of portfolios) {
    try {
      await p.methods.refreshPortfolio()
        .accounts({ market, riskGroup, assetSlots, portfolio: pf })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
        .rpc();
      console.log(`  ✓ ${pf.toBase58().slice(0, 8)} refreshed`);
    } catch (e: any) {
      console.log(`  · ${pf.toBase58().slice(0, 8)} ${explain(e, 90)}`);
    }
  }

  console.log("\n── sweep_backing on this asset's two domains ──");
  const asset = Number(process.env.ANQA_ASSET_INDEX ?? 0);
  for (const domain of [asset * 2, asset * 2 + 1]) {
    try {
      await p.methods.sweepBacking(domain)
        .accounts({ caller: keeper.publicKey, market, riskGroup, assetSlots })
        .rpc();
      console.log(`  ✓ domain ${domain} swept`);
    } catch (e: any) {
      console.log(`  · domain ${domain} ${explain(e, 90)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
