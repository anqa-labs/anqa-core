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
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const BTC_FEED = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 777);

/** Rollup slots are ~7x base slots; crank often or the clock drifts. */
const CRANK_MS = Number(process.env.ANQA_CRANK_MS ?? 2000);
/** Pyth on devnet moves slowly; the relay does not need the same cadence. */
const RELAY_MS = Number(process.env.ANQA_RELAY_MS ?? 20000);
/** Settlement should feel immediate to whoever just traded. */
const SETTLE_MS = Number(process.env.ANQA_SETTLE_MS ?? 1200);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const now = () => new Date().toISOString().slice(11, 19);
const log = (tag: string, msg: string) => console.log(`${now()}  ${tag.padEnd(7)} ${msg}`);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
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
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const internalOracle = pda("anqa_int_oracle");
  const tape = pda("anqa_tape");
  const portfolioOf = (k: PublicKey) => pda("anqa_portfolio", [k.toBuffer()]);

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
          priceUpdate: BTC_FEED,
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
        .crank(0, new BN(0))
        .accounts({
          cranker: keeper.publicKey,
          market,
          riskGroup,
          assetSlots,
          oracleState,
          internalOracle,
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
          .rpc();
        prints++;
        log("settle", `${head.baseLots}@${head.priceInTicks} · ${prints} settled`);
      }
    });

  await relay();
  await crank();

  setInterval(relay, RELAY_MS);
  setInterval(crank, CRANK_MS);
  setInterval(settle, SETTLE_MS);

  process.on("SIGINT", () => {
    log("stop", `${cranks} cranks, ${prints} fills settled`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
