/**
 * A resident market maker for the demo venue.
 *
 * Without depth the terminal is a beautiful empty room — and worse, it cannot
 * show the one thing worth showing: rows that exist and cannot be read. This
 * keeps a persistent maker quoting a ladder around the mark, so any visitor
 * sees hidden depth on both sides and can actually trade into it.
 *
 * Run once to set up and quote:      npx ts-node --transpile-only app/demo-maker.ts
 * Re-quote later (cancels, re-rests): same command.
 * Settle whatever the visitors matched: ANQA_SETTLE=1 same command.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { baseConnection } from "./rpc";
import fs from "fs";
import { teeRpcFor } from "./tee-auth";
import os from "os";
import path from "path";
import { resolveFeedAccount } from "./feed";
import { explain } from "./errs";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const BTC_FEED = new PublicKey(
  process.env.ANQA_FEED_ACCT && process.env.ANQA_FEED_ACCT !== "auto"
    ? process.env.ANQA_FEED_ACCT
    : "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"
);
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 777);
/** The cross-margin hub (= first market's id): custody + portfolio live here. */
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? process.env.ANQA_DEMO_MARKET ?? 777);
const DEC = 6;
const COLLATERAL = 2_000_000 * 10 ** DEC;
// Keep enough visible rungs for the terminal to feel like a real market while
// leaving most of the on-chain arena available to visitors. The book supports
// 32 orders per side and the public depth publishes 12 price levels per side.
const LEVELS = Math.max(
  1,
  Math.min(12, Number(process.env.ANQA_MAKER_LEVELS ?? 10))
);
const LOTS = Number(process.env.ANQA_MAKER_LOTS ?? 2500); // 2.5 BTC per level at 0.001-BTC lots
// Tight top-of-book: a market order pays half a spread of instant PnL the
// moment it fills, and 8bps read as "opened $30 down" on a mid-size entry.
// 2bps ≈ oracle-venue entry cost; the demo maker's equity absorbs the
// extra pick-off risk from oracle drift between requotes.
const STEP_BPS = 2; // ~0.02% between levels

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.ANQA_PACE ?? 700);

async function main() {
  const conn = baseConnection(RPC);
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );

  // A persistent identity, so the ladder belongs to the same maker each run.
  const makerFile = `app/.demo-maker-${GROUP_ID}.json`;
  let maker: Keypair;
  if (fs.existsSync(makerFile)) {
    maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(makerFile, "utf-8"))));
  } else {
    maker = Keypair.generate();
    fs.writeFileSync(makerFile, JSON.stringify(Array.from(maker.secretKey)));
  }
  // The TEE endpoint filters reads per account; a signed session tells
  // it who we are. Without this the keeper reads back nulls.
  const er = new Connection(await teeRpcFor(maker, ER_RPC), "confirmed");
  console.log(`\n════ demo maker ${maker.publicKey.toBase58()} ════\n`);

  const mintFile = `app/.demo-mint-${GROUP_ID}.json`;
  const mint = new PublicKey(JSON.parse(fs.readFileSync(mintFile, "utf-8")).mint);

  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mkProg = (c: Connection, kp: Keypair) =>
    new Program(idl, new anchor.AnchorProvider(c, new anchor.Wallet(kp), {
      commitment: "confirmed",
      skipPreflight: false,
    })) as any;
  const FEED_ACCT = await resolveFeedAccount(
    conn,
    process.env.ANQA_FEED_HEX ?? "",
    BTC_FEED.toBase58()
  );
  const pBase = mkProg(conn, maker);
  const pEr = mkProg(er, maker);
  const pAdminEr = mkProg(er, admin);

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
  const vault = gpda("anqa_vault");
  const tape = pda("anqa_tape");
  const depth = pda("anqa_depth");
  // The venue keeps its own monotonic clock; see state/venue_clock.rs.
  const venueClock = gpda("anqa_clock");
  // Isolated margin: the maker's portfolio is scoped to ITS market.
  const portfolio = gpda("anqa_portfolio", [maker.publicKey.toBuffer()]);
  const ledger = gpda("anqa_ledger", [maker.publicKey.toBuffer()]);
  const receipt = gpda("anqa_dreceipt", [maker.publicKey.toBuffer()]);
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });
  const exists = async (a: PublicKey) => (await conn.getAccountInfo(a)) !== null;
  const step = async (label: string, already: () => Promise<boolean>, run: () => Promise<any>) => {
    if (await already()) return console.log(`  ·  ${label}`);
    await run();
    await sleep(PACE);
    console.log(`  ✓  ${label}`);
  };

  // Rent and gas for the maker. A maker that has already been topped up stays
  // funded, and the watchdog re-runs this script constantly — so once we have
  // seen it funded, skip the check rather than spend an RPC call on it every
  // respawn. On a rate-limited endpoint that call was where the maker died.
  // The mark expires after an hour so a maker that slowly burns its gas still
  // gets topped up — the goal is one balance check per hour per market, not
  // never.
  const fundedMark = `app/.maker-funded-${MARKET_ID}`;
  const markFresh = (() => {
    try {
      return Date.now() - fs.statSync(fundedMark).mtimeMs < 60 * 60_000;
    } catch {
      return false;
    }
  })();
  const bal = markFresh ? Infinity : await conn.getBalance(maker.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: maker.publicKey,
        lamports: 0.25 * LAMPORTS_PER_SOL,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(conn, tx, [admin]);
    console.log("  ✓  maker funded with SOL");
  }
  if (!markFresh) fs.writeFileSync(fundedMark, "");

  await step("portfolio", () => exists(portfolio), () =>
    pBase.methods.openPortfolio()
      // The HUB market, never this maker's own. `open_portfolio` stamps
      // `portfolio.market_id` from whatever market it is handed, and every
      // trading instruction then demands that tag equal the market's
      // `group_id`. There is one portfolio per trader per hub, so whichever
      // market happened to run this script first would otherwise brand the
      // account with its own id and make it untradeable everywhere — which is
      // exactly what the requote watchdog did when it seeded SUI first.
      .accounts({ trader: maker.publicKey, market: gpda("anqa_market"), portfolio, systemProgram: SystemProgram.programId })
      .rpc()
  );
  await step("ledger", () => exists(ledger), () =>
    pBase.methods.initializeLedger()
      .accounts({ trader: maker.publicKey, market, ledger, systemProgram: SystemProgram.programId })
      .rpc()
  );

  const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, maker.publicKey);
  // Isolated margin: the ledger is group-wide but capital is per-market —
  // ask THIS portfolio whether it has been funded (kernel capital field;
  // offsets pinned by the layout tests, low 8 bytes suffice for demo sums).
  const pfCapital = async () => {
    const c = (await er.getAccountInfo(portfolio)) ?? (await conn.getAccountInfo(portfolio));
    return c ? c.data.readBigUInt64LE(73 + 132) : 0n;
  };
  if ((await pfCapital()) === 0n) {
    await mintTo(conn, admin, mint, ata.address, admin, COLLATERAL);
    const d = delegationOf(receipt);
    await pBase.methods.deposit(new BN(COLLATERAL), false)
      .accounts({
        trader: maker.publicKey, market, ledger,
        traderTokenAccount: ata.address, vault,
        receipt, buffer: d.buffer,
        delegationRecord: d.delegationRecord, delegationMetadata: d.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    await sleep(PACE);
    console.log(`  ✓  deposited ${(COLLATERAL / 1e6).toLocaleString()} USDC`);
  } else {
    console.log("  ·  collateral already deposited");
  }

  const isDelegated = (await conn.getAccountInfo(portfolio))?.owner?.equals(DLP) ?? false;
  if (!isDelegated) {
    const d = delegationOf(portfolio);
    await pBase.methods.delegatePortfolio(GROUP_ID)
      .accounts({
        trader: maker.publicKey, portfolio,
        bufferPortfolio: d.buffer, delegationRecordPortfolio: d.delegationRecord,
        delegationMetadataPortfolio: d.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
      })
      .rpc();
    await sleep(PACE);
    console.log("  ✓  portfolio delegated");
  } else {
    console.log("  ·  portfolio already in session");
  }

  await pEr.methods.claimDeposit()
    .accounts({
      caller: maker.publicKey, market, riskGroup, assetSlots, portfolio, ledger,
      receipt: null, magicContext: null, magicProgram: null,
    })
    .rpc().catch(() => {});
  await sleep(PACE);

  // Settle anything visitors matched against the ladder, so the tape moves.
  if (process.env.ANQA_SETTLE === "1") {
    for (let i = 0; i < 8; i++) {
      const bk: any = await pEr.account.book.fetch(book).catch(() => null);
      if (!bk || Number(bk.pendingCount) === 0) break;
      const head = bk.pending[bk.pendingHead];
      try {
        await pAdminEr.methods.settleFill()
          .accounts({
            caller: admin.publicKey, market, book, riskGroup, assetSlots, oracleState,
            takerPortfolio: pda("anqa_portfolio", [new PublicKey(head.taker).toBuffer()]),
            makerPortfolio: pda("anqa_portfolio", [new PublicKey(head.maker).toBuffer()]),
            tape,
          })
          .rpc();
        console.log(`  ✓  settled ${head.baseLots}@${head.priceInTicks}`);
      } catch (e: any) {
        console.log("  ·  settle:", String(e?.message ?? e).slice(0, 100));
        break;
      }
      await sleep(PACE);
    }
  }

  // Re-anchor before quoting, while the market is still provably empty.
  // The kernel refuses this the moment any position or loss exists, so it can
  // only ever run at a clean start — which is exactly when the accrual clock
  // needs pinning to the rollup's slot domain and the asset's price anchor
  // needs pinning to the live mark. Skipping it leaves the asset anchored
  // wherever it was when the market was created, and the first real fill is
  // refused (`LockActive`) for reasons that are very hard to see from outside.
  await pAdminEr.methods.syncInternalOracle()
    .accounts({ keeper: admin.publicKey, market, internalOracle, priceUpdate: FEED_ACCT, systemProgram: SystemProgram.programId })
    .rpc().catch(() => {});
  await sleep(PACE);
  const ASSET_INDEX = Number(process.env.ANQA_ASSET_INDEX ?? 0);
  await pAdminEr.methods.reanchorOracle(ASSET_INDEX)
    .accounts({ cranker: admin.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle, venueClock })
    .rpc()
    .then(() => console.log("  ✓  re-anchored at a clean start"))
    .catch((e: any) => console.log("  ·  re-anchor:", explain(e, 120)));
  await sleep(PACE);

  // Fresh mark, then re-quote from scratch.
  await pAdminEr.methods.crank(ASSET_INDEX, new BN(0))
    .accounts({ cranker: admin.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle, venueClock })
    .rpc().catch(() => {});
  await sleep(PACE);
  const os1: any = await pEr.account.oracleState.fetch(oracleState);
  const mark = Number(os1.lastPrice);
  const m: any = await pBase.account.market.fetch(market);
  const tick = Number(m.tickSize);
  const markTicks = Math.floor(mark / tick);
  console.log(`  ·  mark $${(mark / 1e6).toLocaleString()}`);

  await pEr.methods.cancelAllOrders()
    .accounts({ trader: maker.publicKey, session: null, market, book, portfolio })
    .rpc().catch(() => {});
  await sleep(PACE);

  // The kernel refuses resting orders from an account whose health cert is
  // stamped against an old epoch ("Stale"), and epochs advance with every
  // crank. Recertify right before quoting; it costs one instruction.
  await pEr.methods.refreshPortfolio()
    .accounts({ market, riskGroup, assetSlots, portfolio })
    .rpc()
    .then(() => console.log("  ✓  portfolio recertified"))
    .catch((e: any) => console.log("  ·  refresh:", explain(e, 120)));
  await sleep(PACE);

  let rested = 0;
  for (let i = 1; i <= LEVELS; i++) {
    const off = Math.max(1, Math.round((markTicks * STEP_BPS * i) / 10_000));
    for (const [side, px] of [
      [{ bid: {} }, markTicks - off],
      [{ ask: {} }, markTicks + off],
    ] as const) {
      try {
        await pEr.methods
          // Keep this on the single-order path for now: unlike the deployed
          // batch instruction, it sweeps lapsed backing before refreshing the
          // maker's live portfolio, so an existing position cannot wedge the
          // ladder with `LockActive`.
          .placeOrder(side, { postOnly: {} }, new BN(px), new BN(LOTS), new BN(Date.now() % 1e9 + rested), new BN(0), process.env.HIDE_RUNGS === "1")
          .accounts({
            trader: maker.publicKey, session: null, market, book, riskGroup, assetSlots, oracleState, portfolio,
          })
          .rpc();
        rested++;
        await sleep(PACE);
      } catch (e: any) {
        console.log(`  ·  level ${i}:`, explain(e, 120));
      }
    }
  }
  if (rested !== LEVELS * 2) {
    throw new Error(`incomplete ladder: ${rested}/${LEVELS * 2} quotes rested`);
  }
  // The book is private and a maker is not a member of it — reading it back
  // is a courtesy, not a requirement, so report what the venue publishes
  // instead: the aggregate depth anyone can see.
  const dep: any = await pEr.account.bookDepth.fetch(depth).catch(() => null);
  const tp: any = await pEr.account.fillTape.fetch(tape).catch(() => null);
  console.log(
    `\n  ✓  ${rested} orders resting — published depth ${dep?.bidLevels ?? "?"} bid / ${dep?.askLevels ?? "?"} ask levels`
  );
  console.log(`  ·  tape has ${tp.count} print(s)\n`);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
