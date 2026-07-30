/**
 * Anqa dark mode — the PER flow, end to end.
 *
 *   base   market + tape initialized; market flipped DARK
 *   base   book + portfolios PERMISSIONED (ACL records; TEE-enforced reads)
 *   base   trading set + tape delegated; deposits in
 *   ER     claims, reanchor, crank
 *   ER     maker rests a HIDDEN ask; taker crosses with NO maker accounts
 *          -> the fill QUEUES on the book (matching decoupled from settlement)
 *   ER     engine drives settle_fill -> kernel settles, the TAPE prints
 *   ER     dark close -> queue -> settle -> flat; tape prints again
 *   base   withdraw round trip; session closes
 *
 * The public surface of all of it: two tape prints. Price, size, seq, time.
 *
 * Run: npx ts-node --transpile-only app/per-e2e.ts
 *   ANQA_RPC        base RPC (default devnet)
 *   ANQA_ER_RPC     rollup RPC (default https://devnet.magicblock.app)
 *   ANQA_TEE_TOKEN  if set, use the TEE validator (devnet-tee) and probe
 *                   read-gating; without it the flow runs on the public ER,
 *                   where permissions exist on-chain but are not enforced.
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
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const BTC_FEED = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");

const BASE_RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const TEE_TOKEN = process.env.ANQA_TEE_TOKEN;
const ER_RPC = TEE_TOKEN
  ? `https://devnet-tee.magicblock.app?token=${TEE_TOKEN}`
  : process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";

const MARKET_ID = new BN(Date.now() % 1_000_000);
const TICK = 100_000;
const DEC = 6;
const COLLATERAL = 500_000 * 10 ** DEC;
const LOTS = 10;
const WITHDRAW = 100_000 * 10 ** DEC;
const ALL_FLAGS = 31; // authority | logs | balances | messages | signatures

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.ANQA_PACE ?? 900);
const usdc = (n: any) => (Number(n) / 10 ** DEC).toLocaleString();

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
}

async function pollUntil(label: string, f: () => Promise<boolean>, timeoutMs = 90_000, every = 2_500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await f()) return true; } catch (_) { /* keep polling */ }
    await sleep(every);
  }
  console.log(`  ....  timed out waiting: ${label}`);
  return false;
}

async function main() {
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, { commitment: "confirmed", wsEndpoint: ER_RPC.replace("https", "wss") });
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const wallet = new anchor.Wallet(payer);
  const provBase = new anchor.AnchorProvider(base, wallet, { commitment: "confirmed", skipPreflight: false });
  const provEr = new anchor.AnchorProvider(er, wallet, { commitment: "confirmed", skipPreflight: false });
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const pBase: any = new Program(idl, provBase);
  const pEr: any = new Program(idl, provEr);

  // The "engine": the party permitted to see the book and drive settlement.
  // In production a dedicated key inside the TEE; here, the payer.
  const engine = payer;

  console.log("\n════ ANQA GOES DARK (PER flow) ════");
  console.log(`base ${BASE_RPC}`);
  console.log(`ER   ${TEE_TOKEN ? "devnet-tee (TEE, token set)" : ER_RPC}`);
  console.log(`market ${MARKET_ID}\n`);

  const pda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const vault = pda("anqa_vault");
  const internalOracle = pda("anqa_int_oracle");
  const tape = pda("anqa_tape");
  const ledgerOf = (k: PublicKey) => pda("anqa_ledger", [k.toBuffer()]);
  const wReceiptOf = (k: PublicKey) => pda("anqa_wreceipt", [k.toBuffer()]);
  const dReceiptOf = (k: PublicKey) => pda("anqa_dreceipt", [k.toBuffer()]);
  const permissionOf = (a: PublicKey) =>
    PublicKey.findProgramAddressSync([S("permission:"), a.toBuffer()], ACL)[0];
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });
  const ownedBy = async (conn: Connection, a: PublicKey) =>
    (await conn.getAccountInfo(a))?.owner?.toBase58();

  // ── base: setup ──────────────────────────────────────────────────────────
  console.log("[base: setup]");
  const oracleParams = {
    feedId: Array.from(Buffer.from(BTC_FEED_HEX, "hex")),
    secondaryFeedId: Array(32).fill(0),
    maxAgeSecs: new BN(24 * 60 * 60),
    maxConfBps: 500,
    maxDeviationBps: 100,
    maxMoveBpsPerInterval: 0,
    freezeSlots: new BN(150),
    emaWeightBps: 2000,
    maxBandBps: 500,
    maxMarkStalenessSlots: new BN(100_000),
  };
  await pBase.methods
    .initializeMarket(MARKET_ID, new BN(TICK), new BN(1), 8, DEC, 0, 0, { pyth: {} }, oracleParams)
    .accounts({ authority: payer.publicKey, market, book, oracleState, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  await pBase.methods
    .initializeRisk(MARKET_ID, 1)
    .accounts({ authority: payer.publicKey, market, riskGroup, assetSlots, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  const mint = await createMint(base, payer, payer.publicKey, null, DEC);
  await pBase.methods
    .initializeVault(MARKET_ID)
    .accounts({ authority: payer.publicKey, market, collateralMint: mint, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .rpc(); await sleep(PACE);
  await pBase.methods
    .initializeTape(MARKET_ID)
    .accounts({ authority: payer.publicKey, market, tape, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  await pBase.methods
    .syncInternalOracle()
    .accounts({ keeper: payer.publicKey, market, internalOracle, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  await pBase.methods
    .setDark(true)
    .accounts({ authority: payer.publicKey, market, book })
    .rpc(); await sleep(PACE);
  const mkt: any = await pBase.account.market.fetch(market);
  check(mkt.dark === true, "market is DARK", "fills will queue and settle via the engine");

  // ── base: permissions ────────────────────────────────────────────────────
  console.log("\n[base: permissions]");
  await pBase.methods
    .createBookPermission(MARKET_ID, [{ pubkey: engine.publicKey, flags: ALL_FLAGS }])
    .accounts({
      authority: payer.publicKey, market, book,
      permission: permissionOf(book), permissionProgram: ACL, systemProgram: SystemProgram.programId,
    })
    .rpc(); await sleep(PACE);
  check((await base.getAccountInfo(permissionOf(book))) !== null, "book permissioned", "engine-only");

  // ── base: traders ────────────────────────────────────────────────────────
  console.log("\n[base: traders]");
  const maker = Keypair.generate();
  await provBase.sendAndConfirm(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: maker.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })),
    []
  );
  const acct: Record<string, { kp: Keypair; pf: PublicKey; ata: PublicKey }> = {};
  for (const [name, kp] of [["maker", maker], ["taker", payer]] as [string, Keypair][]) {
    const pf = pda("anqa_portfolio", [kp.publicKey.toBuffer()]);
    const ata = await createAssociatedTokenAccount(base, payer, mint, kp.publicKey);
    await mintTo(base, payer, mint, ata, payer, COLLATERAL);
    const isPayer = kp.publicKey.equals(payer.publicKey);
    const o = pBase.methods.openPortfolio().accounts({ trader: kp.publicKey, market, portfolio: pf, systemProgram: SystemProgram.programId });
    await (isPayer ? o.rpc() : o.signers([kp]).rpc()); await sleep(PACE);
    const li = pBase.methods.initializeLedger().accounts({ trader: kp.publicKey, market, ledger: ledgerOf(kp.publicKey), systemProgram: SystemProgram.programId });
    await (isPayer ? li.rpc() : li.signers([kp]).rpc()); await sleep(PACE);
    // Privacy: the trader and the engine may read this portfolio; nobody else.
    const cp = pBase.methods
      .createPortfolioPermission(MARKET_ID, [
        { pubkey: kp.publicKey, flags: ALL_FLAGS },
        { pubkey: engine.publicKey, flags: ALL_FLAGS },
      ])
      .accounts({
        trader: kp.publicKey, market, portfolio: pf,
        permission: permissionOf(pf), permissionProgram: ACL, systemProgram: SystemProgram.programId,
      });
    await (isPayer ? cp.rpc() : cp.signers([kp]).rpc()); await sleep(PACE);
    acct[name] = { kp, pf, ata };
  }
  check((await base.getAccountInfo(permissionOf(acct.maker.pf))) !== null, "portfolios permissioned", "owner + engine");

  // ── base: delegation + deposits ──────────────────────────────────────────
  console.log("\n[base: delegation + deposits]");
  const del = async (method: string, target: PublicKey, field: string) => {
    const d = delegationOf(target);
    const cap = field[0].toUpperCase() + field.slice(1);
    await pBase.methods[method](MARKET_ID)
      .accounts({
        payer: payer.publicKey,
        [field]: target,
        [`buffer${cap}`]: d.buffer,
        [`delegationRecord${cap}`]: d.delegationRecord,
        [`delegationMetadata${cap}`]: d.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
      })
      .rpc(); await sleep(PACE);
  };
  await del("delegateBook", book, "book");
  await del("delegateRiskGroup", riskGroup, "riskGroup");
  await del("delegateAssetSlots", assetSlots, "assetSlots");
  await del("delegateInternalOracle", internalOracle, "internalOracle");
  await del("delegateOracleState", oracleState, "oracleState");
  await del("delegateTape", tape, "tape");
  for (const a of [acct.maker, acct.taker]) {
    const d = delegationOf(a.pf);
    const m = pBase.methods.delegatePortfolio(MARKET_ID).accounts({
      trader: a.kp.publicKey, portfolio: a.pf,
      bufferPortfolio: d.buffer, delegationRecordPortfolio: d.delegationRecord,
      delegationMetadataPortfolio: d.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
    });
    await (a.kp.publicKey.equals(payer.publicKey) ? m.rpc() : m.signers([a.kp]).rpc());
    await sleep(PACE);
  }
  for (const a of [acct.maker, acct.taker]) {
    const dRcpt = dReceiptOf(a.kp.publicKey);
    const dd = delegationOf(dRcpt);
    const m = pBase.methods.deposit(new BN(COLLATERAL), false).accounts({
      trader: a.kp.publicKey, market, ledger: ledgerOf(a.kp.publicKey),
      traderTokenAccount: a.ata, vault,
      receipt: dRcpt, buffer: dd.buffer,
      delegationRecord: dd.delegationRecord, delegationMetadata: dd.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    });
    await (a.kp.publicKey.equals(payer.publicKey) ? m.rpc() : m.signers([a.kp]).rpc());
    await sleep(PACE);
  }
  check((await ownedBy(base, book)) === DLP.toBase58(), "dark set delegated", "book, risk, oracles, tape, portfolios");

  // ── ER: claims + clock + mark ────────────────────────────────────────────
  console.log("\n[ER: session start]");
  for (const a of [acct.maker, acct.taker]) {
    await pEr.methods.claimDeposit().accounts({
      caller: payer.publicKey, market, riskGroup, assetSlots,
      portfolio: a.pf, ledger: ledgerOf(a.kp.publicKey),
      receipt: null, magicContext: null, magicProgram: null,
    }).rpc(); await sleep(PACE);
  }
  await pEr.methods.syncInternalOracle().accounts({
    keeper: payer.publicKey, market, internalOracle, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId,
  }).rpc().catch(() => {}); await sleep(PACE);
  await pEr.methods.reanchorOracle(0).accounts({
    cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle,
  }).rpc(); await sleep(PACE);
  await pEr.methods.crank(0, new BN(0)).accounts({
    cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle,
  }).rpc(); await sleep(PACE);
  const osEr: any = await pEr.account.oracleState.fetch(oracleState);
  const mark = Number(osEr.lastPrice);
  const markTicks = Math.floor(mark / TICK);
  check(mark > 0, "credited + re-anchored + marked in the rollup", `$${(mark / 1e6).toLocaleString()}`);

  // ── ER: the hidden trade ─────────────────────────────────────────────────
  console.log("\n[ER: hidden trade]");
  await pEr.methods
    .placeOrder({ ask: {} }, { limit: {} }, new BN(markTicks), new BN(LOTS), new BN(1))
    .accounts({ trader: maker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.maker.pf })
    .signers([maker])
    .rpc(); await sleep(PACE);
  // The taker names NO maker accounts — it cannot see the book.
  await pEr.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(markTicks), new BN(LOTS), new BN(2))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
    .rpc(); await sleep(PACE);
  let bk: any = await pEr.account.book.fetch(book);
  check(Number(bk.pendingCount) === 1, "hidden cross QUEUED, not settled", "the taker named no counterparty");

  // ── ER: the engine settles; the tape prints ──────────────────────────────
  console.log("\n[ER: engine settles]");
  await pEr.methods.settleFill().accounts({
    caller: engine.publicKey, market, book, riskGroup, assetSlots, oracleState,
    takerPortfolio: acct.taker.pf, makerPortfolio: acct.maker.pf, tape,
  }).rpc(); await sleep(PACE);
  bk = await pEr.account.book.fetch(book);
  let tp: any = await pEr.account.fillTape.fetch(tape);
  check(
    Number(bk.pendingCount) === 0 && Number(tp.count) === 1 &&
    Number(tp.entries[0].baseLots) === LOTS,
    "STEP 7: dark fill settled; the tape is the only witness",
    `print #1: ${tp.entries[0].baseLots}@${tp.entries[0].priceInTicks} ticks`
  );

  // ── ER: dark close ───────────────────────────────────────────────────────
  console.log("\n[ER: dark close]");
  await pEr.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(markTicks), new BN(LOTS), new BN(3))
    .accounts({ trader: maker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.maker.pf })
    .signers([maker])
    .rpc(); await sleep(PACE);
  await pEr.methods
    .closePosition(new BN(Math.floor(markTicks * 0.96)), new BN(0))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
    .rpc(); await sleep(PACE);
  await pEr.methods.settleFill().accounts({
    caller: engine.publicKey, market, book, riskGroup, assetSlots, oracleState,
    takerPortfolio: acct.taker.pf, makerPortfolio: acct.maker.pf, tape,
  }).rpc(); await sleep(PACE);
  tp = await pEr.account.fillTape.fetch(tape);
  let flat = false;
  try {
    await pEr.methods
      .closePosition(new BN(Math.floor(markTicks * 0.96)), new BN(0))
      .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
      .rpc();
  } catch (_) { flat = true; }
  check(Number(tp.count) === 2 && flat, "dark close settled; taker flat", `print #2 on the tape`);

  // ── darkness probe (TEE only) ────────────────────────────────────────────
  if (TEE_TOKEN) {
    console.log("\n[TEE: darkness probe]");
    const stranger = new Connection(
      `https://devnet-tee.magicblock.app?token=${TEE_TOKEN}`,
      "confirmed"
    );
    // A reader with no membership must not see the book; the tape stays public.
    const bookRead = await stranger.getAccountInfo(book).then(a => a !== null).catch(() => false);
    const tapeRead = await stranger.getAccountInfo(tape).then(a => a !== null).catch(() => false);
    check(!bookRead, "book unreadable to non-members", "same query, different answers");
    check(tapeRead, "tape readable by anyone");
  } else {
    console.log("\n  ....  no ANQA_TEE_TOKEN: read-gating not enforced on the public ER;");
    console.log("  ....  permissions exist on-chain and the dark flow is proven above.");
  }

  // ── boundary: withdraw + session end ─────────────────────────────────────
  console.log("\n[boundary: withdraw + undelegate]");
  const wRcpt = wReceiptOf(payer.publicKey);
  const wd = delegationOf(wRcpt);
  const before = await base.getTokenAccountBalance(acct.taker.ata);
  await pBase.methods
    .requestWithdraw(new BN(WITHDRAW), false)
    .accounts({
      trader: payer.publicKey, market, ledger: ledgerOf(payer.publicKey),
      payoutTo: acct.taker.ata, receipt: wRcpt,
      buffer: wd.buffer, delegationRecord: wd.delegationRecord, delegationMetadata: wd.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
    })
    .rpc(); await sleep(PACE);
  await pEr.methods.authorizeWithdraw().accounts({
    payer: payer.publicKey, market, riskGroup, assetSlots,
    portfolio: acct.taker.pf, receipt: wRcpt,
    magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
    magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
  }).rpc().catch((e: any) => console.log("  ....  authorize:", String(e).slice(0, 160)));
  const home = await pollUntil("receipt undelegated home", async () => {
    const o = await ownedBy(base, wRcpt);
    return o === PROGRAM_ID.toBase58() || o === undefined;
  }, 240_000, 5_000);
  let paidOut = await pollUntil("settle", async () => {
    const b = await base.getTokenAccountBalance(acct.taker.ata);
    return Number(b.value.amount) > Number(before.value.amount);
  }, 30_000, 3_000);
  if (!paidOut && (await base.getAccountInfo(wRcpt)) !== null) {
    await pBase.methods.settleWithdraw().accounts({
      market, ledger: ledgerOf(payer.publicKey), receipt: wRcpt,
      owner: payer.publicKey, payoutTo: acct.taker.ata, vault,
      tokenProgram: TOKEN_PROGRAM_ID, escrowAuth: payer.publicKey, escrow: payer.publicKey,
    }).rpc().catch((e: any) => console.log("  ....  settle:", String(e).slice(0, 160)));
    await sleep(PACE);
    const b = await base.getTokenAccountBalance(acct.taker.ata);
    paidOut = Number(b.value.amount) > Number(before.value.amount);
  }
  check(home && paidOut, "value left a dark market through the boundary",
    `+${usdc(Number((await base.getTokenAccountBalance(acct.taker.ata)).value.amount) - Number(before.value.amount))} USDC`);

  console.log(`\n════ ${passed} passed, ${failed} failed ════\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
