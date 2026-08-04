/**
 * Provision the demo market the web terminal trades on.
 *
 * Unlike the e2e scripts — which mint a fresh market per run and tear the
 * whole world down with them — this creates one market at a **fixed id** and
 * leaves it standing: dark, permissioned, delegated, with a public tape.
 * Re-running it is safe; each step is skipped if it already exists.
 *
 * Run: npx ts-node --transpile-only app/demo-market.ts
 * Then put the printed values in web/.env.local.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const BTC_FEED = new PublicKey(
  process.env.ANQA_FEED_ACCT && process.env.ANQA_FEED_ACCT !== "auto"
    ? process.env.ANQA_FEED_ACCT
    : "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"
);

const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";
/** Fixed so the terminal always finds the same venue. */
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 777);
const TICK = 1_000; // $0.001 per tick on a ~$63 lot
const DEC = 6;
const DARK = process.env.ANQA_DEMO_LIT !== "1";

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.ANQA_PACE ?? 800);

async function main() {
  const conn = baseConnection(RPC);
  const er = new Connection(ER_RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p: any = new Program(idl, provider);
  const pEr: any = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(payer), { commitment: "confirmed", skipPreflight: false }));

  const pda = (tag: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(tag), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const internalOracle = pda("anqa_int_oracle");
  const vault = pda("anqa_vault");
  const tape = pda("anqa_tape");
  const permissionOf = (a: PublicKey) =>
    PublicKey.findProgramAddressSync([S("permission:"), a.toBuffer()], ACL)[0];
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });
  const exists = async (a: PublicKey) => (await conn.getAccountInfo(a)) !== null;
  const isDelegated = async (a: PublicKey) =>
    (await conn.getAccountInfo(a))?.owner?.equals(DLP) ?? false;

  const step = async (label: string, already: () => Promise<boolean>, run: () => Promise<any>) => {
    if (await already()) return console.log(`  ·  ${label} — already done`);
    await run();
    await sleep(PACE);
    console.log(`  ✓  ${label}`);
  };

  console.log(`\n════ anqa demo market ${MARKET_ID} ════\n`);

  let mint: PublicKey;
  const mintFile = `app/.demo-mint-${MARKET_ID}.json`;
  if (fs.existsSync(mintFile)) {
    mint = new PublicKey(JSON.parse(fs.readFileSync(mintFile, "utf-8")).mint);
    console.log(`  ·  collateral mint — reusing ${mint.toBase58()}`);
  } else {
    mint = await createMint(conn, payer, payer.publicKey, null, DEC);
    fs.writeFileSync(mintFile, JSON.stringify({ mint: mint.toBase58() }, null, 2));
    console.log(`  ✓  collateral mint ${mint.toBase58()}`);
  }

  await step("market + book", () => exists(market), () =>
    p.methods
      .initializeMarket(MARKET_ID, new BN(TICK), new BN(100_000 /* 0.001 BTC per lot */), 8, DEC, 0, 0, { pyth: {} }, {
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
      })
      .accounts({ authority: payer.publicKey, market, book, oracleState, systemProgram: SystemProgram.programId })
      .rpc()
  );

  await step("risk engine", () => exists(riskGroup), () =>
    p.methods.initializeRisk(MARKET_ID, 1)
      .accounts({ authority: payer.publicKey, market, riskGroup, assetSlots, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
      .rpc()
  );

  await step("custody vault", () => exists(vault), () =>
    p.methods.initializeVault(MARKET_ID)
      .accounts({ authority: payer.publicKey, market, collateralMint: mint, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
      .rpc()
  );

  await step("public tape", () => exists(tape), () =>
    p.methods.initializeTape(MARKET_ID)
      .accounts({ authority: payer.publicKey, market, tape, systemProgram: SystemProgram.programId })
      .rpc()
  );

  await step("oracle relay synced", async () => false, () =>
    p.methods.syncInternalOracle()
      .accounts({ keeper: payer.publicKey, market, internalOracle, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
      .rpc()
  );

  if (DARK) {
    await step("market set dark", async () => (await p.account.market.fetch(market)).dark === true, () =>
      p.methods.setDark(true).accounts({ authority: payer.publicKey, market, book }).rpc()
    );
    await step("book permissioned (engine-only)", () => exists(permissionOf(book)), () =>
      p.methods
        .createBookPermission(MARKET_ID, [{ pubkey: payer.publicKey, flags: 31 }])
        .accounts({
          authority: payer.publicKey, market, book,
          permission: permissionOf(book), permissionProgram: ACL, systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  // Delegation last: a delegated account can no longer be written from base.
  // The relay goes in with the rest: left on base it would be clone-read as a
  // frozen snapshot, and the mark would stop moving. The keeper refreshes it
  // from inside the rollup, where Pyth is clone-readable.
  const dels: [string, string, PublicKey, string][] = [
    ["book", "delegateBook", book, "book"],
    ["risk group", "delegateRiskGroup", riskGroup, "riskGroup"],
    ["asset slots", "delegateAssetSlots", assetSlots, "assetSlots"],
    ["internal oracle", "delegateInternalOracle", internalOracle, "internalOracle"],
    ["oracle state", "delegateOracleState", oracleState, "oracleState"],
    ["tape", "delegateTape", tape, "tape"],
  ];
  for (const [label, method, target, field] of dels) {
    const d = delegationOf(target);
    const cap = field[0].toUpperCase() + field.slice(1);
    await step(`${label} delegated`, () => isDelegated(target), () =>
      p.methods[method](MARKET_ID)
        .accounts({
          payer: payer.publicKey,
          [field]: target,
          [`buffer${cap}`]: d.buffer,
          [`delegationRecord${cap}`]: d.delegationRecord,
          [`delegationMetadata${cap}`]: d.delegationMetadata,
          ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  // The rollup runs its own slot stream, far ahead of base; the kernel's
  // bounded accrual can never walk that gap. Re-anchor once, while empty.
  try {
    await pEr.methods.syncInternalOracle()
      .accounts({ keeper: payer.publicKey, market, internalOracle, priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId })
      .rpc().catch(() => {});
    await sleep(PACE);
    await pEr.methods.reanchorOracle(0)
      .accounts({ cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle })
      .rpc();
    await sleep(PACE);
    console.log("  ✓  accrual clock re-anchored to rollup slots");
  } catch (e: any) {
    console.log("  ·  re-anchor skipped:", String(e?.message ?? e).slice(0, 90));
  }
  try {
    await pEr.methods.crank(0, new BN(0))
      .accounts({ cranker: payer.publicKey, market, riskGroup, assetSlots, oracleState, internalOracle })
      .rpc();
    const os1: any = await pEr.account.oracleState.fetch(oracleState);
    console.log(`  ✓  marked at $${(Number(os1.lastPrice) / 1e6).toLocaleString()}`);
  } catch (e: any) {
    console.log("  ·  crank skipped:", String(e?.message ?? e).slice(0, 90));
  }

  // Faucet float: the API route mints from this authority on demand.
  await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);

  console.log(`\n─── web/.env.local ───`);
  console.log(`NEXT_PUBLIC_ANQA_PROGRAM=${PROGRAM_ID.toBase58()}`);
  console.log(`NEXT_PUBLIC_MARKET_ID=${MARKET_ID.toString()}`);
  console.log(`NEXT_PUBLIC_COLLATERAL_MINT=${mint.toBase58()}`);
  console.log(`NEXT_PUBLIC_BASE_RPC=${RPC}`);
  console.log(`NEXT_PUBLIC_ER_RPC=${ER_RPC}`);
  console.log(`# faucet (devnet play money; keep out of git)`);
  console.log(`ANQA_FAUCET_KEY=[…contents of ~/.config/solana/id.json…]`);
  console.log(`──────────────────────\n`);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});

/*
 * RESOLVED (2026-08-01): the `LockActive` settle refusals had THREE causes,
 * found by replaying dumped chain state through the kernel offline
 * (`programs/anqa-core/tests/diag.rs`):
 *
 * 1. **Accrual-slot debt.** The kernel's clock advances at most
 *    `max_accrual_dt_slots` (100) per crank while rollup slots tick ~15/s;
 *    any pause in cranking arms `loss_stale_active` and fills refuse until
 *    the clock catches up. Fix: `catchUp` in app/keeper.ts cranks
 *    back-to-back on start until the debt clears.
 *
 * 2. **Lapsed backing buckets.** Realized positive PnL is backed by a
 *    per-domain bucket with a slot expiry; once lapsed, every account
 *    refresh in the domain refuses `Stale` until it is swept — and nothing
 *    called the kernel's sweep. Fix: the `sweep_backing` instruction, driven
 *    by the keeper every 30s.
 *
 * 3. **The crank never pushed the raw oracle target.** The kernel refuses
 *    every risk-increasing trade while `effective_price !=
 *    raw_oracle_target_price`, and only anchor/activation ever set the
 *    target — so the first mark move after an anchor froze all new
 *    positions. This was the original shape of this gap. Fix: crank.rs now
 *    calls `set_asset_raw_oracle_target_not_atomic` with the fresh mark
 *    every crank.
 *
 * The rule that remains: the keeper must stay alive; a dark venue cannot
 * run itself.
 */
