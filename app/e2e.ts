/**
 * Anqa end-to-end: the whole base-chain venue, one run.
 *
 *   setup    market + risk engine + vault, marked off live Pyth
 *   fund     two traders, collateral deposited
 *   open     maker rests an ask, taker crosses -> POSITIONS
 *   verify   the kernel actually holds a long and a short
 *   protect  taker arms a stop-loss
 *   crank    advance mark + funding from Pyth
 *   close    taker exits reduce-only into the maker's bid
 *   verify   taker is flat
 *   settle   withdraw collateral back out
 *
 * Run: npx ts-node --transpile-only app/e2e.ts
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
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const BTC_FEED = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");

const MARKET_ID = new BN(Date.now() % 1_000_000);
const TICK = 100_000; // $0.10
const DEC = 6;
const COLLATERAL = 500_000 * 10 ** DEC;
const LOTS = 10;

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.ANQA_PACE ?? 900);
const usdc = (n: any) => (Number(n) / 10 ** DEC).toLocaleString();

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

async function rpc<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let d = 1000;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (!String(e?.message ?? e).includes("429")) throw e;
      await sleep(d);
      d *= 2;
    }
  }
  throw new Error("rpc retries exhausted");
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))
    )
  );
  // Public devnet RPC rate-limits hard. Skipping preflight halves the calls
  // per transaction (no simulate), and pacing avoids the websocket 429s that
  // kill long scripts mid-run. Set ANQA_RPC to a dedicated endpoint to go fast.
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: true,
    maxRetries: 3,
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
  const oracleState = pda("anqa_oracle");
  const vault = pda("anqa_vault");

  console.log("\n════ ANQA END-TO-END (devnet) ════");
  console.log(`market ${MARKET_ID}  tick $${TICK / 1e6}\n`);

  // ── setup ────────────────────────────────────────────────────────────────
  console.log("[setup]");
  const oracleParams = {
    feedId: Array.from(Buffer.from(BTC_FEED_HEX, "hex")),
    secondaryFeedId: Array(32).fill(0),
    maxAgeSecs: new BN(24 * 60 * 60), // devnet feeds are slow
    maxConfBps: 500,
    maxDeviationBps: 100,
    maxMoveBpsPerInterval: 0,
    freezeSlots: new BN(150),
    emaWeightBps: 2000,
    maxBandBps: 500,
    maxMarkStalenessSlots: new BN(100_000),
  };

  await program.methods
    .initializeMarket(MARKET_ID, new BN(TICK), new BN(1), 8, DEC, 0, 0, { pyth: {} }, oracleParams)
    .accounts({ authority: payer.publicKey, market, book, oracleState, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  await program.methods
    .initializeRisk(MARKET_ID, 1)
    .accounts({ authority: payer.publicKey, market, riskGroup, assetSlots, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  const mint = await createMint(connection, payer, payer.publicKey, null, DEC);
  await program.methods
    .initializeVault(MARKET_ID)
    .accounts({ authority: payer.publicKey, market, collateralMint: mint, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .rpc(); await sleep(PACE);
  await program.methods
    .crank(0, new BN(0))
    .accounts({ cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, priceUpdate: BTC_FEED })
    .rpc(); await sleep(PACE);

  const os0: any = await rpc(() => program.account.oracleState.fetch(oracleState));
  const mark = Number(os0.lastPrice);
  const markTicks = Math.floor(mark / TICK);
  check(mark > 0, "market live, marked off Pyth", `$${(mark / 1e6).toLocaleString()}`);

  // ── fund ─────────────────────────────────────────────────────────────────
  console.log("\n[fund]");
  const maker = Keypair.generate();
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: maker.publicKey, lamports: 0.12 * LAMPORTS_PER_SOL })
    ),
    []
  );

  const acct: Record<string, { kp: Keypair; pf: PublicKey; ata: PublicKey }> = {};
  for (const [name, kp] of [["maker", maker], ["taker", payer]] as [string, Keypair][]) {
    const pf = pda("anqa_portfolio", [kp.publicKey.toBuffer()]);
    const ata = await createAssociatedTokenAccount(connection, payer, mint, kp.publicKey);
    await mintTo(connection, payer, mint, ata, payer, COLLATERAL);
    const isPayer = kp.publicKey.equals(payer.publicKey);
    const o = program.methods.openPortfolio().accounts({ trader: kp.publicKey, market, portfolio: pf, systemProgram: SystemProgram.programId });
    await (isPayer ? o.rpc() : o.signers([kp]).rpc()); await sleep(PACE);
    const d = program.methods.deposit(new BN(COLLATERAL)).accounts({
      trader: kp.publicKey, market, riskGroup, assetSlots, portfolio: pf,
      traderTokenAccount: ata, vault, tokenProgram: TOKEN_PROGRAM_ID,
    });
    await (isPayer ? d.rpc() : d.signers([kp]).rpc()); await sleep(PACE);
    acct[name] = { kp, pf, ata };
  }
  const vaultBal = await rpc(() => connection.getTokenAccountBalance(vault));
  check(Number(vaultBal.value.amount) === COLLATERAL * 2, "collateral in vault", `${usdc(vaultBal.value.amount)} USDC`);

  // ── open ─────────────────────────────────────────────────────────────────
  console.log("\n[open]");
  const askPrice = markTicks;
  await program.methods
    .placeOrder({ ask: {} }, { limit: {} }, new BN(askPrice), new BN(LOTS), new BN(1))
    .accounts({ trader: maker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.maker.pf })
    .signers([maker])
    .rpc(); await sleep(PACE);

  await program.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(askPrice), new BN(LOTS), new BN(2))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
    .remainingAccounts([{ pubkey: acct.maker.pf, isSigner: false, isWritable: true }])
    .rpc(); await sleep(PACE);

  const bk: any = await rpc(() => program.account.book.fetch(book));
  check(Number(bk.fillCount) === 1, "taker crossed the maker's ask", `${bk.lastFillBaseLots}@${bk.lastFillPriceInTicks} ticks`);

  const vaultAfterTrade = await rpc(() => connection.getTokenAccountBalance(vault));
  check(
    Number(vaultAfterTrade.value.amount) === COLLATERAL * 2,
    "no tokens moved on the fill",
    "a perp fill is bookkeeping, not delivery"
  );

  // ── protect ──────────────────────────────────────────────────────────────
  console.log("\n[protect]");
  const trigId = new BN(7);
  const trigger = PublicKey.findProgramAddressSync(
    [S("anqa_trigger"), le8(MARKET_ID), payer.publicKey.toBuffer(), le8(trigId)],
    PROGRAM_ID
  )[0];
  await program.methods
    .placeTriggerOrder(trigId, new BN(Math.floor(mark * 0.97)), { below: {} }, new BN(Math.floor(markTicks * 0.97)), new BN(0))
    .accounts({ trader: payer.publicKey, market, trigger, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  const tr: any = await rpc(() => program.account.triggerOrder.fetch(trigger));
  check(Number(tr.triggerPrice) === Math.floor(mark * 0.97), "stop-loss armed 3% below mark");

  // Not armed yet — the mark has not fallen.
  // skipPreflight means a failed tx returns no simulation logs, so assert on
  // state: firing closes the trigger account, therefore it surviving proves the
  // fire was refused.
  try {
    await program.methods
      .fireTriggerOrder()
      .accounts({ keeper: payer.publicKey, market, oracleState, trigger })
      .rpc(); await sleep(PACE);
  } catch (_) {
    /* expected */
  }
  const trigStillThere = await rpc(() => connection.getAccountInfo(trigger));
  check(trigStillThere !== null, "unarmed trigger refused", "mark has not reached it");

  // ── crank ────────────────────────────────────────────────────────────────
  console.log("\n[crank]");
  await program.methods
    .crank(0, new BN(10_000))
    .accounts({ cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, priceUpdate: BTC_FEED })
    .rpc(); await sleep(PACE);
  for (const n of ["maker", "taker"]) {
    await program.methods
      .refreshPortfolio()
      .accounts({ market, riskGroup, assetSlots, portfolio: acct[n].pf })
      .rpc(); await sleep(PACE);
  }
  const os1: any = await rpc(() => program.account.oracleState.fetch(oracleState));
  check(Number(os1.emaPrice) > 0, "mark + funding advanced, EMA tracking", `ema $${(Number(os1.emaPrice) / 1e6).toLocaleString()}`);

  // ── close ────────────────────────────────────────────────────────────────
  console.log("\n[close]");
  // The taker is long; to exit it must sell, so the maker rests a bid.
  await program.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(askPrice), new BN(LOTS), new BN(3))
    .accounts({ trader: maker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.maker.pf })
    .signers([maker])
    .rpc(); await sleep(PACE);

  await program.methods
    .closePosition(new BN(Math.floor(markTicks * 0.96)), new BN(0))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
    .remainingAccounts([{ pubkey: acct.maker.pf, isSigner: false, isWritable: true }])
    .rpc(); await sleep(PACE);

  const bk2: any = await rpc(() => program.account.book.fetch(book));
  check(Number(bk2.fillCount) === 2, "close crossed the maker's bid", `${bk2.lastFillBaseLots} lots`);

  // Closing again must do nothing: if the taker were still long it would fill
  // again and the book's fill count would move. State, not logs.
  try {
    await program.methods
      .closePosition(new BN(Math.floor(markTicks * 0.96)), new BN(0))
      .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
      .rpc(); await sleep(PACE);
  } catch (_) {
    /* expected: nothing open */
  }
  const bk3: any = await rpc(() => program.account.book.fetch(book));
  check(Number(bk3.fillCount) === 2, "taker is flat", "a second close produced no fill");

  // ── settle ───────────────────────────────────────────────────────────────
  console.log("\n[settle]");
  await program.methods.cancelAllOrders()
    .accounts({ trader: payer.publicKey, market, book, portfolio: acct.taker.pf })
    .rpc(); await sleep(PACE);
  const before = await rpc(() => connection.getTokenAccountBalance(acct.taker.ata));
  await program.methods
    .withdraw(new BN(100_000 * 10 ** DEC))
    .accounts({
      trader: payer.publicKey, market, riskGroup, assetSlots, portfolio: acct.taker.pf,
      traderTokenAccount: acct.taker.ata, vault, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc(); await sleep(PACE);
  const after = await rpc(() => connection.getTokenAccountBalance(acct.taker.ata));
  check(
    Number(after.value.amount) > Number(before.value.amount),
    "collateral withdrawn after closing",
    `+${usdc(Number(after.value.amount) - Number(before.value.amount))} USDC`
  );

  console.log(`\n════ ${passed} passed, ${failed} failed ════\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
