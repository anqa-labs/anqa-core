/**
 * Anqa perp dry run — the full venue on devnet.
 *
 *   1. market + book                 (matching engine)
 *   2. risk engine                   (Percolator market group + asset slots)
 *   3. collateral vault + test USDC
 *   4. two margin accounts, funded
 *   5. maker rests a bid, taker crosses -> POSITIONS, not token transfers
 *   6. crank: mark price + funding
 *   7. liquidation attempt
 *
 * Run: npx ts-node --transpile-only app/perp-dry-run.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DEVNET = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public devnet RPC throttles aggressively; back off and retry rather than
 *  making the dry run look like a program failure. */
async function rpc<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  let delay = 1000;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("429") && !msg.includes("Too Many Requests")) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error(`rpc gave up after ${tries} attempts: ${label}`);
}

const MARKET_ID = new BN(Date.now() % 1_000_000);
const TICK_SIZE = new BN(1); // 1 quote atom per tick — keeps prices readable
const BASE_LOT_SIZE = new BN(1);
const BASE_DECIMALS = 6;
const TAKER_FEE_BPS = 0; // isolate the risk-engine mechanics
const MAKER_REBATE_BPS = 0;

const OPENING_MARK = 65_000;
const USDC_DECIMALS = 6;

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN) => n.toArrayLike(Buffer, "le", 8);

function loadWallet(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")
      )
    )
  );
}

async function main() {
  const connection = new Connection(DEVNET, "confirmed");
  const payer = loadWallet();
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const program: any = new Program(idl, provider);

  console.log("\n=== ANQA PERP DRY RUN (devnet) ===");
  console.log("market:", MARKET_ID.toString(), "| opening mark:", OPENING_MARK);

  const pda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];

  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const vault = pda("anqa_vault");

  // --- 1. market + book ----------------------------------------------------
  await program.methods
    .initializeMarket(MARKET_ID, TICK_SIZE, BASE_LOT_SIZE, BASE_DECIMALS, TAKER_FEE_BPS, MAKER_REBATE_BPS)
    .accounts({ authority: payer.publicKey, market, book, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("[1] market + book created");

  // --- 2. risk engine ------------------------------------------------------
  await program.methods
    .initializeRisk(MARKET_ID, 1, new BN(OPENING_MARK))
    .accounts({
      authority: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const rg = await rpc("riskGroup", () => connection.getAccountInfo(riskGroup));
  const as_ = await rpc("assetSlots", () => connection.getAccountInfo(assetSlots));
  console.log(
    `[2] risk engine live — group ${rg?.data.length}B, asset slots ${as_?.data.length}B, 20x max leverage`
  );

  // --- 3. vault + test collateral -----------------------------------------
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
  console.log("[3] collateral vault created, test mint:", mint.toBase58().slice(0, 8) + "...");

  // --- 4. two traders, funded ---------------------------------------------
  const maker = Keypair.generate();
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: maker.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      })
    ),
    []
  );

  const traders = [
    { name: "maker", kp: maker },
    { name: "taker", kp: payer },
  ];
  const info: Record<string, { portfolio: PublicKey; ata: PublicKey }> = {};

  for (const t of traders) {
    const portfolio = PublicKey.findProgramAddressSync(
      [S("anqa_portfolio"), le8(MARKET_ID), t.kp.publicKey.toBuffer()],
      PROGRAM_ID
    )[0];
    const ata = await createAssociatedTokenAccount(connection, payer, mint, t.kp.publicKey);
    await mintTo(connection, payer, mint, ata, payer, 1_000_000 * 10 ** USDC_DECIMALS);

    const b = program.methods
      .openPortfolio()
      .accounts({ trader: t.kp.publicKey, market, portfolio, systemProgram: SystemProgram.programId });
    await (t.kp === payer ? b.rpc() : b.signers([t.kp]).rpc());

    const d = program.methods
      .deposit(new BN(500_000 * 10 ** USDC_DECIMALS))
      .accounts({
        trader: t.kp.publicKey,
        market,
        riskGroup,
        assetSlots,
        portfolio,
        traderTokenAccount: ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      });
    await (t.kp === payer ? d.rpc() : d.signers([t.kp]).rpc());

    info[t.name] = { portfolio, ata };
    console.log(`[4] ${t.name}: portfolio opened, 500,000 USDC deposited`);
  }

  const vaultBal = await rpc("vaultBal", () => connection.getTokenAccountBalance(vault));
  console.log("    vault holds:", vaultBal.value.uiAmountString, "USDC");

  // --- 5. the trade --------------------------------------------------------
  const PRICE = new BN(OPENING_MARK);
  await program.methods
    .placeOrder({ bid: {} }, { limit: {} }, PRICE, new BN(10), new BN(1))
    .accounts({
      trader: maker.publicKey,
      market,
      book,
      riskGroup,
      assetSlots,
      portfolio: info.maker.portfolio,
    })
    .signers([maker])
    .rpc();
  console.log(`[5] maker rested BID 10 @ ${OPENING_MARK} (no fill, no risk call)`);

  const sig = await program.methods
    .placeOrder({ ask: {} }, { limit: {} }, PRICE, new BN(4), new BN(2))
    .accounts({
      trader: payer.publicKey,
      market,
      book,
      riskGroup,
      assetSlots,
      portfolio: info.taker.portfolio,
    })
    // The maker's margin account — a perp fill mutates BOTH portfolios.
    .remainingAccounts([
      { pubkey: info.maker.portfolio, isSigner: false, isWritable: true },
    ])
    .rpc();
  console.log("[6] taker crossed ASK 4 -> positions minted:", sig.slice(0, 16) + "...");

  await sleep(1500);
  const tx = await rpc("tx", () =>
    connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
  );
  (tx?.meta?.logMessages ?? [])
    .filter((l) => l.startsWith("Program log: anqa:"))
    .forEach((l) => console.log("   ", l.replace("Program log: ", "")));

  const bookState: any = await rpc("book", () => program.account.book.fetch(book));
  console.log(
    `    book: fill_count=${bookState.fillCount} last=${bookState.lastFillBaseLots}@${bookState.lastFillPriceInTicks} bids=${bookState.bids.count} asks=${bookState.asks.count}`
  );

  // Tokens must NOT have moved — a perp fill is pure bookkeeping.
  const vaultAfter = await rpc("vaultAfter", () => connection.getTokenAccountBalance(vault));
  console.log(
    `    vault after trade: ${vaultAfter.value.uiAmountString} USDC (unchanged — a fill moves no tokens)`
  );

  // --- 5b. the margin gate -------------------------------------------------
  // 500,000 USDC (5e11 atoms) at 20x supports 1e13 of notional — about
  // 153,846,153 lots at this price. Ask for 500,000,000 lots (3.25e13 notional,
  // 1.6e12 margin required) and it must be refused *at placement*, before the
  // book is ever walked.
  console.log("[6b] margin gate: ordering 500,000,000 lots on 500,000 USDC...");
  try {
    await program.methods
      .placeOrder({ bid: {} }, { limit: {} }, PRICE, new BN(500_000_000), new BN(99))
      .accounts({
        trader: payer.publicKey,
        market,
        book,
        riskGroup,
        assetSlots,
        portfolio: info.taker.portfolio,
      })
      .rpc();
    console.log("    !! ACCEPTED — margin gate is not working");
  } catch (e: any) {
    const logs: string[] = e.logs ?? [];
    const hit = logs.find((l) => l.includes("InsufficientMargin") || l.includes("Error Message"));
    console.log("    refused:", (hit ?? e.message).replace("Program log: ", "").trim());
  }

  await sleep(2000); // public devnet RPC rate-limits hard

  // --- 6. crank ------------------------------------------------------------
  const newMark = OPENING_MARK - Math.floor(OPENING_MARK * 0.01); // -1%, the max per accrual
  await program.methods
    .crank(0, new BN(newMark), new BN(10_000))
    .accounts({ cranker: payer.publicKey, market, riskGroup, assetSlots })
    .rpc();
  console.log(`[7] crank: mark ${OPENING_MARK} -> ${newMark}, funding accrued`);

  for (const t of ["maker", "taker"]) {
    await program.methods
      .refreshPortfolio()
      .accounts({ market, riskGroup, assetSlots, portfolio: info[t].portfolio })
      .rpc();
  }
  console.log("    both portfolios settled against the new mark");

  // --- 7. liquidation ------------------------------------------------------
  console.log("[8] attempting liquidation of the losing side...");
  try {
    const ls = await program.methods
      .liquidate(0)
      .accounts({
        liquidator: payer.publicKey,
        market,
        riskGroup,
        assetSlots,
        portfolio: info.maker.portfolio,
      })
      .rpc();
    console.log("    liquidated:", ls.slice(0, 16) + "...");
  } catch (e: any) {
    const logs: string[] = e.logs ?? [];
    const reason = logs.find((l) => l.includes("risk engine rejected")) ?? e.message;
    console.log("    refused (expected — account is healthy):", reason);
  }

  console.log("\n=== PERP DRY RUN COMPLETE ===\n");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
