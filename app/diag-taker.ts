/**
 * End-to-end proof for the relisted BTC market — and for hidden positions.
 *
 * Onboards a brand-new trader along exactly the path the terminal uses,
 * including the ordering that matters: the portfolio permission is created on
 * base **before** `delegate_portfolio`, so the account is private to everyone
 * but its owner and the venue keeper, and still able to trade. Then it takes
 * liquidity with an IOC order priced through the mark, and waits for the
 * keeper to settle the fill it cannot settle itself — a taker on a dark market
 * never learns who it traded with.
 *
 * Run: ANQA_DEMO_MARKET=929 npx ts-node --transpile-only app/diag-taker.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { teeRpcFor } from "./tee-auth";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const VENUE_KEEPER = new PublicKey("A1iQJhg25EPc8VwXXngJ58GwVJAsCzsMnt2ybSu93yvD");
const ALL_FLAGS = 31;
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 929);
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);
const DEC = 6;
const COLLATERAL = 100_000 * 10 ** DEC;
const LOTS = Number(process.env.ANQA_LOTS ?? 5);
/** Quote atoms standing behind the position — isolated margin. */
const MARGIN = Number(process.env.ANQA_MARGIN ?? 300) * 10 ** DEC;
/** Fresh identity per run unless told otherwise, to test first-signature privacy. */
const REUSE = process.env.ANQA_REUSE === "1";

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = 800;
const err = (e: any) => String(e?.msg ?? (e?.message || String(e))).slice(0, 110);

async function main() {
  const conn = baseConnection(RPC);
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );

  const takerFile = `app/.diag-taker-${MARKET_ID}.json`;
  let taker: Keypair;
  if (REUSE && fs.existsSync(takerFile)) {
    taker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(takerFile, "utf-8"))));
  } else {
    taker = Keypair.generate();
    fs.writeFileSync(takerFile, JSON.stringify(Array.from(taker.secretKey)));
  }
  console.log(`\n════ taker ${taker.publicKey.toBase58()} on market ${MARKET_ID} ════\n`);

  const er = new Connection(await teeRpcFor(taker, ER_RPC), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mkProg = (c: Connection, kp: Keypair) =>
    new Program(idl, new anchor.AnchorProvider(c, new anchor.Wallet(kp), {
      commitment: "confirmed", skipPreflight: false,
    })) as any;
  const pBase = mkProg(conn, taker);
  const pEr = mkProg(er, taker);

  const pda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(MARKET_ID), ...e], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const oracleState = pda("anqa_oracle");
  const tape = pda("anqa_tape");
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const vault = gpda("anqa_vault");
  const portfolio = gpda("anqa_portfolio", [taker.publicKey.toBuffer()]);
  const ledger = gpda("anqa_ledger", [taker.publicKey.toBuffer()]);
  const receipt = gpda("anqa_dreceipt", [taker.publicKey.toBuffer()]);
  const permission = PublicKey.findProgramAddressSync(
    [Buffer.from("permission:"), portfolio.toBuffer()], ACL
  )[0];
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });
  const mint = new PublicKey(JSON.parse(fs.readFileSync(`app/.demo-mint-${GROUP_ID}.json`, "utf-8")).mint);

  // ── fund ────────────────────────────────────────────────────────────────
  await anchor.web3.sendAndConfirmTransaction(
    conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: taker.publicKey, lamports: 0.25 * LAMPORTS_PER_SOL,
    })),
    [admin]
  );
  console.log("  ✓  funded with SOL");

  // The HUB market: `open_portfolio` stamps `portfolio.market_id` from the
  // market it is given, and `place_order` demands that tag equal `group_id`.
  await pBase.methods.openPortfolio()
    .accounts({ trader: taker.publicKey, market: gpda("anqa_market"), portfolio, systemProgram: SystemProgram.programId })
    .rpc();
  await sleep(PACE);
  await pBase.methods.initializeLedger()
    .accounts({ trader: taker.publicKey, market, ledger, systemProgram: SystemProgram.programId })
    .rpc();
  await sleep(PACE);
  console.log("  ✓  portfolio + ledger");

  // ── privacy, BEFORE delegation ──────────────────────────────────────────
  // This is the whole ordering rule. Created here, the permission rides into
  // the rollup with the account and leaves it readable only to the owner and
  // the keeper — while staying writable. Created after delegation, the same
  // record bricks the account at TEE ingress, permanently.
  await pBase.methods
    .createPortfolioPermission(GROUP_ID, [
      { pubkey: taker.publicKey, flags: ALL_FLAGS },
      { pubkey: VENUE_KEEPER, flags: ALL_FLAGS },
    ])
    .accounts({
      trader: taker.publicKey, market: gpda("anqa_market"), portfolio,
      permission, permissionProgram: ACL, systemProgram: SystemProgram.programId,
    })
    .rpc();
  await sleep(PACE);
  console.log("  ✓  portfolio permissioned (private) — before delegation");

  // ── collateral ──────────────────────────────────────────────────────────
  const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, taker.publicKey);
  await mintTo(conn, admin, mint, ata.address, admin, COLLATERAL);
  const dr = delegationOf(receipt);
  await pBase.methods.deposit(new BN(COLLATERAL), false)
    .accounts({
      trader: taker.publicKey, market, ledger,
      traderTokenAccount: ata.address, vault,
      receipt, buffer: dr.buffer,
      delegationRecord: dr.delegationRecord, delegationMetadata: dr.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  await sleep(PACE);
  console.log(`  ✓  deposited ${(COLLATERAL / 1e6).toLocaleString()} USDC`);

  const dp = delegationOf(portfolio);
  await pBase.methods.delegatePortfolio(GROUP_ID)
    .accounts({
      trader: taker.publicKey, portfolio,
      bufferPortfolio: dp.buffer, delegationRecordPortfolio: dp.delegationRecord,
      delegationMetadataPortfolio: dp.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
    })
    .rpc();
  await sleep(PACE);
  console.log("  ✓  portfolio delegated");

  await pEr.methods.claimDeposit()
    .accounts({
      caller: taker.publicKey, market, riskGroup, assetSlots, portfolio, ledger,
      receipt: null, magicContext: null, magicProgram: null,
    })
    .rpc().catch((e: any) => console.log("  ·  claim:", err(e)));
  await sleep(PACE);
  await pEr.methods.refreshPortfolio()
    .accounts({ market, riskGroup, assetSlots, portfolio })
    .rpc().catch((e: any) => console.log("  ·  refresh:", err(e)));
  await sleep(PACE);

  // ── take ────────────────────────────────────────────────────────────────
  const os1: any = await pEr.account.oracleState.fetch(oracleState);
  const markTicks = Math.round(Number(os1.lastPrice) / 1e3);
  const px = Math.round(markTicks * 1.02); // 2% through the mark, as the UI's market order does
  console.log(`\n  ·  mark ${markTicks} ticks — IOC bid ${LOTS} lots up to ${px}`);

  try {
    const sig = await pEr.methods
      .placeOrder({ bid: {} }, { immediateOrCancel: {} }, new BN(px), new BN(LOTS),
        new BN(Date.now() % 1e9), new BN(MARGIN), false)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
      .accounts({
        trader: taker.publicKey, session: null, market, book,
        riskGroup, assetSlots, oracleState, portfolio,
      })
      .rpc();
    console.log(`  ✓  order accepted — ${sig}`);
  } catch (e: any) {
    console.log(`  ✗  placeOrder FAILED: ${err(e)}`);
    return;
  }

  // ── wait for the engine to settle it ────────────────────────────────────
  console.log("\n  ·  waiting for the keeper to settle…");
  const pKeeperEr = mkProg(er, taker);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const bk: any = await pKeeperEr.account.book.fetch(book).catch(() => null);
    const tp: any = await pKeeperEr.account.fillTape.fetch(tape).catch(() => null);
    const pend = bk ? Number(bk.pending_count ?? bk.pendingCount) : -1;
    const fills = bk ? Number(bk.fill_count ?? bk.fillCount) : -1;
    const prints = tp ? Number(tp.count ?? tp.len ?? 0) : -1;
    console.log(`     t+${(i + 1) * 3}s  pending=${pend} fills=${fills} tape=${prints}`);
    if (pend === 0 && fills > 0) {
      console.log("\n  ✓  settled — the fill cleared the queue");
      break;
    }
  }

  // ── did a position actually open? ───────────────────────────────────────
  const acc = await er.getAccountInfo(portfolio);
  if (acc) {
    const capital = acc.data.readBigUInt64LE(73 + 132);
    console.log(`\n  ·  portfolio capital field: ${Number(capital) / 1e6}`);
  }
  const anon = new Connection(ER_RPC.split("?")[0], "confirmed");
  const seen = await anon.getAccountInfo(portfolio).catch(() => null);
  console.log(`  ·  anonymous read of this portfolio: ${seen ? "VISIBLE (not private!)" : "null — private ✓"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
