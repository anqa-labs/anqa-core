/**
 * Focused test: the mark price comes from Pyth, and only from Pyth.
 *
 *   1. create a BTC-PERP bound to Pyth's BTC/USD feed
 *   2. initialize risk -> opening mark read from the live feed
 *   3. crank            -> mark advanced from the live feed
 *   4. crank with the WRONG feed account -> must be refused
 *
 * Run: npx ts-node --transpile-only app/oracle-test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";

// Pyth sponsored price-feed accounts (devnet), owned by the receiver program.
const FEEDS = {
  BTC: {
    hex: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    account: new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"),
  },
  SOL: {
    hex: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    account: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  },
};

const MARKET_ID = new BN(Date.now() % 1_000_000);
const BASE_DECIMALS = 8; // BTC
const QUOTE_DECIMALS = 6; // USDC
const MAX_AGE_SECS = new BN(120);
const MAX_CONF_BPS = 200; // 2% — refuse to mark when Pyth is unsure

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN) => n.toArrayLike(Buffer, "le", 8);

async function main() {
  const connection = baseConnection(RPC);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")
      )
    )
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const program: any = new Program(idl, provider);

  const pda = (seed: string) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID)], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");

  console.log("\n=== PYTH ORACLE TEST ===");
  console.log("BTC/USD feed account:", FEEDS.BTC.account.toBase58());

  await program.methods
    .initializeMarket(
      MARKET_ID,
      new BN(1),
      new BN(1),
      BASE_DECIMALS,
      QUOTE_DECIMALS,
      0,
      0,
      Array.from(Buffer.from(FEEDS.BTC.hex, "hex")),
      MAX_AGE_SECS,
      MAX_CONF_BPS
    )
    .accounts({ authority: payer.publicKey, market, book, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("[1] BTC-PERP created, bound to the BTC/USD feed");

  const sig = await program.methods
    .initializeRisk(MARKET_ID, 1)
    .accounts({
      authority: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      priceUpdate: FEEDS.BTC.account,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const showLogs = async (s: string, label: string) => {
    const tx = await connection.getTransaction(s, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    (tx?.meta?.logMessages ?? [])
      .filter((l) => l.startsWith("Program log: anqa:"))
      .forEach((l) => console.log(`    ${label}`, l.replace("Program log: anqa: ", "")));
  };
  console.log("[2] risk engine seeded from the live feed:");
  await showLogs(sig, "");

  const crankSig = await program.methods
    .crank(0, new BN(0))
    .accounts({
      cranker: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      priceUpdate: FEEDS.BTC.account,
    })
    .rpc();
  console.log("[3] crank read the live mark:");
  await showLogs(crankSig, "");

  // --- 4. wrong feed -------------------------------------------------------
  // Substituting SOL's oracle into a BTC market must fail: the feed id inside
  // the update is checked against the one the market was created with.
  console.log("[4] cranking BTC market with SOL's price feed...");
  try {
    await program.methods
      .crank(0, new BN(0))
      .accounts({
        cranker: payer.publicKey,
        market,
        riskGroup,
        assetSlots,
        priceUpdate: FEEDS.SOL.account,
      })
      .rpc();
    console.log("    FAIL — accepted the wrong oracle");
  } catch (e: any) {
    const logs: string[] = e.logs ?? [];
    const hit = logs.find((l) => l.includes("pyth rejected") || l.includes("Error Message"));
    console.log("    PASS — refused:", (hit ?? e.message).replace(/^Program log: /, "").trim());
  }
  console.log("");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
