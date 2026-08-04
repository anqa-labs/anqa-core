/**
 * Focused test: the custody loop.
 *
 *   1. deposit           -> vault balance rises, collateral credited
 *   2. rest an order     -> withdraw must be refused (margin is reserved)
 *   3. cancel the order  -> withdraw is allowed again
 *   4. withdraw          -> tokens actually return to the trader
 *
 * Small on purpose: the public devnet RPC throttles long scripts.
 * Run: npx ts-node --transpile-only app/withdraw-test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { baseConnection } from "./rpc";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";

const MARKET_ID = new BN(Date.now() % 1_000_000);
const PRICE = 65_000;
const DEC = 6;
const DEPOSIT = 500_000 * 10 ** DEC;
const WITHDRAW = 100_000 * 10 ** DEC;

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN) => n.toArrayLike(Buffer, "le", 8);
const usdc = (n: string | number) => (Number(n) / 10 ** DEC).toLocaleString();

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

  const pda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const vault = pda("anqa_vault");
  const portfolio = pda("anqa_portfolio", [payer.publicKey.toBuffer()]);

  console.log("\n=== CUSTODY LOOP TEST ===");

  await program.methods
    .initializeMarket(MARKET_ID, new BN(1), new BN(1), DEC, 0, 0)
    .accounts({ authority: payer.publicKey, market, book, systemProgram: SystemProgram.programId })
    .rpc();
  await program.methods
    .initializeRisk(MARKET_ID, 1, new BN(PRICE))
    .accounts({
      authority: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const mint = await createMint(connection, payer, payer.publicKey, null, DEC);
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
  await mintTo(connection, payer, mint, ata, payer, DEPOSIT);
  await program.methods
    .openPortfolio()
    .accounts({ trader: payer.publicKey, market, portfolio, systemProgram: SystemProgram.programId })
    .rpc();

  const bal = async (acct: PublicKey) =>
    (await connection.getTokenAccountBalance(acct)).value.amount;

  // --- 1. deposit ----------------------------------------------------------
  await program.methods
    .deposit(new BN(DEPOSIT))
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
  console.log(`[1] deposited ${usdc(DEPOSIT)} USDC`);
  console.log(`    trader ${usdc(await bal(ata))} | vault ${usdc(await bal(vault))}`);

  const doWithdraw = () =>
    program.methods
      .withdraw(new BN(WITHDRAW))
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

  // --- 2. rest an order, then try to withdraw ------------------------------
  await program.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(PRICE), new BN(1_000_000), new BN(1))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, portfolio })
    .rpc();
  console.log("[2] rested a bid (margin now reserved)");

  try {
    await doWithdraw();
    console.log("    FAIL — withdraw succeeded while margin was reserved");
  } catch (e: any) {
    const hit = (e.logs ?? []).find((l: string) => l.includes("Error Message"));
    console.log("    PASS — refused:", (hit ?? e.message).replace(/^Program log: /, "").trim());
  }

  // --- 3. cancel, then withdraw -------------------------------------------
  await program.methods
    .cancelOrder({ bid: {} }, new BN(1))
    .accounts({ trader: payer.publicKey, market, book, portfolio })
    .rpc();
  console.log("[3] cancelled the order (margin released)");

  await doWithdraw();
  console.log(`[4] withdrew ${usdc(WITHDRAW)} USDC`);
  console.log(`    trader ${usdc(await bal(ata))} | vault ${usdc(await bal(vault))}`);
  console.log("");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
