/**
 * Does permission-*before*-delegation actually leave a portfolio writable?
 *
 * That is the load-bearing claim behind hidden positions. Test it directly:
 * send the same permissionless instruction (`refresh_portfolio`) against
 * portfolios that differ only in when their permission was created.
 *
 *   6mEK… — permissioned today, before delegation (the "fixed" ordering)
 *   FEZh…, 4Fp5… — permissioned after delegation (the known-bricked shape)
 *   2x4a… — no permission at all (the public control)
 *
 * If ordering is what matters, the first succeeds and the middle two 403.
 * If everything but the control 403s, membership never grants write access and
 * a private portfolio simply cannot trade.
 *
 * Read-only in effect: refresh_portfolio recomputes PnL, it moves no funds.
 *
 * Run: npx ts-node --transpile-only app/diag-order.ts
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
const ACL_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);
/** A healthy market — 921 has a live two-sided ladder. */
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 921);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);

const SUBJECTS: [string, string][] = [
  ["6mEKGhcXmCT6dj2Wssyqqov77T6e3rgPiY67QXiYYT62", "permissioned TODAY (before delegation)"],
  ["FEZhZZCPu7xTBwupZhCFHzjmhaJ8mVVtdrrLc7n1DquJ", "permissioned earlier"],
  ["4Fp57ewFFWXQuFRjLt84BHiufCGYewJVzjAfUzfksVHd", "permissioned earlier"],
  ["2x4asdcdyLxR5XpiU4ZM3bt9ZGLqDEFBzhAvZ8fc9HPA", "no permission (control)"],
];

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
  const pEr = new Program(
    idl,
    new anchor.AnchorProvider(er, new anchor.Wallet(keeper), { commitment: "confirmed" })
  ) as any;

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  const market = mpda("anqa_market", MARKET_ID);
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");

  console.log(`keeper ${keeper.publicKey.toBase58()} (a member of every permission below)`);
  console.log(`refresh_portfolio on market ${MARKET_ID}\n`);

  for (const [b58, note] of SUBJECTS) {
    const owner = new PublicKey(b58);
    const portfolio = gpda("anqa_portfolio", [owner.toBuffer()]);
    const permission = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), portfolio.toBuffer()],
      ACL_PROGRAM
    )[0];
    const permAi = await conn.getAccountInfo(permission).catch(() => null);

    // Can the keeper even read it on the ER?
    const readable = await er.getAccountInfo(portfolio).catch(() => null);

    let result: string;
    try {
      await pEr.methods
        .refreshPortfolio()
        .accounts({ market, riskGroup, assetSlots, portfolio })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ skipPreflight: false });
      result = "WRITE OK";
    } catch (e: any) {
      const text = e?.msg ?? (e?.message || String(e));
      result = `WRITE REFUSED — ${String(text).slice(0, 70)}`;
    }

    console.log(`${b58.slice(0, 8)}…  ${note}`);
    console.log(`   permission : ${permAi ? "present" : "absent"}`);
    console.log(`   keeper read: ${readable ? "ok" : "null"}`);
    console.log(`   ${result}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
