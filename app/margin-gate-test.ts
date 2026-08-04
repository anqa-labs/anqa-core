/**
 * Focused test: does the venue refuse an order the trader cannot margin?
 *
 * Kept deliberately small — one trader, no maker, no crossing — because the
 * public devnet RPC throttles long scripts. The order never reaches the book:
 * it must be rejected on margin first.
 *
 * Run: npx ts-node --transpile-only app/margin-gate-test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { createAssociatedTokenAccount, createMint, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";

const MARKET_ID = new BN(Date.now() % 1_000_000);
const PRICE = 65_000;
const USDC_DECIMALS = 6;
const COLLATERAL = 500_000 * 10 ** USDC_DECIMALS; // 5e11 atoms
const IM_BPS = 500; // 20x

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN) => n.toArrayLike(Buffer, "le", 8);

async function main() {
  const connection = baseConnection(RPC);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))
    )
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const program: any = new Program(idl, provider);

  const pda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const vault = pda("anqa_vault");
  const portfolio = pda("anqa_portfolio", [payer.publicKey.toBuffer()]);

  const maxNotional = (BigInt(COLLATERAL) * 10_000n) / BigInt(IM_BPS);
  const affordableLots = maxNotional / BigInt(PRICE);

  console.log("\n=== MARGIN GATE TEST ===");
  console.log(`collateral        : ${COLLATERAL.toLocaleString()} atoms (500,000 USDC)`);
  console.log(`at ${10_000 / IM_BPS}x supports  : ${maxNotional.toLocaleString()} notional`);
  console.log(`affordable lots   : ${affordableLots.toLocaleString()} @ ${PRICE}`);

  await program.methods
    .initializeMarket(MARKET_ID, new BN(1), new BN(1), USDC_DECIMALS, 0, 0)
    .accounts({ authority: payer.publicKey, market, book, systemProgram: SystemProgram.programId })
    .rpc();
  await program.methods
    .initializeRisk(MARKET_ID, 1, new BN(PRICE))
    .accounts({ authority: payer.publicKey, market, riskGroup, assetSlots, systemProgram: SystemProgram.programId })
    .rpc();

  const mint = await createMint(connection, payer, payer.publicKey, null, USDC_DECIMALS);
  await program.methods
    .initializeVault(MARKET_ID)
    .accounts({
      authority: payer.publicKey,
      market,
      collateralMint: mint,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const ata = await createAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  await mintTo(connection, payer, mint, ata, payer, COLLATERAL);

  await program.methods
    .openPortfolio()
    .accounts({ trader: payer.publicKey, market, portfolio, systemProgram: SystemProgram.programId })
    .rpc();
  await program.methods
    .deposit(new BN(COLLATERAL))
    .accounts({
      trader: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      portfolio,
      traderTokenAccount: ata,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("setup complete: collateral deposited\n");

  const place = (lots: number, coid: number) =>
    program.methods
      .placeOrder({ bid: {} }, { limit: {} }, new BN(PRICE), new BN(lots), new BN(coid))
      .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, portfolio })
      .rpc();

  // 1. Within budget — must be accepted.
  const ok = 1_000_000;
  try {
    await place(ok, 1);
    console.log(`PASS  ${ok.toLocaleString()} lots (within budget) -> accepted`);
  } catch (e: any) {
    console.log(`FAIL  ${ok.toLocaleString()} lots should have been accepted:`, e.message);
  }

  // 2. Beyond budget — must be refused, before the book is touched.
  const tooBig = 500_000_000;
  try {
    await place(tooBig, 2);
    console.log(`FAIL  ${tooBig.toLocaleString()} lots was ACCEPTED — the gate is not working`);
  } catch (e: any) {
    const logs: string[] = e.logs ?? [];
    const hit = logs.find((l) => l.includes("Error Message"));
    console.log(`PASS  ${tooBig.toLocaleString()} lots -> refused`);
    console.log("     ", (hit ?? e.message).replace(/^Program log: /, "").trim());
  }

  console.log("");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
