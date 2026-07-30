/**
 * Anqa on a live Ephemeral Rollup — steps 4 and 5 of the ER milestone.
 *
 *   base   market + risk + vault initialized; relay synced off Pyth
 *   base   traders funded; portfolios + ledgers opened
 *   base   the SIX market accounts + both portfolios DELEGATED
 *   base   taker deposits with queue_claim=true  -> receipt rail
 *          maker deposits with queue_claim=false -> keeper rail
 *   ER     claims land (validator-dispatched + manual); crank runs
 *   ER     maker rests an ask, taker crosses -> THE VENUE TRADES IN A ROLLUP
 *   ER     reverse trade -> both flat; taker portfolio committed home
 *   base   request_withdraw delegates the receipt (authorize queued)
 *   ER     authorize (validator or manual) -> receipt undelegates home
 *   base   settle pays out  -> VALUE CROSSED BACK
 *
 * Run: npx ts-node --transpile-only app/er-e2e.ts
 *   ANQA_RPC     base RPC (default devnet)
 *   ANQA_ER_RPC  rollup RPC (default https://devnet.magicblock.app)
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
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const BTC_FEED = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");

const BASE_RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";

const MARKET_ID = new BN(Date.now() % 1_000_000);
const TICK = 100_000; // $0.10
const DEC = 6;
const COLLATERAL = 500_000 * 10 ** DEC;
const LOTS = 10;
const WITHDRAW = 100_000 * 10 ** DEC;

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

async function pollUntil(label: string, f: () => Promise<boolean>, timeoutMs = 60_000, every = 2_000): Promise<boolean> {
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
  const er = new Connection(ER_RPC, {
    commitment: "confirmed",
    wsEndpoint: ER_RPC.replace("https", "wss"),
  });
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const wallet = new anchor.Wallet(payer);
  // Preflight ON: this script exists to find errors, and simulation logs are
  // how they explain themselves.
  const provBase = new anchor.AnchorProvider(base, wallet, { commitment: "confirmed", skipPreflight: false });
  const provEr = new anchor.AnchorProvider(er, wallet, { commitment: "confirmed", skipPreflight: false });
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const pBase: any = new Program(idl, provBase);
  const pEr: any = new Program(idl, provEr);

  console.log("\n════ ANQA ON A LIVE EPHEMERAL ROLLUP ════");
  console.log(`base ${BASE_RPC}`);
  console.log(`ER   ${ER_RPC}  (identity: ${(await er.getSlot().then(() => "reachable").catch(() => "UNREACHABLE"))})`);
  console.log(`market ${MARKET_ID}\n`);
  try {
    const id = await (er as any)._rpcRequest("getIdentity", []);
    console.log(`ER validator identity: ${id?.result?.identity}\n`);
  } catch (_) { /* informational only */ }

  const pda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const vault = pda("anqa_vault");
  const internalOracle = pda("anqa_int_oracle");
  const ledgerOf = (k: PublicKey) => pda("anqa_ledger", [k.toBuffer()]);
  const wReceiptOf = (k: PublicKey) => pda("anqa_wreceipt", [k.toBuffer()]);
  const dReceiptOf = (k: PublicKey) => pda("anqa_dreceipt", [k.toBuffer()]);
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });
  const ownedBy = async (conn: Connection, a: PublicKey) =>
    (await conn.getAccountInfo(a))?.owner?.toBase58();

  // ── base: market setup ───────────────────────────────────────────────────
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
    .syncInternalOracle()
    .accounts({ keeper: payer.publicKey, market, internalOracle, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  check(true, "market + risk + vault + relay live on base");

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
    acct[name] = { kp, pf, ata };
  }
  check(true, "portfolios + ledgers opened, collateral minted");

  // ── base: delegate the venue ─────────────────────────────────────────────
  console.log("\n[base: delegation]");
  const del = async (method: string, target: PublicKey, field: string, extra: any = {}) => {
    const d = delegationOf(target);
    const cap = field[0].toUpperCase() + field.slice(1);
    await pBase.methods[method](MARKET_ID)
      .accounts({
        payer: payer.publicKey,
        [field]: target,
        [`buffer${cap}`]: d.buffer,
        [`delegationRecord${cap}`]: d.delegationRecord,
        [`delegationMetadata${cap}`]: d.delegationMetadata,
        ownerProgram: PROGRAM_ID,
        delegationProgram: DLP,
        systemProgram: SystemProgram.programId,
        ...extra,
      })
      .rpc(); await sleep(PACE);
  };
  // The market CONFIG stays on base, undelegated: every base-layer instruction
  // reads it through Anchor's owner check, and the rollup can clone-read it.
  // (This run proves the clone-read: place_order reads `market` in the ER.)
  await del("delegateBook", book, "book");
  await del("delegateRiskGroup", riskGroup, "riskGroup");
  await del("delegateAssetSlots", assetSlots, "assetSlots");
  await del("delegateInternalOracle", internalOracle, "internalOracle");
  await del("delegateOracleState", oracleState, "oracleState");
  for (const [name, a] of [["maker", acct.maker], ["taker", acct.taker]] as const) {
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
  check((await ownedBy(base, book)) === DLP.toBase58(), "book delegated", "owner is the delegation program");
  check((await ownedBy(base, acct.taker.pf)) === DLP.toBase58(), "portfolios delegated");

  // ── base: deposits (both rails) ──────────────────────────────────────────
  console.log("\n[base: deposits]");
  for (const [name, a, queue] of [["maker", acct.maker, false], ["taker", acct.taker, true]] as const) {
    const dRcpt = dReceiptOf(a.kp.publicKey);
    const dd = delegationOf(dRcpt);
    const m = pBase.methods.deposit(new BN(COLLATERAL), queue).accounts({
      trader: a.kp.publicKey, market, ledger: ledgerOf(a.kp.publicKey),
      traderTokenAccount: a.ata, vault,
      receipt: dRcpt, buffer: dd.buffer,
      delegationRecord: dd.delegationRecord, delegationMetadata: dd.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    });
    await (a.kp.publicKey.equals(payer.publicKey) ? m.rpc() : m.signers([a.kp]).rpc());
    await sleep(PACE);
    console.log(`  ....  ${name} deposited (${queue ? "receipt rail, claim queued" : "keeper rail"})`);
  }
  const vaultBal = await base.getTokenAccountBalance(vault);
  check(Number(vaultBal.value.amount) === COLLATERAL * 2, "collateral in vault", `${usdc(vaultBal.value.amount)} USDC`);

  // ── ER: claims ───────────────────────────────────────────────────────────
  console.log("\n[ER: claims]");
  // Keeper rail for the maker: drive the claim by hand inside the rollup.
  await pEr.methods.claimDeposit().accounts({
    caller: payer.publicKey, market, riskGroup, assetSlots,
    portfolio: acct.maker.pf, ledger: ledgerOf(maker.publicKey),
    receipt: null, magicContext: null, magicProgram: null,
  }).rpc(); await sleep(PACE);
  const makerPf: any = await pEr.account.portfolio.fetch(acct.maker.pf);
  check(new BN(makerPf.claimedHighWater, "le").gte(new BN(COLLATERAL)), "maker credited in the rollup (keeper rail)");

  // Receipt rail for the taker: the validator should have dispatched the
  // queued claim already; verify, else drive it manually (permissionless).
  let takerCredited = await pollUntil("taker auto-claim", async () => {
    const pf: any = await pEr.account.portfolio.fetch(acct.taker.pf);
    return new BN(pf.claimedHighWater, "le").gte(new BN(COLLATERAL));
  }, 30_000);
  if (!takerCredited) {
    // The shared devnet validator declines queued actions: it undelegates the
    // receipt home unexecuted (Flash documents the same fallback). By design
    // nothing is lost — the credit is ledger-derived, so the keeper rail
    // finishes the job and the receipt is closed permissionlessly on base.
    console.log("  ....  validator declined the queued claim; keeper rail finishes the job");
    await pEr.methods.claimDeposit().accounts({
      caller: payer.publicKey, market, riskGroup, assetSlots,
      portfolio: acct.taker.pf, ledger: ledgerOf(payer.publicKey),
      receipt: null, magicContext: null, magicProgram: null,
    }).rpc(); await sleep(PACE);
    const pf: any = await pEr.account.portfolio.fetch(acct.taker.pf);
    takerCredited = new BN(pf.claimedHighWater, "le").gte(new BN(COLLATERAL));
  }
  check(takerCredited, "taker credited in the rollup (receipt rail + keeper fallback)");
  // The receipt must end closed with rent back, however it got home.
  let receiptClosed = await pollUntil("deposit receipt auto-close", async () =>
    (await base.getAccountInfo(dReceiptOf(payer.publicKey))) === null, 15_000);
  if (!receiptClosed) {
    const home = await pollUntil("deposit receipt undelegated home", async () =>
      (await ownedBy(base, dReceiptOf(payer.publicKey))) === PROGRAM_ID.toBase58(), 30_000);
    if (home) {
      await pBase.methods.closeDepositReceipt().accounts({
        market, receipt: dReceiptOf(payer.publicKey), owner: payer.publicKey,
        escrowAuth: payer.publicKey, escrow: payer.publicKey,
      }).rpc(); await sleep(PACE);
    }
    receiptClosed = (await base.getAccountInfo(dReceiptOf(payer.publicKey))) === null;
  }
  check(receiptClosed, "deposit receipt closed on base", "rent back to the trader");

  // ── ER: mark the market ──────────────────────────────────────────────────
  console.log("\n[ER: crank]");
  await pEr.methods.syncInternalOracle().accounts({
    keeper: payer.publicKey, market, internalOracle, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId,
  }).rpc().catch((e: any) => console.log("  ....  ER relay sync skipped:", String(e).slice(0, 120)));
  await sleep(PACE);
  // The group's accrual clock was born on base slots; the rollup's slot
  // stream is a different (far larger) domain. Jump it once, while the
  // market is provably empty — otherwise loss-staleness arms forever and
  // every fill is refused with LockActive.
  await pEr.methods.reanchorOracle(0).accounts({
    cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle,
  }).rpc(); await sleep(PACE);
  await pEr.methods.crank(0, new BN(0)).accounts({
    cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle,
  }).rpc(); await sleep(PACE);
  const osEr: any = await pEr.account.oracleState.fetch(oracleState);
  const mark = Number(osEr.lastPrice);
  const markTicks = Math.floor(mark / TICK);
  check(mark > 0, "market marked INSIDE the rollup", `$${(mark / 1e6).toLocaleString()}`);

  // ── ER: the venue trades ─────────────────────────────────────────────────
  console.log("\n[ER: trade]");
  await pEr.methods
    .placeOrder({ ask: {} }, { limit: {} }, new BN(markTicks), new BN(LOTS), new BN(1))
    .accounts({ trader: maker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.maker.pf })
    .signers([maker])
    .rpc(); await sleep(PACE);
  const crossSig = await pEr.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(markTicks), new BN(LOTS), new BN(2))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
    .remainingAccounts([{ pubkey: acct.maker.pf, isSigner: false, isWritable: true }])
    .rpc(); await sleep(PACE);
  const bkEr: any = await pEr.account.book.fetch(book);
  const crossed = Number(bkEr.fillCount) === 1;
  if (!crossed) {
    const tx = await er.getTransaction(crossSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    for (const l of tx?.meta?.logMessages ?? [`  ....  no ER logs available (sig ${crossSig})`]) console.log("   ER:", l);
  }
  check(crossed, "STEP 4: the venue trades inside the rollup", `${bkEr.lastFillBaseLots}@${bkEr.lastFillPriceInTicks} ticks`);

  // ── ER: flatten, then send the taker's state home ────────────────────────
  console.log("\n[ER: flatten + commit]");
  await pEr.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(markTicks), new BN(LOTS), new BN(3))
    .accounts({ trader: maker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.maker.pf })
    .signers([maker])
    .rpc(); await sleep(PACE);
  await pEr.methods
    .closePosition(new BN(Math.floor(markTicks * 0.96)), new BN(0))
    .accounts({ trader: payer.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio: acct.taker.pf })
    .remainingAccounts([{ pubkey: acct.maker.pf, isSigner: false, isWritable: true }])
    .rpc(); await sleep(PACE);
  const bkEr2: any = await pEr.account.book.fetch(book);
  check(Number(bkEr2.fillCount) === 2, "reverse trade filled; taker flat");

  await pEr.methods.commitPortfolio().accounts({
    trader: payer.publicKey, portfolio: acct.taker.pf, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
  }).rpc(); await sleep(PACE);
  check(true, "taker portfolio commit scheduled");

  // ── boundary: withdraw round trip ────────────────────────────────────────
  console.log("\n[boundary: withdraw]");
  const wRcpt = wReceiptOf(payer.publicKey);
  const wd = delegationOf(wRcpt);
  const before = await base.getTokenAccountBalance(acct.taker.ata);
  // queue_authorize = false: the shared devnet validator declines queued
  // actions (and its fallback would undelegate the receipt before the rollup
  // leg could run), so the keeper drives the rollup leg — which is exactly
  // the permissionless path the design guarantees.
  await pBase.methods
    .requestWithdraw(new BN(WITHDRAW), false)
    .accounts({
      trader: payer.publicKey, market, ledger: ledgerOf(payer.publicKey),
      payoutTo: acct.taker.ata, receipt: wRcpt,
      buffer: wd.buffer, delegationRecord: wd.delegationRecord, delegationMetadata: wd.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
    })
    .rpc(); await sleep(PACE);
  check((await ownedBy(base, wRcpt)) === DLP.toBase58(), "withdraw receipt delegated to the rollup");

  console.log("  ....  keeper drives authorize in the rollup");
  await pEr.methods.authorizeWithdraw().accounts({
    payer: payer.publicKey, market, riskGroup, assetSlots,
    portfolio: acct.taker.pf, receipt: wRcpt,
    magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
  }).rpc().catch((e: any) => console.log("  ....  authorize:", String(e).slice(0, 200)));

  // Commit+undelegate on the shared devnet validator takes ~100s; the settle
  // action dispatches right behind it. Poll for either signal generously.
  const home = await pollUntil("receipt committed + undelegated home", async () => {
    const o = await ownedBy(base, wRcpt);
    return o === PROGRAM_ID.toBase58() || o === undefined; // undelegated, or already settled+closed
  }, 240_000, 5_000);
  check(home, "rollup verdict written; receipt undelegated home");

  // Give the validator a moment to dispatch the queued settle, then do it
  // ourselves — settle is signerless, so anyone may.
  let paidOut = await pollUntil("validator-dispatched settle", async () => {
    const b = await base.getTokenAccountBalance(acct.taker.ata);
    return Number(b.value.amount) > Number(before.value.amount);
  }, 30_000, 3_000);
  if (!paidOut && (await base.getAccountInfo(wRcpt)) !== null) {
    console.log("  ....  keeper drives settle on base");
    await pBase.methods.settleWithdraw().accounts({
      market, ledger: ledgerOf(payer.publicKey), receipt: wRcpt,
      owner: payer.publicKey, payoutTo: acct.taker.ata, vault,
      tokenProgram: TOKEN_PROGRAM_ID, escrowAuth: payer.publicKey, escrow: payer.publicKey,
    }).rpc().catch((e: any) => console.log("  ....  settle:", String(e).slice(0, 200)));
    await sleep(PACE);
    const b = await base.getTokenAccountBalance(acct.taker.ata);
    paidOut = Number(b.value.amount) > Number(before.value.amount);
  }
  const after = await base.getTokenAccountBalance(acct.taker.ata);
  check(paidOut, "STEP 5: value crossed back through the boundary",
    `+${usdc(Number(after.value.amount) - Number(before.value.amount))} USDC`);

  // ── ER: session ends ─────────────────────────────────────────────────────
  console.log("\n[ER: undelegate]");
  await pEr.methods.undelegatePortfolio().accounts({
    trader: payer.publicKey, portfolio: acct.taker.pf, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
  }).rpc().catch((e: any) => console.log("  ....  undelegate:", String(e).slice(0, 160)));
  const backHome = await pollUntil("portfolio undelegated home", async () =>
    (await ownedBy(base, acct.taker.pf)) === PROGRAM_ID.toBase58(), 60_000);
  check(backHome, "taker portfolio committed and returned to base", "session closed");

  console.log(`\n════ ${passed} passed, ${failed} failed ════\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
