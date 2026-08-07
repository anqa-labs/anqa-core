/**
 * A resident market maker — a real quoting engine, not a script the watchdog
 * respawns.
 *
 * The old path (`app/demo-maker.ts` re-spawned by the keeper on drift) paid a
 * ts-node cold start per requote, tore the whole book down with `cancel_all` and
 * re-laid it one order at a time, and serialised every market through one global
 * lock. The book sat empty for most of each requote. This process instead:
 *
 *   - holds ONE warm, authenticated TEE connection and a persistent maker key
 *     (trades are signed by the maker, never the admin/keeper);
 *   - follows the oracle mark on a sub-second loop and moves only the rungs that
 *     actually changed, with `modify_order` (which keeps queue priority when it
 *     can) and `place_multiple` (one batched tx per side) — never a full teardown;
 *   - reads its own position every cycle and manages inventory: it skews the mid
 *     against its book, shrinks the side that would add to inventory, and stops
 *     quoting that side entirely at a hard position cap;
 *   - runs each market on its own independent cadence, no global mutex.
 *
 * Run:   npx ts-node --transpile-only app/maker-daemon.ts
 * Stop:  pkill -f app/maker-daemon.ts
 *
 * Config (env): ANQA_MM_MARKETS="id:asset:feedHex,…" (default: one market from
 * ANQA_MM_MARKET/ASSET), ANQA_MM_GROUP, ANQA_MM_LEVELS, ANQA_MM_STEP_BPS,
 * ANQA_MM_BASE_LOTS, ANQA_MM_SIZE_DECAY, ANQA_MM_MAX_POSITION_LOTS,
 * ANQA_MM_SKEW_BPS, ANQA_MM_REPRICE_BPS, ANQA_MM_TICK_MS, ANQA_MM_COLLATERAL.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
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
import { baseConnection } from "./rpc";
import { teeAuthToken } from "./tee-auth";
import { resolveFeedAccount } from "./feed";
import { explain } from "./errs";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = (process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app").split("?")[0];

const GROUP_ID = new BN(process.env.ANQA_MM_GROUP ?? process.env.ANQA_GROUP ?? "930");
const DEC = 6;
const COLLATERAL = Number(process.env.ANQA_MM_COLLATERAL ?? 2_000_000) * 10 ** DEC;
const ALL_FLAGS = 31;

// Quoting parameters.
const LEVELS = Math.max(1, Math.min(8, Number(process.env.ANQA_MM_LEVELS ?? 6)));
const STEP_BPS = Number(process.env.ANQA_MM_STEP_BPS ?? 3);
const BASE_LOTS = Number(process.env.ANQA_MM_BASE_LOTS ?? 2000);
const SIZE_DECAY = Number(process.env.ANQA_MM_SIZE_DECAY ?? 0.85);
const MAX_POSITION_LOTS = Number(process.env.ANQA_MM_MAX_POSITION_LOTS ?? 20000);
// How far the mid is skewed, in bps of mark, at a full inventory of one cap.
const SKEW_BPS = Number(process.env.ANQA_MM_SKEW_BPS ?? 10);
// Minimum mid move (bps of mark) before we bother repricing — the cooldown that
// stops churn on every oracle tick while still following real moves.
const REPRICE_BPS = Number(process.env.ANQA_MM_REPRICE_BPS ?? 2);
const TICK_MS = Number(process.env.ANQA_MM_TICK_MS ?? 1200);
const PACE = Number(process.env.ANQA_MM_PACE ?? 250);
// Periodic clean re-lay: cancel everything and re-quote a fresh ladder. This is
// the only teardown, and it reconciles our local model against reality (fills,
// and any rung the rollup dropped) without paying a teardown every cycle.
const RECONCILE_MS = Number(process.env.ANQA_MM_RECONCILE_MS ?? 45_000);
// The MagicBlock rollup intermittently rejects a write with a transient routing
// error ("Unknown action") under concurrent load — the keeper and the maker
// both touch a book. These are retryable; a resting order is not lost, so we
// retry the op rather than mutate our model on a false failure.
const TRANSIENT = /Unknown action|timed out|timeout|429|rate.?limit|Blockhash not found|node is behind|block height exceeded/i;

// Deterministic client-order-id namespaces, so a rung is addressable across
// cycles for modify/cancel without reading the (private) book.
const BID_BASE = 0x10000000;
const ASK_BASE = 0x20000000;

// Portfolio byte layout — mirrors app/keeper.ts readPosition (constants::MAX_ASSETS).
const MAX_ASSETS_SLOTS = 12;
const HEADER = 8 + 32 + 8 + 1 + 16 + 8;
const ENTRY = HEADER + MAX_ASSETS_SLOTS * 16;
const INNER = ENTRY + MAX_ASSETS_SLOTS * 16;
const LEGS = INNER + 340;
const LEG_STRIDE = 144;
const LEG_ASSET_INDEX = 1;
const LEG_SIDE = 13;
const LEG_BASIS = 14;
const POS_SCALE = 1_000_000;
const CAPITAL_OFF = 73 + 132; // low 8 bytes of kernel capital, per demo-maker

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (m: string, s: string) => console.log(`  ${new Date().toISOString().slice(11, 19)}  ${m.padEnd(8)} ${s}`);

type Feed = { id: number; asset: number; feedHex: string };
type Rung = { coid: number; price: number; lots: number };

function parseMarkets(): Feed[] {
  const spec = process.env.ANQA_MM_MARKETS;
  if (spec) {
    return spec.split(",").filter(Boolean).map((chunk) => {
      const [id, asset, feedHex] = chunk.split(":");
      return { id: Number(id), asset: Number(asset ?? 0), feedHex: feedHex ?? "" };
    });
  }
  return [{ id: Number(process.env.ANQA_MM_MARKET ?? GROUP_ID.toString()), asset: Number(process.env.ANQA_MM_ASSET_INDEX ?? 0), feedHex: process.env.ANQA_FEED_HEX ?? "" }];
}

async function main() {
  const conn = baseConnection(RPC);
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  // A persistent, funded trading identity — NOT the admin/keeper key.
  const makerFile = `app/.mm-maker-${GROUP_ID}.json`;
  let maker: Keypair;
  if (fs.existsSync(makerFile)) {
    maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(makerFile, "utf-8"))));
  } else {
    maker = Keypair.generate();
    fs.writeFileSync(makerFile, JSON.stringify(Array.from(maker.secretKey)));
  }

  // One warm, authenticated TEE connection. Re-auth transparently on expiry.
  let token = await teeAuthToken(maker, ER_RPC);
  const erUrl = () => `${ER_RPC}?token=${token}`;
  let er = new Connection(erUrl(), "confirmed");
  const reauth = async () => { token = await teeAuthToken(maker, ER_RPC); er = new Connection(erUrl(), "confirmed"); };

  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mkProg = (c: Connection, kp: Keypair) =>
    new Program(idl, new anchor.AnchorProvider(c, new anchor.Wallet(kp), { commitment: "confirmed", skipPreflight: true })) as any;
  const pBase = mkProg(conn, maker);
  let pEr = mkProg(er, maker);

  console.log(`\n════ anqa market-maker daemon ════`);
  console.log(`  maker  ${maker.publicKey.toBase58()}`);
  console.log(`  group  ${GROUP_ID.toString()}   levels ${LEVELS}  step ${STEP_BPS}bps  cap ${MAX_POSITION_LOTS} lots\n`);

  // ---- gas for the maker (admin funds once) ----
  if ((await conn.getBalance(maker.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: maker.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }));
    await anchor.web3.sendAndConfirmTransaction(conn, tx, [admin]);
    log("setup", "maker funded with SOL");
  }

  const markets = parseMarkets();
  const gpda = (t: string, e: Buffer[] = []) => PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const mpda = (t: string, id: number, e: Buffer[] = []) => PublicKey.findProgramAddressSync([S(t), le8(id), ...e], PROGRAM_ID)[0];

  // Group-scoped accounts (isolated margin: portfolio/custody live on the hub).
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const portfolio = gpda("anqa_portfolio", [maker.publicKey.toBuffer()]);
  const ledger = gpda("anqa_ledger", [maker.publicKey.toBuffer()]);
  const receipt = gpda("anqa_dreceipt", [maker.publicKey.toBuffer()]);
  const groupMarket = gpda("anqa_market");
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });

  // ---- provision the portfolio (trader ops on the maker key) ----
  const mintFile = `app/.demo-mint-${GROUP_ID}.json`;
  const mint = new PublicKey(JSON.parse(fs.readFileSync(mintFile, "utf-8")).mint);

  if (!(await conn.getAccountInfo(portfolio))) {
    await pBase.methods.openPortfolio()
      .accounts({ trader: maker.publicKey, market: groupMarket, portfolio, systemProgram: SystemProgram.programId })
      .rpc();
    log("setup", "portfolio opened");
  }
  if (!(await conn.getAccountInfo(ledger))) {
    await pBase.methods.initializeLedger()
      .accounts({ trader: maker.publicKey, market: groupMarket, ledger, systemProgram: SystemProgram.programId })
      .rpc().catch(() => {});
  }

  // Fund collateral (admin mints to the maker's ATA, then the maker deposits).
  const pfCapital = async () => {
    const c = (await er.getAccountInfo(portfolio)) ?? (await conn.getAccountInfo(portfolio));
    return c ? c.data.readBigUInt64LE(CAPITAL_OFF) : 0n;
  };
  if ((await pfCapital()) === 0n) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, maker.publicKey);
    await mintTo(conn, admin, mint, ata.address, admin, COLLATERAL);
    const d = delegationOf(receipt);
    await pBase.methods.deposit(new BN(COLLATERAL), false)
      .accounts({
        trader: maker.publicKey, market: groupMarket, ledger,
        traderTokenAccount: ata.address, vault: gpda("anqa_vault"),
        receipt, buffer: d.buffer, delegationRecord: d.delegationRecord, delegationMetadata: d.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    log("setup", `deposited ${(COLLATERAL / 1e6).toLocaleString()} USDC`);
    await sleep(PACE);
  }

  // Privacy BEFORE delegation — a permission made after delegation bricks the
  // account (403 at ingress on every instruction). See anqa-portfolio-privacy.
  const permission = PublicKey.findProgramAddressSync([S("permission:"), portfolio.toBuffer()], ACL)[0];
  const delegated0 = (await conn.getAccountInfo(portfolio))?.owner?.equals(DLP) ?? false;
  if (!delegated0 && !(await conn.getAccountInfo(permission))) {
    await pBase.methods.createPortfolioPermission(GROUP_ID, [
      { pubkey: maker.publicKey, flags: ALL_FLAGS },
      { pubkey: admin.publicKey, flags: ALL_FLAGS }, // keeper: liquidator must read it
    ]).accounts({
      trader: maker.publicKey, market: groupMarket, portfolio, permission,
      permissionProgram: ACL, systemProgram: SystemProgram.programId,
    }).rpc();
    log("setup", "portfolio permissioned (private, pre-delegation)");
    await sleep(PACE);
  }
  if (!delegated0) {
    const d = delegationOf(portfolio);
    await pBase.methods.delegatePortfolio(GROUP_ID)
      .accounts({
        trader: maker.publicKey, portfolio, bufferPortfolio: d.buffer,
        delegationRecordPortfolio: d.delegationRecord, delegationMetadataPortfolio: d.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
      }).rpc();
    log("setup", "portfolio delegated");
    await sleep(PACE);
  }
  await pEr.methods.claimDeposit()
    .accounts({ caller: maker.publicKey, market: groupMarket, riskGroup, assetSlots, portfolio, ledger, receipt: null, magicContext: null, magicProgram: null })
    .rpc().catch(() => {});

  // ---- per-market quoting state ----
  type MktState = {
    f: Feed;
    market: PublicKey; book: PublicKey; oracleState: PublicKey;
    tick: number;
    bids: Map<number, Rung>; asks: Map<number, Rung>;
    lastMidTicks: number; lastQuoteTs: number; lastReconcile: number;
    placed: number; modified: number; cancelled: number; cycles: number; softErr: number;
  };
  const states: MktState[] = [];
  for (const f of markets) {
    const market = mpda("anqa_market", f.id);
    const m: any = await pBase.account.market.fetch(market).catch(() => null);
    if (!m) { log("setup", `market ${f.id} not found — skipping`); continue; }
    states.push({
      f, market, book: mpda("anqa_book", f.id), oracleState: mpda("anqa_oracle", f.id),
      tick: Number(m.tickSize), bids: new Map(), asks: new Map(),
      lastMidTicks: 0, lastQuoteTs: 0, lastReconcile: 0,
      placed: 0, modified: 0, cancelled: 0, cycles: 0, softErr: 0,
    });
    log("setup", `market ${f.id} (asset ${f.asset}) tick=${Number(m.tickSize)} ready`);
  }
  if (!states.length) { log("setup", "no markets to quote — exiting"); return; }

  // Wrap an ER call so an expired session (401) triggers one re-auth + retry.
  const withSession = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (e: any) {
      if (/401|token|unauthor/i.test(String(e?.message ?? e))) { await reauth(); pEr = mkProg(er, maker); return await fn(); }
      throw e;
    }
  };
  // Send an instruction to the rollup RAW.
  //
  // Anchor's `.rpc()` confirms over a websocket the rollup does not reliably
  // deliver; it then throws "Unknown action 'undefined'" and — the part that
  // actually hurts — the transaction never lands. That emptied every book on
  // this venue while the daemon logged nothing worse than a warning. Sending
  // raw and confirming by polling is the same request without that layer.
  const sendIx = async (builder: any) => {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      await builder.instruction()
    );
    tx.feePayer = maker.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(maker);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const st = await er.getSignatureStatus(sig).catch(() => null);
      if (st?.value?.err) throw new Error(`rollup tx failed: ${JSON.stringify(st.value.err)}`);
      if (st?.value?.confirmationStatus) return sig;
    }
    throw new Error("rollup tx not confirmed");
  };

  // Send a trading tx, retrying transient rollup rejections a few times. Returns
  // true on success. Never throws for a transient error — the caller must be able
  // to leave its model untouched and try again next cycle.
  const send = async (build: () => Promise<any>, tries = 3): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      try { await withSession(build); return true; }
      catch (e: any) {
        const msg = explain(e, 120);
        if (TRANSIENT.test(msg) && i < tries - 1) { await sleep(PACE * (i + 1)); continue; }
        throw e;
      }
    }
    return false;
  };

  // Read this maker's signed net position (lots; long +, short −) for an asset.
  const readPosition = (data: Buffer, idx: number): number => {
    for (let n = 0; n < 4; n++) {
      const base = LEGS + n * LEG_STRIDE;
      if (data[base] !== 1) continue;
      if (data.readUInt32LE(base + LEG_ASSET_INDEX) !== idx) continue;
      const raw = data.readBigInt64LE(base + LEG_BASIS);
      if (raw === 0n) continue;
      const lots = Number((raw < 0n ? -raw : raw) / BigInt(POS_SCALE));
      const isLong = data[base + LEG_SIDE] === 0;
      return isLong ? lots : -lots;
    }
    return 0;
  };

  // Compute the desired ladder around a mark, given current inventory.
  const desiredLadder = (markTicks: number, position: number) => {
    const invFrac = Math.max(-1, Math.min(1, position / MAX_POSITION_LOTS));
    // Lean the mid against inventory: long → shift down so asks fill first.
    const skew = Math.round((markTicks * SKEW_BPS * invFrac) / 10_000);
    const mid = markTicks - skew;
    const bidScale = Math.max(0, 1 - Math.max(0, invFrac)); // fewer bids when long
    const askScale = Math.max(0, 1 - Math.max(0, -invFrac)); // fewer asks when short
    const capLong = position >= MAX_POSITION_LOTS; // stop adding longs
    const capShort = position <= -MAX_POSITION_LOTS;
    const bids = new Map<number, Rung>();
    const asks = new Map<number, Rung>();
    for (let i = 1; i <= LEVELS; i++) {
      const off = Math.max(1, Math.round((markTicks * STEP_BPS * i) / 10_000));
      const size = Math.max(1, Math.round(BASE_LOTS * Math.pow(SIZE_DECAY, i - 1)));
      if (!capLong) {
        const lots = Math.max(1, Math.round(size * bidScale));
        if (bidScale > 0) bids.set(i, { coid: BID_BASE + i, price: mid - off, lots });
      }
      if (!capShort) {
        const lots = Math.max(1, Math.round(size * askScale));
        if (askScale > 0) asks.set(i, { coid: ASK_BASE + i, price: mid + off, lots });
      }
    }
    return { bids, asks, mid };
  };

  const sideEnum = (bid: boolean) => (bid ? { bid: {} } : { ask: {} });

  const quoteMarket = async (st: MktState) => {
    st.cycles++;
    // Fresh mark from the oracle state the keeper cranks.
    let os: any;
    try { os = await withSession(() => pEr.account.oracleState.fetch(st.oracleState)); }
    catch { return; }
    const mark = Number(os.lastPrice);
    if (!mark || !isFinite(mark)) return;
    const markTicks = Math.floor(mark / st.tick);

    // Inventory from our own (private, member-readable) portfolio.
    let position = 0;
    const pfInfo = await withSession(() => er.getAccountInfo(portfolio)).catch(() => null);
    if (pfInfo) position = readPosition(pfInfo.data, st.f.asset);

    const { bids, asks, mid } = desiredLadder(markTicks, position);

    // A reconcile is due on its own timer regardless of drift, so decide it
    // before the cooldown can return early.
    const reconcile = !st.lastReconcile || now() - st.lastReconcile > RECONCILE_MS;

    // Cooldown: only reprice when the mid actually moved enough, unless a side
    // is short of rungs (something filled/expired and needs refilling) or a
    // reconcile is due.
    const drift = st.lastMidTicks ? Math.abs(mid - st.lastMidTicks) / Math.max(1, markTicks) * 10_000 : Infinity;
    const short = st.bids.size < bids.size || st.asks.size < asks.size;
    if (drift < REPRICE_BPS && !short && !reconcile && st.lastQuoteTs) return;

    // Every so often, reconcile: clear the book and our model and re-lay a fresh
    // ladder. This is the only teardown, and it heals fills and any rung the
    // rollup silently dropped without a per-cycle cost.
    if (reconcile) {
      await send(() => sendIx(pEr.methods.cancelAllOrders()
        .accounts({ trader: maker.publicKey, market: st.market, session: null, book: st.book, portfolio }))).catch(() => {});
      st.bids.clear(); st.asks.clear();
      st.lastReconcile = now();
      await sleep(PACE);
    }

    // Diff desired vs local model. modify moves a rung that drifted; a modify
    // failure never mutates the model (the old order still rests) — we just keep
    // it and try again next cycle, so the book is never emptied by a transient
    // error. New/missing rungs are batch-placed; unwanted rungs are cancelled.
    const toPlace: any[] = [];
    const recert = async () => { await send(() => sendIx(pEr.methods.refreshPortfolio().accounts({ market: st.market, riskGroup, assetSlots, portfolio }))).catch(() => {}); };
    const applySide = async (bid: boolean, desired: Map<number, Rung>, model: Map<number, Rung>) => {
      for (const [lvl, want] of desired) {
        const have = model.get(lvl);
        if (!have) {
          toPlace.push({ side: sideEnum(bid), priceInTicks: new BN(want.price), baseLots: new BN(want.lots), clientOrderId: new BN(want.coid), hidden: false });
        } else if (have.price !== want.price || have.lots !== want.lots) {
          try {
            const ok = await send(() => sendIx(pEr.methods.modifyOrder(sideEnum(bid), new BN(want.coid), new BN(want.price), new BN(want.lots))
              .accounts({ trader: maker.publicKey, market: st.market, book: st.book, oracleState: st.oracleState, portfolio })));
            if (ok) { model.set(lvl, want); st.modified++; }
          } catch (e: any) {
            // A definitive (non-transient) failure means the order is gone
            // (filled/taken) or the cert is stale. Drop it so the placer refills;
            // recertify on a stale cert. Transient errors were already retried by
            // `send` and re-thrown here only after exhausting retries.
            if (/Stale|epoch|cert/i.test(explain(e, 120))) await recert();
            model.delete(lvl); st.softErr++;
          }
          await sleep(PACE);
        }
      }
      for (const [lvl, have] of model) {
        if (!desired.has(lvl)) {
          await send(() => sendIx(pEr.methods.cancelOrder(sideEnum(bid), new BN(have.coid))
            .accounts({ trader: maker.publicKey, market: st.market, session: null, book: st.book, portfolio }))).catch(() => {});
          model.delete(lvl); st.cancelled++;
          await sleep(PACE);
        }
      }
    };

    await applySide(true, bids, st.bids);
    await applySide(false, asks, st.asks);

    // Lay each rung with its own `place_order`.
    //
    // `place_multiple` batches the same rungs into one transaction and is the
    // obvious optimisation, but it is NOT equivalent to the risk engine: on a
    // market where the batch refuses with 6010, single places of those exact
    // rungs at those exact prices are still accepted (verified repeatedly
    // against a live book). Batching cost this venue whole books — markets
    // took turns sitting empty while the log showed only a warning — so the
    // extra transactions are the price of a ladder that is actually there.
    for (const q of toPlace) {
      try {
        const ok = await send(() => sendIx(pEr.methods
          .placeOrder(q.side, { postOnly: {} }, q.priceInTicks, q.baseLots, q.clientOrderId, new BN(0), q.hidden)
          .accounts({ trader: maker.publicKey, session: null, market: st.market, book: st.book, riskGroup, assetSlots, oracleState: st.oracleState, portfolio })));
        if (ok) {
          const lvl = q.clientOrderId.toNumber() & 0xffff;
          (q.side.bid ? st.bids : st.asks).set(lvl, { coid: q.clientOrderId.toNumber(), price: q.priceInTicks.toNumber(), lots: q.baseLots.toNumber() });
          st.placed++;
        }
      } catch (e: any) {
        // A stale cert right after a crank is the common definitive failure,
        // and the engine reports it as a bare 6010 — which the old text match
        // never caught. Recertify so the next rung (and cycle) can land.
        if (/Stale|epoch|cert|6010/i.test(explain(e, 120))) await recert();
        else { st.softErr++; log("warn", `${st.f.id} place: ${explain(e, 80)}`); }
      }
      await sleep(PACE);
    }

    st.lastMidTicks = mid; st.lastQuoteTs = now();
    log("quote", `${st.f.id} mark ${(mark / 1e6).toFixed(2)} mid ${mid} pos ${position >= 0 ? "+" : ""}${position} · ${st.bids.size}b/${st.asks.size}a · P${st.placed} M${st.modified} C${st.cancelled}${st.softErr ? ` e${st.softErr}` : ""}`);
  };

  // Recertify once up front, then run each market on its own cadence.
  await withSession(() => sendIx(pEr.methods.refreshPortfolio().accounts({ market: states[0].market, riskGroup, assetSlots, portfolio }))).catch(() => {});
  log("start", `quoting ${states.length} market(s), tick ${TICK_MS}ms`);

  let stop = false;
  process.on("SIGINT", () => { stop = true; });
  process.on("SIGTERM", () => { stop = true; });
  while (!stop) {
    for (const st of states) {
      try { await quoteMarket(st); } catch (e: any) { log("warn", `${st.f.id} cycle: ${explain(e, 90)}`); }
    }
    await sleep(TICK_MS);
  }
  log("stop", "daemon exiting");
}

main().catch((e) => { console.error(`\n  FATAL  ${e?.message ?? e}\n`); process.exitCode = 1; });
