/**
 * Devnet resting-order auto matcher.
 *
 * This is intentionally separate from the venue keeper: the keeper advances
 * risk and settles already-matched fills, while this process is an explicit
 * test counterparty. It waits before taking a user's resting order so the row
 * is observable in the terminal, then crosses exactly that order with the
 * funded demo maker.
 *
 * Safety:
 * - hard-gated to the devnet 930 hub unless the source is deliberately edited;
 * - never matches the demo maker's own ladder;
 * - waits for an unchanged order to remain live for the full delay;
 * - follows the book's linked price-time queue, hidden orders included;
 * - clears/restores only demo-maker quotes ahead of the selected user order;
 * - submits one exact IOC at a time and waits for the pending queue to clear.
 *
 * Run:
 *   ANQA_AUTO_MATCH=1 ANQA_GROUP=930 \
 *   npx ts-node --transpile-only app/devnet-auto-match.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { teeRpcFor } from "./tee-auth";

const PROGRAM_ID = new PublicKey(
  "4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW"
);
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? "930");
const MARKET_COUNT = Number(process.env.ANQA_MARKET_COUNT ?? 9);
const MATCH_DELAY_MS = Number(process.env.ANQA_MATCH_DELAY_MS ?? 10_000);
const SCAN_MS = Number(process.env.ANQA_MATCH_SCAN_MS ?? 1_000);
// A refused match is usually the risk engine mid-requote, which clears in a
// tick — so back off briefly and try again rather than parking the order for
// fifteen seconds while a demo is being recorded.
const RETRY_MS = Number(process.env.ANQA_MATCH_RETRY_MS ?? 2_000);
const NIL = 0xffff;

type Side = "bid" | "ask";
type Candidate = {
  marketId: number;
  side: Side;
  owner: PublicKey;
  clientOrderId: BN;
  price: BN;
  lots: BN;
  seq: BN;
  hidden: boolean;
  key: string;
};

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const field = (x: any, snake: string, camel: string) =>
  x?.[snake] ?? x?.[camel];
const asBn = (x: any) => new BN(x?.toString?.() ?? String(x));
const short = (k: PublicKey) => `${k.toBase58().slice(0, 8)}…`;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (tag: string, message: string) =>
  console.log(`${stamp()}  ${tag.padEnd(7)} ${message}`);

function walk(side: any): any[] {
  const result: any[] = [];
  const orders = side?.orders ?? [];
  let cursor = Number(side?.head ?? NIL);
  const visited = new Set<number>();
  while (
    cursor !== NIL &&
    cursor >= 0 &&
    cursor < orders.length &&
    !visited.has(cursor)
  ) {
    visited.add(cursor);
    const order = orders[cursor];
    if (!order) break;
    if (order.active === 1) result.push(order);
    cursor = Number(order.next ?? NIL);
  }
  return result;
}

function candidate(marketId: number, side: Side, order: any): Candidate {
  const owner = new PublicKey(order.trader);
  const clientOrderId = asBn(field(order, "client_order_id", "clientOrderId"));
  const price = asBn(field(order, "price_in_ticks", "priceInTicks"));
  const lots = asBn(field(order, "base_lots", "baseLots"));
  const seq = asBn(order.seq);
  const hidden = Number(order.hidden ?? 0) === 1;
  return {
    marketId,
    side,
    owner,
    clientOrderId,
    price,
    lots,
    seq,
    hidden,
    // Size and price are part of identity so amendments restart the delay.
    key: [marketId, side, owner.toBase58(), clientOrderId, price, lots].join(
      ":"
    ),
  };
}

function sameOrder(order: any, target: Candidate): boolean {
  return (
    new PublicKey(order.trader).equals(target.owner) &&
    asBn(field(order, "client_order_id", "clientOrderId")).eq(
      target.clientOrderId
    ) &&
    asBn(field(order, "price_in_ticks", "priceInTicks")).eq(target.price) &&
    asBn(field(order, "base_lots", "baseLots")).eq(target.lots)
  );
}

async function main() {
  if (process.env.ANQA_AUTO_MATCH !== "1") {
    throw new Error("refusing to run without ANQA_AUTO_MATCH=1");
  }
  if (!ER_RPC.includes("devnet") || !GROUP_ID.eqn(930)) {
    throw new Error("devnet auto-match is hard-gated to the 930 hub");
  }
  if (!Number.isFinite(MATCH_DELAY_MS) || MATCH_DELAY_MS < 10_000) {
    throw new Error("ANQA_MATCH_DELAY_MS must be at least 10000");
  }
  if (!Number.isInteger(MARKET_COUNT) || MARKET_COUNT < 1 || MARKET_COUNT > 9) {
    throw new Error("ANQA_MARKET_COUNT must be between 1 and 9");
  }

  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ??
            path.join(os.homedir(), ".config/solana/id.json"),
          "utf-8"
        )
      )
    )
  );
  // The venue's quoting key. Defaults to the resident maker daemon's key so
  // its ladder is recognised (and cleared/restored) as venue quotes; the
  // legacy demo-maker file remains the fallback for older venues.
  const makerKeyFile =
    process.env.ANQA_VENUE_MAKER_KEYFILE ??
    [`app/.mm-maker-${GROUP_ID.toString()}.json`, `app/.demo-maker-${GROUP_ID.toString()}.json`].find(
      (p) => fs.existsSync(p)
    );
  if (!makerKeyFile) throw new Error("no venue maker keyfile found");
  const maker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(makerKeyFile, "utf-8")))
  );
  // Every key the venue itself quotes (or used to quote) with. Orders from
  // these keys are never match targets — without this, a retired maker's
  // stale ladder starves real user orders (older seqs are serviced first).
  const venueKeys = [
    `app/.mm-maker-${GROUP_ID.toString()}.json`,
    `app/.demo-maker-${GROUP_ID.toString()}.json`,
  ]
    .filter((p) => fs.existsSync(p))
    .map((p) =>
      Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
      ).publicKey.toBase58()
    );
  const isVenue = (trader: any) => venueKeys.includes(new PublicKey(trader).toBase58());
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const keeperEr = new Connection(await teeRpcFor(keeper, ER_RPC), "processed");
  const makerEr = new Connection(await teeRpcFor(maker, ER_RPC), "processed");
  const program = (connection: Connection, signer: Keypair) =>
    new Program(
      idl,
      new anchor.AnchorProvider(connection, new anchor.Wallet(signer), {
        commitment: "processed",
        preflightCommitment: "processed",
        skipPreflight: true,
      })
    ) as any;
  const inspect = program(keeperEr, keeper);
  const trade = program(makerEr, maker);
  const gpda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync(
      [S(seed), le8(GROUP_ID), ...extra],
      PROGRAM_ID
    )[0];
  const mpda = (seed: string, marketId: number) =>
    PublicKey.findProgramAddressSync([S(seed), le8(marketId)], PROGRAM_ID)[0];
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const portfolio = gpda("anqa_portfolio", [maker.publicKey.toBuffer()]);

  const firstSeen = new Map<string, number>();
  const retryAfter = new Map<string, number>();
  let stopping = false;
  let matched = 0;
  let lastHealth = 0;

  const restore = async (
    marketId: number,
    market: PublicKey,
    book: PublicKey,
    side: Side,
    orders: any[]
  ) => {
    for (const order of orders) {
      try {
        await trade.methods
          .placeOrder(
            side === "bid" ? { bid: {} } : { ask: {} },
            { postOnly: {} },
            asBn(field(order, "price_in_ticks", "priceInTicks")),
            asBn(field(order, "base_lots", "baseLots")),
            asBn(field(order, "client_order_id", "clientOrderId")),
            new BN(0),
            Number(order.hidden ?? 0) === 1
          )
          .accounts({
            trader: maker.publicKey,
            session: null,
            market,
            book,
            riskGroup,
            assetSlots,
            oracleState: mpda("anqa_oracle", marketId),
            portfolio,
          })
          .rpc();
      } catch (e: any) {
        log(
          "restore",
          `${side} quote not restored: ${String(e?.message ?? e).slice(0, 90)}`
        );
      }
    }
  };

  const match = async (target: Candidate) => {
    const market = mpda("anqa_market", target.marketId);
    const book = mpda("anqa_book", target.marketId);
    const oracleState = mpda("anqa_oracle", target.marketId);
    const sideArg = target.side === "bid" ? { bid: {} } : { ask: {} };
    const oppositeArg = target.side === "bid" ? { ask: {} } : { bid: {} };
    const removed: any[] = [];

    try {
      let bk: any = await inspect.account.book.fetch(book);
      if (Number(field(bk, "pending_count", "pendingCount")) !== 0)
        return false;
      const queue = walk(target.side === "bid" ? bk.bids : bk.asks);
      const index = queue.findIndex((order) => sameOrder(order, target));
      if (index < 0) return false;
      // Every order before the target must be one THIS process can cancel —
      // i.e. owned by the key it signs with. A foreign venue key's rung (a
      // retired maker still being respawned somewhere) is not clearable: the
      // cancel would fail 6004 and the whole match would retry forever. Say so
      // once and move on, rather than looping silently.
      const blocker = queue
        .slice(0, index)
        .find((order) => !new PublicKey(order.trader).equals(maker.publicKey));
      if (blocker) {
        retryAfter.set(target.key, Date.now() + RETRY_MS);
        log(
          "blocked",
          `${target.marketId} ${target.side}: ${short(
            new PublicKey(blocker.trader)
          )} rests ahead and is not this maker — stop the other maker`
        );
        return false;
      }

      // Clearing the venue rungs ahead and crossing the target must be ONE
      // transaction. Sent separately, the resident maker's requote loop refills
      // the gap within its tick, so the re-read never sees the user's order at
      // the head and the match never fires — a user order could rest forever
      // while the log said nothing at all. Atomicity makes the race impossible.
      const ahead = queue.slice(0, index);
      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        // Refresh BEFORE the cancels, not after. A cancel releases margin
        // through the risk engine, and the engine refuses (6010) when it is
        // asked to do that against an account whose kernel state has drifted
        // since the last touch — which is every requote tick on a live book.
        await trade.methods
          .refreshPortfolio()
          .accounts({ market, riskGroup, assetSlots, portfolio })
          .instruction(),
      ];
      for (const order of ahead) {
        ixs.push(
          await trade.methods
            .cancelOrder(
              sideArg,
              asBn(field(order, "client_order_id", "clientOrderId"))
            )
            .accounts({
              trader: maker.publicKey,
              session: null,
              market,
              book,
              portfolio,
            })
            .instruction()
        );
        // Remember enough to restore the venue ladder after this one fill.
        removed.push(order);
      }
      ixs.push(
        await trade.methods
          .placeOrder(
            oppositeArg,
            { immediateOrCancel: {} },
            target.price,
            target.lots,
            new BN(Date.now() % 1_000_000_000),
            new BN(0),
            false
          )
          .accounts({
            trader: maker.publicKey,
            session: null,
            market,
            book,
            riskGroup,
            assetSlots,
            oracleState,
            portfolio,
          })
          .instruction()
      );
      // Send raw, not through Anchor. On the rollup `.rpc()`/`sendAndConfirm`
      // fail in their websocket confirm step with "Unknown action 'undefined'"
      // even when the transaction landed — which turned every successful match
      // into a retry, and the restore below then re-laid quotes over a fill
      // that had already happened.
      const tx = new Transaction().add(...ixs);
      tx.feePayer = maker.publicKey;
      tx.recentBlockhash = (await makerEr.getLatestBlockhash()).blockhash;
      tx.sign(maker);
      const sig = await makerEr.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
      // Confirm by polling — the same reason the send is raw.
      let landed = false;
      for (let i = 0; i < 20 && !landed; i++) {
        await sleep(250);
        const st = await makerEr.getSignatureStatus(sig).catch(() => null);
        if (st?.value?.err) throw new Error(`tx failed: ${JSON.stringify(st.value.err)}`);
        landed = Boolean(st?.value?.confirmationStatus);
      }
      if (!landed) throw new Error("match tx not confirmed in 5s");

      matched++;
      firstSeen.delete(target.key);
      retryAfter.delete(target.key);
      log(
        "matched",
        `${target.marketId} ${target.side} ${target.lots}@${
          target.price
        } for ${short(target.owner)}` +
          ` · ${target.hidden ? "hidden" : "shown"} · ${sig.slice(0, 10)}…`
      );
      return true;
    } catch (e: any) {
      retryAfter.set(target.key, Date.now() + RETRY_MS);
      log(
        "retry",
        `${target.marketId} ${target.side} ${short(target.owner)}: ${String(
          e?.message ?? e
        ).slice(0, 100)}`
      );
      return false;
    } finally {
      await restore(target.marketId, market, book, target.side, removed);
    }
  };

  const scan = async () => {
    const now = Date.now();
    const seen = new Set<string>();
    const mature: Candidate[] = [];
    let booksRead = 0;

    for (let offset = 0; offset < MARKET_COUNT; offset++) {
      const marketId = GROUP_ID.toNumber() + offset;
      const book = mpda("anqa_book", marketId);
      const bk: any = await inspect.account.book.fetch(book).catch(() => null);
      if (!bk) continue;
      booksRead++;
      if (Number(field(bk, "pending_count", "pendingCount")) !== 0) continue;

      for (const side of ["bid", "ask"] as const) {
        const userOrders: Candidate[] = [];
        for (const order of walk(side === "bid" ? bk.bids : bk.asks)) {
          if (isVenue(order.trader)) continue;
          const target = candidate(marketId, side, order);
          userOrders.push(target);
          seen.add(target.key);
          if (!firstSeen.has(target.key)) {
            firstSeen.set(target.key, now);
            log(
              "waiting",
              `${marketId} ${side} ${target.lots}@${target.price} for ${short(
                target.owner
              )}` + ` · eligible in ${Math.ceil(MATCH_DELAY_MS / 1000)}s`
            );
          }
        }
        // Only the first non-maker order can be reached without crossing a
        // different user's priority. Deeper orders still age while resting,
        // but cannot starve a newer, better-priced order at the head.
        const next = userOrders[0];
        if (next) {
          const age = now - (firstSeen.get(next.key) ?? now);
          if (age >= MATCH_DELAY_MS && now >= (retryAfter.get(next.key) ?? 0))
            mature.push(next);
        }
      }
    }

    // Cancellation or amendment removes the old identity and its timer.
    for (const key of firstSeen.keys()) {
      if (!seen.has(key)) {
        firstSeen.delete(key);
        retryAfter.delete(key);
      }
    }

    // Across both sides, service the oldest book sequence first. One at a time
    // keeps the dark pending queue small and gives settlement a clean boundary.
    if (now - lastHealth >= 30_000) {
      log(
        "health",
        `${booksRead}/${MARKET_COUNT} books readable · ${seen.size} user order(s) waiting`
      );
      lastHealth = now;
    }
    mature.sort((a, b) => a.seq.cmp(b.seq));
    if (mature.length) await match(mature[0]);
  };

  log(
    "start",
    `${MARKET_COUNT} market(s) ${GROUP_ID}–${GROUP_ID.addn(MARKET_COUNT - 1)}` +
      ` · ${MATCH_DELAY_MS / 1000}s delay · maker ${short(maker.publicKey)}`
  );
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  while (!stopping) {
    const began = Date.now();
    await scan().catch((e: any) =>
      log("scan", String(e?.message ?? e).slice(0, 100))
    );
    await sleep(Math.max(100, SCAN_MS - (Date.now() - began)));
  }
  log("stop", `${matched} order(s) matched`);
}

main().catch((e: any) => {
  console.error(e?.logs ?? e?.message ?? e);
  process.exit(1);
});
