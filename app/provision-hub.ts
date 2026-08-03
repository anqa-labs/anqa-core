/**
 * Provision the cross-margin hub: one risk group, one vault, one collateral
 * mint — and every market inside it.
 *
 * The convention that keeps the program simple: **the group's id is its first
 * market's id.** Group-scoped PDAs (risk, assets, vault, portfolios, ledgers,
 * receipts) are seeded by it; per-market accounts (book, oracle, tape) keep
 * their own ids. One deposit margins every market; one portfolio holds a leg
 * per asset.
 *
 * Idempotent: re-running skips whatever already exists.
 *
 * Run: npx ts-node --transpile-only app/provision-hub.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveFeedCandidates } from "./feed";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";
const GROUP = Number(process.env.ANQA_GROUP ?? 880);
const DEC = 6;

type Mkt = {
  id: number;
  asset: number;
  sym: string;
  feedHex: string;
  feedAcct: string | "auto";
  baseDecimals: number;
  lotSize: number;
  tick: number;
};
const MKTS: Mkt[] = [
  { id: GROUP, asset: 0, sym: "BTC", feedHex: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", feedAcct: "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo", baseDecimals: 8, lotSize: 100_000, tick: 1_000 },
  { id: GROUP + 1, asset: 1, sym: "SOL", feedHex: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", feedAcct: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", baseDecimals: 9, lotSize: 100_000_000, tick: 1_000 },
  // Feed accounts below are shard-0 push-oracle PDAs kept fresh by
  // `app/push-feed.ts` — devnet has no sponsor for these feeds.
  { id: GROUP + 2, asset: 2, sym: "ETH", feedHex: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", feedAcct: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC", baseDecimals: 8, lotSize: 1_000_000, tick: 1_000 },
  { id: GROUP + 3, asset: 3, sym: "XRP", feedHex: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8", feedAcct: "Ae3LGcV5Wt5Z11xvhxSX1h65uNyjuX4qYFFbgifLx5eX", baseDecimals: 6, lotSize: 10_000_000, tick: 1_000 },
  { id: GROUP + 4, asset: 4, sym: "DOGE", feedHex: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c", feedAcct: "681QkKLoAQrB5h23Ewq9c8rjM19RBuzqwXZf2RPr9Pyw", baseDecimals: 6, lotSize: 100_000_000, tick: 1_000 },
  { id: GROUP + 5, asset: 5, sym: "LINK", feedHex: "8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221", feedAcct: "7bWHpGtb2j3jqbpA5gFctdmgZELubiZDBxmt1pEzkBHR", baseDecimals: 6, lotSize: 1_000_000, tick: 1_000 },
  { id: GROUP + 6, asset: 6, sym: "AVAX", feedHex: "93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7", feedAcct: "HUBqpBf3aGJdVQndFHmMUd1eMcixt7S4swYPCx8A93K1", baseDecimals: 6, lotSize: 1_000_000, tick: 1_000 },
  { id: GROUP + 7, asset: 7, sym: "SUI", feedHex: "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", feedAcct: "GgV3a7YeVRga9prjNGEDBG9NwatSaD8rwjZ4GNjPiXTq", baseDecimals: 6, lotSize: 10_000_000, tick: 1_000 },
  { id: GROUP + 8, asset: 8, sym: "BNB", feedHex: "2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f", feedAcct: "A3qp5QG9xGeJR1gexbW9b9eMMsMDLzx3rhud9SnNhwb4", baseDecimals: 6, lotSize: 100_000, tick: 1_000 },
];

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.ANQA_PACE ?? 800);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mk = (c: Connection) =>
    new Program(idl, new anchor.AnchorProvider(c, new anchor.Wallet(payer), { commitment: "confirmed" })) as any;
  const p = mk(conn);
  const pEr = mk(er);

  const pda = (tag: string, id: number, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(tag), le8(id), ...extra], PROGRAM_ID)[0];
  const gRisk = pda("anqa_risk", GROUP);
  const gAssets = pda("anqa_assets", GROUP);
  const gVault = pda("anqa_vault", GROUP);
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
    if (await already()) return console.log(`  ·  ${label}`);
    await run();
    await sleep(PACE);
    console.log(`  ✓  ${label}`);
  };
  const feedAcct = async (m: Mkt): Promise<PublicKey> => {
    if (m.feedAcct !== "auto") return new PublicKey(m.feedAcct);
    const cands = await resolveFeedCandidates(conn, m.feedHex);
    for (const k of cands) if (await conn.getAccountInfo(k)) return k;
    throw new Error(`no live feed for ${m.sym}`);
  };
  const withFeed = async (m: Mkt, fn: (acct: PublicKey) => Promise<any>) => {
    let last: any;
    for (let round = 0; round < 4; round++) {
      try {
        return await fn(await feedAcct(m));
      } catch (e) {
        last = e;
        await sleep(1200);
      }
    }
    throw last;
  };

  console.log(`\n════ anqa cross-margin hub ${GROUP} ════\n`);

  // One collateral mint for the whole hub.
  let mint: PublicKey;
  const mintFile = `app/.demo-mint-${GROUP}.json`;
  if (fs.existsSync(mintFile)) {
    mint = new PublicKey(JSON.parse(fs.readFileSync(mintFile, "utf-8")).mint);
    console.log(`  ·  collateral mint ${mint.toBase58()}`);
  } else {
    mint = await createMint(conn, payer, payer.publicKey, null, DEC);
    fs.writeFileSync(mintFile, JSON.stringify({ mint: mint.toBase58() }, null, 2));
    console.log(`  ✓  collateral mint ${mint.toBase58()}`);
  }

  const oracleParams = (m: Mkt) => ({
    feedId: Array.from(Buffer.from(m.feedHex, "hex")),
    secondaryFeedId: Array(32).fill(0),
    maxAgeSecs: new BN(24 * 60 * 60),
    maxConfBps: 500,
    maxDeviationBps: 100,
    maxMoveBpsPerInterval: 0,
    freezeSlots: new BN(150),
    emaWeightBps: 2000,
    maxBandBps: 500,
    maxMarkStalenessSlots: new BN(100_000),
  });

  // Markets first — the risk group needs the first market to exist.
  for (const m of MKTS) {
    const market = pda("anqa_market", m.id);
    await step(`market ${m.sym} (${m.id}, asset ${m.asset})`, () => exists(market), () =>
      p.methods
        .initializeMarket(new BN(m.id), new BN(GROUP), m.asset, new BN(m.tick), new BN(m.lotSize), m.baseDecimals, DEC, 0, 0, { pyth: {} }, oracleParams(m))
        .accounts({
          authority: payer.publicKey,
          market,
          book: pda("anqa_book", m.id),
          oracleState: pda("anqa_oracle", m.id),
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  // The asset-slots account outgrew the 10,240-byte CPI allocation limit, so
  // it is created and grown in 10KB steps, one transaction each, until it
  // stops growing (prepare is a no-op at full size).
  if (!(await exists(gRisk))) {
    for (let prev = -1; ; ) {
      await p.methods
        .prepareAssetSlots(new BN(GROUP))
        .accounts({
          authority: payer.publicKey,
          market: pda("anqa_market", GROUP),
          assetSlots: gAssets,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await sleep(PACE);
      const len = (await conn.getAccountInfo(gAssets))?.data.length ?? 0;
      console.log(`  ✓  asset slots sized ${len} bytes`);
      if (len === prev) break;
      prev = len;
    }
  }

  // The shared risk engine: one group, every listed asset.
  await step(`risk engine (${MKTS.length} assets)`, () => exists(gRisk), () =>
    withFeed(MKTS[0], (acct) =>
      p.methods
        .initializeRisk(new BN(GROUP), MKTS.length)
        .accounts({
          authority: payer.publicKey,
          market: pda("anqa_market", GROUP),
          riskGroup: gRisk,
          assetSlots: gAssets,
          priceUpdate: acct,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    )
  );

  // Later assets activate one per transaction — the kernel's cooldown.
  // Once the risk group is delegated, activation already happened and the
  // base layer can no longer touch it.
  for (const m of (await isDelegated(gRisk)) ? [] : MKTS.slice(1)) {
    await step(`asset ${m.asset} (${m.sym}) activated`, async () => {
      const g: any = await p.account.riskGroup.fetch(gRisk).catch(() => null);
      return false; // idempotence handled by the kernel refusing re-activation
    }, () =>
      withFeed(m, (acct) =>
        p.methods
          .activateAsset()
          .accounts({
            authority: payer.publicKey,
            market: pda("anqa_market", m.id),
            riskGroup: gRisk,
            assetSlots: gAssets,
            priceUpdate: acct,
          })
          .rpc()
      ).catch((e: any) => {
        // "LockActive" (the kernel refusing re-activation) surfaces in the
        // program logs, not the Anchor error message.
        const msg = String(e?.message ?? e) + (e?.logs ?? []).join(" ");
        if (!msg.includes("LockActive")) throw e;
        console.log(`  ·  asset ${m.asset} already active`);
      })
    );
  }

  await step("custody vault (shared)", () => exists(gVault), () =>
    p.methods
      .initializeVault(new BN(GROUP))
      .accounts({
        authority: payer.publicKey,
        market: pda("anqa_market", GROUP),
        collateralMint: mint,
        vault: gVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc()
  );

  // Insurance — layer two of the loss waterfall. Without it every bankruptcy
  // that outruns the loser's collateral goes straight to haircutting winners.
  // The vault can be created any time (the market account never delegates),
  // but funding writes the kernel's per-domain accounting, so it must happen
  // while the risk engine is on base — i.e. before delegation, or after
  // `undelegate_risk` brings it home.
  const gInsurance = pda("anqa_insurance", GROUP);
  const INSURANCE_PER_SIDE = 25_000 * 10 ** DEC; // per domain: asset × side
  await step("insurance vault (shared)", () => exists(gInsurance), () =>
    p.methods
      .initializeInsuranceVault(new BN(GROUP))
      .accounts({
        authority: payer.publicKey,
        market: pda("anqa_market", GROUP),
        collateralMint: mint,
        insuranceVault: gInsurance,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc()
  );
  if (!(await isDelegated(gRisk))) {
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
    const wanted = BigInt(INSURANCE_PER_SIDE) * 2n * BigInt(MKTS.length);
    const held = BigInt((await conn.getTokenAccountBalance(funderAta.address)).value.amount);
    if (held < wanted) {
      await mintTo(conn, payer, mint, funderAta.address, payer, wanted - held);
      console.log(`  ✓  minted ${Number(wanted - held) / 10 ** DEC} demo USDC for insurance`);
    }
    // The kernel tracks how much of the vault is insurance; compare its view
    // (vault total minus custody) to decide whether this asset is seeded.
    const insuranceHeld = async () =>
      BigInt((await conn.getTokenAccountBalance(gInsurance)).value.amount);
    const already = await insuranceHeld();
    const target = BigInt(INSURANCE_PER_SIDE) * 2n;
    for (const m of MKTS) {
      await step(`insurance ${m.sym} (asset ${m.asset}, $${(INSURANCE_PER_SIDE / 10 ** DEC).toLocaleString()}/side)`, async () =>
        already >= target * BigInt(m.asset + 1), () =>
        p.methods
          .fundInsurance(m.asset, new BN(INSURANCE_PER_SIDE), new BN(INSURANCE_PER_SIDE))
          .accounts({
            funder: payer.publicKey,
            market: pda("anqa_market", GROUP),
            riskGroup: gRisk,
            assetSlots: gAssets,
            funderTokenAccount: funderAta.address,
            insuranceVault: gInsurance,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc()
      );
    }
  } else {
    console.log("  ·  risk engine delegated — fund insurance via undelegate_risk first");
  }

  for (const m of MKTS) {
    const market = pda("anqa_market", m.id);
    const book = pda("anqa_book", m.id);
    await step(`tape ${m.sym}`, () => exists(pda("anqa_tape", m.id)), () =>
      p.methods
        .initializeTape(new BN(m.id))
        .accounts({ authority: payer.publicKey, market, tape: pda("anqa_tape", m.id), systemProgram: SystemProgram.programId })
        .rpc()
    );
    await step(`oracle relay ${m.sym}`, () => isDelegated(pda("anqa_int_oracle", m.id)), () =>
      withFeed(m, (acct) =>
        p.methods
          .syncInternalOracle()
          .accounts({ keeper: payer.publicKey, market, internalOracle: pda("anqa_int_oracle", m.id), priceUpdate: acct, systemProgram: SystemProgram.programId })
          .rpc()
      )
    );
    await step(`dark ${m.sym}`, async () => (await p.account.market.fetch(market)).dark === true, () =>
      p.methods.setDark(true).accounts({ authority: payer.publicKey, market, book }).rpc()
    );
    await step(`book permission ${m.sym}`, () => exists(permissionOf(book)), () =>
      p.methods
        .createBookPermission(new BN(m.id), [{ pubkey: payer.publicKey, flags: 31 }])
        .accounts({ authority: payer.publicKey, market, book, permission: permissionOf(book), permissionProgram: ACL, systemProgram: SystemProgram.programId })
        .rpc()
    );
  }

  // Delegations: per-market accounts each; the shared risk set once.
  const del = async (label: string, method: string, id: number, target: PublicKey, field: string) => {
    const d = delegationOf(target);
    const cap = field[0].toUpperCase() + field.slice(1);
    await step(`${label} delegated`, () => isDelegated(target), () =>
      p.methods[method](new BN(id))
        .accounts({
          payer: payer.publicKey,
          [field]: target,
          [`buffer${cap}`]: d.buffer,
          [`delegationRecord${cap}`]: d.delegationRecord,
          [`delegationMetadata${cap}`]: d.delegationMetadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DLP,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  };
  for (const m of MKTS) {
    await del(`book ${m.sym}`, "delegateBook", m.id, pda("anqa_book", m.id), "book");
    await del(`oracle ${m.sym}`, "delegateInternalOracle", m.id, pda("anqa_int_oracle", m.id), "internalOracle");
    await del(`oracle state ${m.sym}`, "delegateOracleState", m.id, pda("anqa_oracle", m.id), "oracleState");
    await del(`tape ${m.sym}`, "delegateTape", m.id, pda("anqa_tape", m.id), "tape");
  }
  await del("risk group", "delegateRiskGroup", GROUP, gRisk, "riskGroup");

  // The slabs outgrew the 10,240-byte CPI allocation limit, so their
  // delegation buffer is pre-grown in 10KB steps (no-op once full-size, and
  // skipped entirely once the slabs are already delegated).
  if (!(await isDelegated(gAssets))) {
    const bufAssets = delegationOf(gAssets).buffer;
    for (let prev = -1; ; ) {
      await p.methods
        .prepareAssetSlotsBuffer(new BN(GROUP))
        .accounts({
          payer: payer.publicKey,
          assetSlots: gAssets,
          bufferAssetSlots: bufAssets,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await sleep(PACE);
      const len = (await conn.getAccountInfo(bufAssets))?.data.length ?? 0;
      console.log(`  ✓  slab buffer sized ${len} bytes`);
      if (len === prev) break;
      prev = len;
    }
  }
  await del("asset slots", "delegateAssetSlots", GROUP, gAssets, "assetSlots");

  // Inside the rollup: relay each feed, re-anchor each asset at its own
  // live mark (they were all activated at BTC's), then crank once.
  for (const m of MKTS) {
    const market = pda("anqa_market", m.id);
    await withFeed(m, (acct) =>
      pEr.methods
        .syncInternalOracle()
        .accounts({ keeper: payer.publicKey, market, internalOracle: pda("anqa_int_oracle", m.id), priceUpdate: acct, systemProgram: SystemProgram.programId })
        .rpc()
    ).catch((e: any) => console.log(`  ·  er relay ${m.sym}:`, String(e?.message ?? e).slice(0, 70)));
    await sleep(PACE);
    await pEr.methods
      .reanchorOracle(m.asset)
      .accounts({
        cranker: payer.publicKey,
        market,
        riskGroup: gRisk,
        assetSlots: gAssets,
        oracleState: pda("anqa_oracle", m.id),
        internalOracle: pda("anqa_int_oracle", m.id),
      })
      .rpc()
      .then(() => console.log(`  ✓  ${m.sym} re-anchored (asset ${m.asset})`))
      .catch((e: any) => console.log(`  ·  reanchor ${m.sym}:`, String(e?.message ?? e).slice(0, 70)));
    await sleep(PACE);
    await pEr.methods
      .crank(m.asset, new BN(0))
      .accounts({
        cranker: payer.publicKey,
        market,
        riskGroup: gRisk,
        assetSlots: gAssets,
        oracleState: pda("anqa_oracle", m.id),
        internalOracle: pda("anqa_int_oracle", m.id),
      })
      .rpc()
      .catch((e: any) => console.log(`  ·  crank ${m.sym}:`, String(e?.message ?? e).slice(0, 70)));
    await sleep(PACE);
    const os1: any = await pEr.account.oracleState.fetch(pda("anqa_oracle", m.id)).catch(() => null);
    if (os1) console.log(`  ·  ${m.sym} mark $${(Number(os1.lastPrice) / 1e6).toLocaleString()}/lot`);
  }

  await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  console.log(`\n─── hub ${GROUP} ready ───`);
  console.log(`NEXT_PUBLIC_COLLATERAL_MINT=${mint.toBase58()}`);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
