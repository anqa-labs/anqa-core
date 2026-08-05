/**
 * Which portfolios in 920's pending queue are permissioned (and therefore
 * frozen at TEE ingress)?
 *
 * A private portfolio rejects every client tx that names it — including the
 * keeper's `settle_fill`. Since the pending ring drains strictly oldest-first,
 * one such portfolio at the head stalls settlement for the whole market.
 *
 * Run: npx ts-node --transpile-only app/diag-perm.ts
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
const ACL_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 920);
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);

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
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const pEr = new Program(
    idl,
    new anchor.AnchorProvider(er, new anchor.Wallet(keeper), { commitment: "confirmed" })
  ) as any;

  const mpda = (t: string, id: BN) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  const bk: any = await pEr.account.book.fetch(mpda("anqa_book", MARKET_ID));
  const head = Number(bk.pending_head ?? bk.pendingHead);
  const count = Number(bk.pending_count ?? bk.pendingCount);

  const traders = new Map<string, PublicKey>();
  for (let i = 0; i < count; i++) {
    const p = bk.pending[(head + i) % 16];
    for (const k of [p.taker, p.maker]) traders.set(new PublicKey(k).toBase58(), new PublicKey(k));
  }
  console.log(`920 pending: head=${head} count=${count} · ${traders.size} distinct portfolios in the live window\n`);

  for (const [b58, pk] of traders) {
    const portfolio = gpda("anqa_portfolio", [pk.toBuffer()]);
    const permission = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), portfolio.toBuffer()],
      ACL_PROGRAM
    )[0];
    const pAi = await conn.getAccountInfo(portfolio).catch(() => null);
    const permAi = await conn.getAccountInfo(permission).catch(() => null);
    console.log(`trader ${b58}`);
    console.log(`  portfolio  ${portfolio.toBase58()}`);
    console.log(`    base owner  : ${pAi ? pAi.owner.toBase58() : "MISSING"}${pAi?.owner.equals(DLP) ? "  (delegated)" : ""}`);
    console.log(`    PERMISSION  : ${permAi ? `PRESENT (${permAi.data.length}B, owner ${permAi.owner.toBase58().slice(0, 8)}) -> PRIVATE, frozen at ingress` : "absent -> public, tradeable"}`);
  }

  // Position holders on 920 whose portfolio is private are equally stuck.
  console.log("\nbook bid[0] (the order blocking every post-only ask):");
  const b0 = bk.bids.orders.find((o: any) => o.active === 1);
  if (b0) {
    const owner = new PublicKey(b0.trader);
    const portfolio = gpda("anqa_portfolio", [owner.toBuffer()]);
    const permission = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), portfolio.toBuffer()],
      ACL_PROGRAM
    )[0];
    const permAi = await conn.getAccountInfo(permission).catch(() => null);
    console.log(`  trader ${owner.toBase58()} px=${b0.price_in_ticks ?? b0.priceInTicks} lots=${b0.base_lots ?? b0.baseLots} seq=${b0.seq} hidden=${b0.hidden}`);
    console.log(`  permission: ${permAi ? "PRESENT -> private" : "absent -> public"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
