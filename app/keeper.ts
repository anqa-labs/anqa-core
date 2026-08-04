/**
 * The engine.
 *
 * A dark venue cannot run itself. Three jobs, none of them optional:
 *
 *   relay    refresh the internal oracle **inside the rollup**. The relay is
 *            delegated (a clone-read snapshot would freeze the mark), and
 *            Pyth's own price account is clone-readable there, so the same
 *            verified feed is available on the inside.
 *   crank    advance mark and funding inside the rollup. Cadence is a
 *            solvency parameter: the kernel accrues bounded segments, so a
 *            crank that falls behind leaves loss-staleness armed and every
 *            fill is refused — and funding under-accrues by however far
 *            behind it is.
 *   settle   execute fills the book matched but nobody could settle, because
 *            on a dark market the taker cannot name its counterparty.
 *
 * Every instruction it sends is permissionless. The keeper adds liveness,
 * never authority: losing it degrades the venue, it cannot steal from it.
 *
 * Run: npx ts-node --transpile-only app/keeper.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { spawn } from "child_process";
import bs58 from "bs58";
import fs from "fs";
import { teeRpcFor } from "./tee-auth";
import { resolveFeedAccount } from "./feed";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const BTC_FEED = new PublicKey(
  process.env.ANQA_FEED_ACCT && process.env.ANQA_FEED_ACCT !== "auto"
    ? process.env.ANQA_FEED_ACCT
    : "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"
);
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 777);
/** The cross-margin hub this market settles against (= first market's id). */
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? process.env.ANQA_DEMO_MARKET ?? 777);
/** This market's asset slot inside the shared group. */
const ASSET_INDEX = Number(process.env.ANQA_ASSET_INDEX ?? 0);

/** Rollup slots are ~7x base slots; crank often or the clock drifts. */
const CRANK_MS = Number(process.env.ANQA_CRANK_MS ?? 2000);
/** Pyth on devnet moves slowly; the relay does not need the same cadence. */
const RELAY_MS = Number(process.env.ANQA_RELAY_MS ?? 2500);
/** Settlement should feel immediate to whoever just traded. */
const SETTLE_MS = Number(process.env.ANQA_SETTLE_MS ?? 1200);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (tag: string, msg: string) => console.log(`${now()}  ${tag.padEnd(7)} ${msg}`);

// A keeper that exits is worse than any error it might swallow: fills stop
// settling and the mark freezes. Network hiccups on public devnet RPCs are
// routine — log them and keep running.
process.on("unhandledRejection", (e) =>
  console.log(`${new Date().toISOString().slice(11, 19)}  guard   unhandled rejection: ${String(e).slice(0, 110)}`)
);
process.on("uncaughtException", (e) =>
  console.log(`${new Date().toISOString().slice(11, 19)}  guard   uncaught exception: ${String(e).slice(0, 110)}`)
);

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
  // The TEE endpoint filters reads per account; a signed session tells
  // it who we are. Without this the keeper reads back nulls.
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mk = (c: Connection) =>
    new Program(
      idl,
      new anchor.AnchorProvider(c, new anchor.Wallet(keeper), {
        commitment: "confirmed",
        skipPreflight: true, // latency matters more than a pre-flight here
      })
    ) as any;
  const pBase = mk(conn);
  const pEr = mk(er);

  const pda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(MARKET_ID), ...e], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const internalOracle = pda("anqa_int_oracle");
  const tape = pda("anqa_tape");
  const depth = pda("anqa_depth");
  // The venue keeps its own monotonic clock; see state/venue_clock.rs.
  const venueClock = gpda("anqa_clock");
  // Isolated margin: portfolios are market-scoped, one per trader per market.
  const portfolioOf = (k: PublicKey) => gpda("anqa_portfolio", [k.toBuffer()]);

  // For feeds without a persistent devnet account (ETH), re-resolve the
  // freshest transient post periodically; the relay always uses the latest.
  let feedAcct: PublicKey = BTC_FEED;
  const FEED_HEX = process.env.ANQA_FEED_HEX ?? "";
  const refreshFeed = async () => {
    try {
      feedAcct = await resolveFeedAccount(conn, FEED_HEX, BTC_FEED.toBase58());
    } catch {
      // keep the previous account; the relay will retry
    }
  };
  if (process.env.ANQA_FEED_ACCT === "auto") {
    await refreshFeed();
    setInterval(refreshFeed, 45_000);
  }

  log("start", `market ${MARKET_ID} · keeper ${keeper.publicKey.toBase58().slice(0, 8)}…`);
  log("start", `crank ${CRANK_MS}ms · settle ${SETTLE_MS}ms · relay ${RELAY_MS}ms`);

  let cranks = 0;
  let prints = 0;
  let lastErr = "";

  /** Never let one failure kill a loop; a keeper that exits is worse. */
  const guard = async (tag: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 110);
      if (msg !== lastErr) {
        log(tag, `· ${msg}`);
        lastErr = msg;
      }
    }
  };

  // relay: inside the rollup, against the clone-readable Pyth feed.
  let relays = 0;
  const relay = () =>
    guard("relay", async () => {
      await pEr.methods
        .syncInternalOracle()
        .accounts({
          keeper: keeper.publicKey,
          market,
          internalOracle,
          priceUpdate: feedAcct,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      relays++;
      if (relays % 10 === 1) log("relay", `oracle refreshed (${relays})`);
    });

  // crank: inside the rollup, off the relay.
  const crank = () =>
    guard("crank", async () => {
      await pEr.methods
        .crank(ASSET_INDEX, new BN(0))
        .accounts({
          cranker: keeper.publicKey,
          market,
          riskGroup,
          assetSlots,
          oracleState,
          internalOracle,
          venueClock,
        })
        .rpc();
      cranks++;
      if (cranks % 30 === 0) {
        const os1: any = await pEr.account.oracleState.fetch(oracleState);
        log("crank", `${cranks} ticks · mark $${(Number(os1.lastPrice) / 1e6).toLocaleString()}`);
      }
    });

  // settle: drain whatever the book matched, oldest first.
  const settle = () =>
    guard("settle", async () => {
      const bk: any = await pEr.account.book.fetch(book);
      let n = Number(bk.pendingCount ?? 0);
      if (n === 0) return;
      for (let i = 0; i < Math.min(n, 4); i++) {
        const cur: any = await pEr.account.book.fetch(book);
        if (Number(cur.pendingCount) === 0) break;
        const head = cur.pending[cur.pendingHead];
        await pEr.methods
          .settleFill()
          .accounts({
            caller: keeper.publicKey,
            market,
            book,
            riskGroup,
            assetSlots,
            oracleState,
            takerPortfolio: portfolioOf(new PublicKey(head.taker)),
            makerPortfolio: portfolioOf(new PublicKey(head.maker)),
            tape,
          })
          // A settle refreshes two accounts through the kernel and its cost
          // scales with how much accrual each must replay — the default 200k
          // CU budget is not always enough, and a starved settle stalls the
          // whole FIFO queue behind it.
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
          .rpc();
        prints++;
        log("settle", `${head.baseLots}@${head.priceInTicks} · ${prints} settled`);
      }
    });

  // mark-to-market: the kernel only recomputes an account's PnL when the
  // account is refreshed, so a position's unrealised PnL is frozen at its
  // last settlement until someone asks. Refresh every portfolio that holds a
  // position on a slow tick — the terminal then shows live PnL for free.
  const MAX_ASSETS_SLOTS = 12; // mirrors constants::MAX_ASSETS
  // disc + owner + market_id tag + bump + reserved_margin + claimed_high_water
  const HEADER = 8 + 32 + 8 + 1 + 16 + 8;
  // Isolated margin: collateral and blended entry per asset sit between the
  // header and the kernel bytes, so every raw offset past here shifts by both.
  const COLLATERAL = HEADER;
  const ENTRY = COLLATERAL + MAX_ASSETS_SLOTS * 16;
  const INNER = ENTRY + MAX_ASSETS_SLOTS * 16;
  const PF_SIZE = 3124 + 2 * MAX_ASSETS_SLOTS * 16; // account size incl. discriminator
  const LEGS = INNER + 340;
  const LEG_STRIDE = 144;
  const LEG_ASSET_INDEX = 1;
  const LEG_SIDE = 13;
  const LEG_BASIS = 14;
  const POS_SCALE = 1_000_000;
  const TICK_SIZE = Number(process.env.ANQA_TICK ?? 1000);

  /** This asset's open position, straight off the account bytes. */
  const readPosition = (data: Buffer, idx: number) => {
    for (let n = 0; n < 4; n++) {
      const base = LEGS + n * LEG_STRIDE;
      if (data[base] !== 1) continue;
      if (data.readUInt32LE(base + LEG_ASSET_INDEX) !== idx) continue;
      const raw = data.readBigInt64LE(base + LEG_BASIS);
      if (raw === 0n) continue;
      return {
        isLong: data[base + LEG_SIDE] === 0,
        lots: Number((raw < 0n ? -raw : raw) / BigInt(POS_SCALE)),
      };
    }
    return null;
  };
  // The scan is the expensive half, the refresh the cheap one — so scan for
  // position holders on a slow tick and re-mark the known holders on a fast
  // one. A position opened between scans waits at most one scan interval.
  let positionHolders: PublicKey[] = [];
  // Every portfolio in the group, holders or not — a trader who just closed
  // is flat but still carries junior pnl awaiting promotion.
  let groupPortfolios: PublicKey[] = [];
  const scanHolders = async () => {
    const accounts = await er.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: PF_SIZE }],
    });
    const holders: PublicKey[] = [];
    const portfolios: PublicKey[] = [];
    for (const { pubkey, account } of accounts) {
      // The wrapper tag is now the MARKET id (isolated portfolios). Accept
      // the whole hub's id range so the lead keeper can realize/checkpoint
      // every portfolio; markets are numbered group..group+15 at most.
      const tag = account.data.readBigUInt64LE(8 + 32);
      const g = BigInt(GROUP_ID.toString());
      if (tag < g || tag >= g + 16n) continue;
      portfolios.push(pubkey);
      for (let n = 0; n < 4; n++) {
        if (account.data[LEGS + n * LEG_STRIDE] === 1) {
          holders.push(pubkey);
          break;
        }
      }
    }
    positionHolders = holders;
    groupPortfolios = portfolios;
  };
  const markToMarket = async () => {
    for (const pubkey of positionHolders) {
      await pEr.methods
        .refreshPortfolio()
        .accounts({ market, riskGroup, assetSlots, portfolio: pubkey })
        .rpc()
        .catch(() => {});
    }
  };

  // checkpoint: commit the risk engine and every portfolio to base on a slow
  // tick. Commits are explicit-only (commit_frequency_ms = u32::MAX), so
  // base knows nothing newer than the last one — and an unplanned
  // undelegation (validator wedge, rollup death) strands everything since.
  // Hub 820 died exactly that way; one tick bounds the next incident.
  const MAGIC = {
    magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
    magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
  };
  const checkpoint = async () => {
    if (ASSET_INDEX !== 0) return;
    await pEr.methods
      .commitRiskGroup()
      .accounts({ payer: keeper.publicKey, riskGroup, ...MAGIC })
      .rpc()
      .catch(() => {});
    await pEr.methods
      .commitAssetSlots()
      .accounts({ payer: keeper.publicKey, assetSlots, ...MAGIC })
      .rpc()
      .catch(() => {});
    for (const pubkey of groupPortfolios) {
      await pEr.methods
        .checkpointPortfolio()
        .accounts({ payer: keeper.publicKey, portfolio: pubkey, ...MAGIC })
        .rpc()
        .catch(() => {});
    }
    log("commit", `risk engine + ${groupPortfolios.length} portfolio(s) checkpointed`);
  };

  // depth: rebuild the book's public mirror. The book is permissioned, so
  // only something inside the rollup that is allowed to read it can publish
  // the aggregate — and a taker who cannot size a trade goes elsewhere, so
  // this runs on the same tick as settlement.
  const publishDepth = () =>
    guard("depth", async () => {
      await pEr.methods
        .publishDepth()
        .accounts({ caller: keeper.publicKey, market, book, depth })
        .rpc();
    });

  // isolated liquidation: enforce that a position can only lose the collateral
  // put behind it. The kernel liquidates per ACCOUNT, so without this a bad
  // position eats a trader's whole balance before anything fires. Anqa records
  // collateral and blended entry per asset in the portfolio; the check here
  // mirrors `isolated_underwater` on-chain exactly, and the instruction refuses
  // if we are early — so calling it optimistically is safe.
  const isolatedSweep = async () => {
    const os1: any = await pEr.account.oracleState.fetch(oracleState).catch(() => null);
    if (!os1) return;
    const mark = Number(os1.lastPrice);
    for (const pubkey of positionHolders) {
      const info = await er.getAccountInfo(pubkey).catch(() => null);
      if (!info) continue;
      const collateral = Number(info.data.readBigUInt64LE(COLLATERAL + ASSET_INDEX * 16));
      const entry = Number(info.data.readBigUInt64LE(ENTRY + ASSET_INDEX * 16));
      if (collateral === 0 || entry === 0) continue;
      const leg = readPosition(info.data, ASSET_INDEX);
      if (!leg || leg.lots === 0) continue;

      // Mirrors `isolated_underwater` on-chain; the instruction refuses if we
      // are early, so calling optimistically costs nothing.
      const pnl = leg.isLong ? (mark - entry) * leg.lots : (entry - mark) * leg.lots;
      const maintenance = (mark * leg.lots * 250) / 10_000;
      if (collateral + pnl > maintenance) continue;

      const worst = leg.isLong ? Math.floor(mark * 0.9) : Math.ceil(mark * 1.1);
      await pEr.methods
        .liquidateIsolated(new BN(Math.floor(worst / TICK_SIZE)))
        .accounts({
          trader: keeper.publicKey,
          session: null,
          market,
          book,
          riskGroup,
          assetSlots,
          oracleState,
          portfolio: pubkey,
        })
        .rpc()
        .then(() => log("isolated", `${pubkey.toBase58().slice(0, 8)}… margin spent — liquidated`))
        .catch(() => {}); // refused: the position still has margin
    }
  };

  // realize: promote proven-backed junior profit into withdrawable capital.
  // Wins land junior ("losses are senior, wins are junior") and stay
  // unwithdrawable until `realize_pnl` promotes them; nothing else in the
  // system fires it. Permissionless and a no-op when nothing qualifies, so
  // it runs blind over every group portfolio — but from the group-lead
  // keeper only, or nine keepers would send nine copies.
  const realize = async () => {
    if (ASSET_INDEX !== 0) return;
    for (const pubkey of groupPortfolios) {
      await pEr.methods
        .realizePnl()
        .accounts({ caller: keeper.publicKey, market, riskGroup, assetSlots, portfolio: pubkey })
        .rpc()
        .catch(() => {}); // nothing to promote, or the domain is mid-refresh
    }
  };

  // sweep: expire lapsed positive-PnL backing buckets. A `Fresh` bucket past
  // its expiry makes every account refresh in its domain refuse with `Stale`
  // — one winner's expired winnings can wedge the asset. The kernel refuses
  // the sweep unless the bucket has actually lapsed, so calling it blind on
  // both domains is safe and cheap.
  const sweep = async () => {
    for (const domain of [ASSET_INDEX * 2, ASSET_INDEX * 2 + 1]) {
      await pEr.methods
        .sweepBacking(domain)
        .accounts({ caller: keeper.publicKey, market, riskGroup, assetSlots })
        .rpc()
        .then(() => log("sweep", `lapsed backing bucket expired — domain ${domain}`))
        .catch(() => {}); // not lapsed — the normal case
    }
  };


  // The deposit rail.
  //
  // A deposit is two halves: USDC moves into custody on base layer, and the
  // rollup credits the portfolio from that ledger. Only the first half is
  // signed by the trader. If the second never lands, their money sits in the
  // ledger uncredited, the terminal sees no collateral and asks them to
  // deposit *again* — which is exactly what happened live, and it costs the
  // trader real money every time they click.
  //
  // So the venue does not rely on the browser for it. `claim_deposit` is
  // permissionless and idempotent by design — it derives the credit from the
  // ledger, so anyone may run it for anyone — and this is the loop that was
  // always implied by that design and never actually built.
  //
  // Only the lead keeper runs it; the ledger is group-wide, so nine keepers
  // claiming the same deposits would be nine times the work for one result.
  const LEDGER_BYTES = 73;
  const claimDeposits = () =>
    guard("deposit", async () => {
      if (!MARKET_ID.eq(GROUP_ID)) return; // lead keeper only
      const ledgers = await conn.getProgramAccounts(PROGRAM_ID, {
        filters: [
          { dataSize: LEDGER_BYTES },
          { memcmp: { offset: 8 + 32, bytes: bs58.encode(le8(GROUP_ID)) } },
        ],
      });
      for (const { account } of ledgers) {
        const owner = new PublicKey(account.data.subarray(8, 40));
        const deposited = account.data.readBigUInt64LE(8 + 32 + 8);
        if (deposited === 0n) continue;
        // Claim only what has not been credited yet. `claim_deposit` is
        // idempotent, so sending it regardless would be harmless — but it
        // would also be a transaction every few seconds per trader, forever,
        // and a log line that says "credited" when nothing moved.
        const pf: any = await pEr.account.portfolio
          .fetch(portfolioOf(owner))
          .catch(() => null);
        if (!pf) continue; // no account opened yet
        const claimed = BigInt(new BN(pf.claimedHighWater, 10, "le").toString());
        if (deposited <= claimed) continue;
        try {
          await pEr.methods
            .claimDeposit()
            .accounts({
              caller: keeper.publicKey,
              market,
              riskGroup,
              assetSlots,
              portfolio: portfolioOf(owner),
              ledger: gpda("anqa_ledger", [owner.toBuffer()]),
              receipt: null,
              magicContext: null,
              magicProgram: null,
            } as never)
            .rpc();
          log(
            "deposit",
            `credited ${owner.toBase58().slice(0, 8)}… with $${(
              Number(deposited - claimed) / 1e6
            ).toLocaleString()}`
          );
        } catch {
          // Already credited is the common case and costs one failed
          // simulation; a missing portfolio means they have not opened an
          // account yet. Neither is worth logging every four seconds.
        }
      }
    });

  await relay();
  await sweep();
  await claimDeposits();

  // A keeper outage leaves the kernel with an accrual-slot debt: each crank
  // advances the accrual clock by at most `max_accrual_dt_slots` (100), so a
  // gap of hours arms loss-staleness and every fill settles as refused
  // (LockActive) until the clock catches up — at the normal cadence, ~35
  // slots/s against a rollup ticking ~15/s. So on every start, measure the
  // debt straight off the risk header and crank back-to-back until it clears.
  // Offsets pinned by programs/anqa-core/tests/diag.rs.
  const HDR = { slotLast: 8 + 573, lossStale: 8 + 591 };
  const debt = async () => {
    const [info, now] = await Promise.all([er.getAccountInfo(riskGroup), er.getSlot()]);
    if (!info) return { behind: 0, lossStale: false };
    return {
      behind: now - Number(info.data.readBigUInt64LE(HDR.slotLast)),
      lossStale: info.data[HDR.lossStale] === 1,
    };
  };
  const catchUp = async () => {
    let d = await debt();
    if (!d.lossStale && d.behind < 400) return;
    log("catchup", `accrual clock ${d.behind.toLocaleString()} slots behind — cranking hard`);
    for (let i = 0; d.lossStale || d.behind > 200; i++) {
      if (i >= 5000) return log("catchup", "gave up after 5000 cranks — still behind");
      try {
        await pEr.methods
          .crank(ASSET_INDEX, new BN(0))
          .accounts({ cranker: keeper.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle, venueClock })
          .rpc();
      } catch (e: any) {
        log("catchup", `· ${String(e?.message ?? e).slice(0, 90)}`);
        await sleep(1000);
      }
      if (i % 50 === 0) d = await debt();
      if (i % 200 === 0 && i > 0) log("catchup", `${d.behind.toLocaleString()} slots to go`);
    }
    log("catchup", "caught up — loss-staleness cleared");
  };
  await catchUp();

  await crank();

  // requote watchdog: a taker big enough to eat a whole side leaves the next
  // trader — often the same one, trying to close — with nothing to cross,
  // and an IoC close against an empty side just fails. When either side goes
  // dark, re-run the maker to lay the ladder again.
  //
  // The watchdog backs off when the maker keeps failing. On a fixed 15s
  // interval a maker that cannot start — a rate-limited RPC, say — gets
  // respawned four times a minute per market forever, and nine markets doing
  // that is enough load to *cause* the failure it is reacting to. Growing the
  // delay after each failure lets the endpoint recover; one success resets it.
  let requoting = false;
  let failures = 0;
  const REQUOTE_MS = 15_000;
  const REQUOTE_MAX_MS = 5 * 60_000;
  const requoteDelay = () =>
    Math.min(REQUOTE_MS * 2 ** failures, REQUOTE_MAX_MS) * (1 + Math.random() * 0.3);

  const requote = () =>
    guard("requote", async () => {
      if (requoting) return;
      const bk: any = await pEr.account.book.fetch(book);
      const active = (s: any) => s.orders.filter((o: any) => o.active === 1).length;
      if (active(bk.bids) > 0 && active(bk.asks) > 0) {
        failures = 0;
        return;
      }
      requoting = true;
      log("requote", "a side of the book is empty — re-running the maker");
      const child = spawn(
        "npx",
        ["ts-node", "--transpile-only", "app/demo-maker.ts"],
        { env: { ...process.env, ANQA_DEMO_MARKET: MARKET_ID.toString() }, stdio: "ignore" }
      );
      child.on("exit", (code) => {
        requoting = false;
        if (code === 0) {
          failures = 0;
          log("requote", "ladder restored");
        } else {
          failures++;
          log(
            "requote",
            `maker exited ${code} — next attempt in ${Math.round(requoteDelay() / 1000)}s`
          );
        }
      });
    });

  /** Self-scheduling so the delay can grow; `setInterval` cannot back off. */
  const scheduleRequote = () =>
    setTimeout(async () => {
      await requote();
      scheduleRequote();
    }, requoteDelay());

  setInterval(relay, RELAY_MS);
  setInterval(crank, CRANK_MS);
  setInterval(settle, SETTLE_MS);
  setInterval(publishDepth, 1_500);
  setInterval(sweep, 30_000);
  setInterval(() => guard("mtm-scan", scanHolders), 15_000);
  setInterval(() => guard("mtm", markToMarket), 1_500);
  setInterval(() => guard("realize", realize), 20_000);
  setInterval(() => guard("isolated", isolatedSweep), 4_000);
  setInterval(claimDeposits, 6_000);
  setInterval(() => guard("commit", checkpoint), 300_000);
  scheduleRequote();
  void guard("mtm-scan", scanHolders);

  process.on("SIGINT", () => {
    log("stop", `${cranks} cranks, ${prints} fills settled`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
