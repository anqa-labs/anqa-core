/**
 * Anqa dry run — proves the platform path end to end on devnet.
 *
 *   1. initialize a market + empty book        (base layer)
 *   2. claim seats for two traders             (base layer)
 *   3. rest a bid, cross it with an ask        (CLOB matching)
 *   4. read the fill off the tape              (the only public artifact)
 *   5. delegate the book into the rollup       (privacy boundary)
 *
 * Run: yarn ts-node app/dry-run.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const DEVNET = "https://api.devnet.solana.com";

// Market parameters — one BTC-PERP style market.
const MARKET_ID = new BN(Date.now() % 1_000_000); // fresh market each run
const TICK_SIZE = new BN(1_000); // quote atoms per tick
const BASE_LOT_SIZE = new BN(1_000); // base atoms per lot
const BASE_DECIMALS = 6;
const TAKER_FEE_BPS = 5;
const MAKER_REBATE_BPS = 0;

const SEED_MARKET = Buffer.from("anqa_market");
const SEED_BOOK = Buffer.from("anqa_book");
const SEED_SEAT = Buffer.from("anqa_seat");

function le8(n: BN): Buffer {
  return n.toArrayLike(Buffer, "le", 8);
}

function loadWallet(): Keypair {
  const p = path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

async function main() {
  const connection = new Connection(DEVNET, "confirmed");
  const payer = loadWallet();
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/anqa_core.json", "utf-8")
  );
  const program: any = new Program(idl, provider);

  console.log("\n=== ANQA DRY RUN (devnet) ===");
  console.log("program :", PROGRAM_ID.toBase58());
  console.log("payer   :", payer.publicKey.toBase58());
  console.log("market  :", MARKET_ID.toString());

  const [market] = PublicKey.findProgramAddressSync(
    [SEED_MARKET, le8(MARKET_ID)],
    PROGRAM_ID
  );
  const [book] = PublicKey.findProgramAddressSync(
    [SEED_BOOK, le8(MARKET_ID)],
    PROGRAM_ID
  );
  console.log("market pda:", market.toBase58());
  console.log("book pda  :", book.toBase58());

  // --- 1. initialize -------------------------------------------------------
  let sig = await program.methods
    .initializeMarket(
      MARKET_ID,
      TICK_SIZE,
      BASE_LOT_SIZE,
      BASE_DECIMALS,
      TAKER_FEE_BPS,
      MAKER_REBATE_BPS
    )
    .accounts({
      authority: payer.publicKey,
      market,
      book,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("\n[1] market + book initialized:", sig);

  const bookAcct = await connection.getAccountInfo(book);
  console.log("    book account size:", bookAcct?.data.length, "bytes");

  // --- 2. seats ------------------------------------------------------------
  // Maker is a fresh keypair; taker is the payer. Two distinct traders are
  // required because the book refuses self-trades.
  const maker = Keypair.generate();
  // Fund from the payer rather than the faucet — devnet airdrops rate-limit hard.
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: maker.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    })
  );
  await provider.sendAndConfirm(fundTx, []);

  const [makerSeat] = PublicKey.findProgramAddressSync(
    [SEED_SEAT, le8(MARKET_ID), maker.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const [takerSeat] = PublicKey.findProgramAddressSync(
    [SEED_SEAT, le8(MARKET_ID), payer.publicKey.toBuffer()],
    PROGRAM_ID
  );

  await program.methods
    .claimSeat()
    .accounts({
      trader: maker.publicKey,
      market,
      seat: makerSeat,
      systemProgram: SystemProgram.programId,
    })
    .signers([maker])
    .rpc();

  await program.methods
    .claimSeat()
    .accounts({
      trader: payer.publicKey,
      market,
      seat: takerSeat,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("[2] seats claimed for maker and taker");

  // --- 3. rest a bid, then cross it ---------------------------------------
  const PRICE = new BN(65_000);
  const SIZE = new BN(10);

  await program.methods
    .placeOrder({ bid: {} }, { limit: {} }, PRICE, SIZE, new BN(1))
    .accounts({
      trader: maker.publicKey,
      market,
      book,
      seat: makerSeat,
    })
    .signers([maker])
    .rpc();
  console.log(`[3] maker rested BID ${SIZE} @ ${PRICE}`);

  const crossSig = await program.methods
    .placeOrder({ ask: {} }, { limit: {} }, PRICE, new BN(4), new BN(2))
    .accounts({
      trader: payer.publicKey,
      market,
      book,
      seat: takerSeat,
    })
    .rpc();
  console.log(`[4] taker sent ASK 4 @ ${PRICE} -> crossed`);

  // --- 4. read the tape ----------------------------------------------------
  const tx = await connection.getTransaction(crossSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  const fillLogs = logs.filter((l) => l.includes("Program data:"));
  console.log("\n[5] public tape from the crossing tx:");
  console.log("    program logs:", logs.filter((l) => l.startsWith("Program log:")).join("\n      "));
  console.log("    encoded events:", fillLogs.length);

  // --- 5. book state -------------------------------------------------------
  const bookState = await (program.account as any).book.fetch(book);
  console.log("\n[6] book state after the cross:");
  console.log("    fill_count           :", bookState.fillCount.toString());
  console.log("    last_fill_price      :", bookState.lastFillPriceInTicks.toString());
  console.log("    last_fill_base_lots  :", bookState.lastFillBaseLots.toString());
  console.log("    bids resting         :", bookState.bids.count);
  console.log("    asks resting         :", bookState.asks.count);

  const makerSeatState = await (program.account as any).seat.fetch(makerSeat);
  const takerSeatState = await (program.account as any).seat.fetch(takerSeat);
  console.log("    maker seat filled    :", makerSeatState.baseLotsFilled.toString(), "lots");
  console.log("    taker seat filled    :", takerSeatState.baseLotsFilled.toString(), "lots");

  // --- 6. delegate into the rollup ----------------------------------------
  console.log("\n[7] delegating book into the ephemeral rollup...");
  try {
    const delSig = await program.methods
      .delegateBook(MARKET_ID)
      .accounts({
        payer: payer.publicKey,
        book,
      })
      .rpc();
    console.log("    delegated:", delSig);

    const after = await connection.getAccountInfo(book);
    console.log("    book owner is now:", after?.owner.toBase58());
    console.log("    (ownership moved to the delegation program => base-chain reads are frozen)");
  } catch (e: any) {
    console.log("    delegation failed:", e.message ?? e);
    console.log("    (base-layer CLOB is still proven above)");
  }

  console.log("\n=== DRY RUN COMPLETE ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
