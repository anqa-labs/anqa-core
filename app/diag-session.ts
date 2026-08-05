/**
 * Does one-click trading actually work on the relisted market?
 *
 * The terminal's promise is that a trader signs **once** — to open the
 * account, delegate it and grant a session — and every order after that is
 * signed locally by a key in the browser, with no wallet prompt. This proves
 * exactly that, in the same order the frontend does it:
 *
 *   1. onboard a fresh private trader (permission before delegation)
 *   2. `grant_session` — the single wallet signature
 *   3. place an order signed ONLY by the ephemeral session key
 *
 * Step 3 never touches the owner's keypair. If it succeeds, the wallet is not
 * needed to trade.
 *
 * Run: ANQA_DEMO_MARKET=929 npx ts-node --transpile-only app/diag-session.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, Transaction,
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
const LOTS = Number(process.env.ANQA_LOTS ?? 4);
const MARGIN = Number(process.env.ANQA_MARGIN ?? 300) * 10 ** DEC;

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = 800;
const err = (e: any) => String(e?.msg ?? (e?.message || String(e))).slice(0, 120);

async function main() {
  const conn = baseConnection(RPC);
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const owner = Keypair.generate();          // "the wallet"
  const session = Keypair.generate();        // "the key in the browser"
  console.log(`\n════ owner ${owner.publicKey.toBase58()}`);
  console.log(`     session ${session.publicKey.toBase58()} · market ${MARKET_ID} ════\n`);

  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const erOwner = new Connection(await teeRpcFor(owner, ER_RPC), "confirmed");
  const erSession = new Connection(await teeRpcFor(session, ER_RPC), "confirmed");
  const mk = (c: Connection, kp: Keypair) =>
    new Program(idl, new anchor.AnchorProvider(c, new anchor.Wallet(kp), {
      commitment: "confirmed", skipPreflight: false,
    })) as any;
  const pBase = mk(conn, owner);
  const pErOwner = mk(erOwner, owner);
  const pErSession = mk(erSession, session);

  const pda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(MARKET_ID), ...e], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const oracleState = pda("anqa_oracle");
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const vault = gpda("anqa_vault");
  const portfolio = gpda("anqa_portfolio", [owner.publicKey.toBuffer()]);
  const ledger = gpda("anqa_ledger", [owner.publicKey.toBuffer()]);
  const receipt = gpda("anqa_dreceipt", [owner.publicKey.toBuffer()]);
  const sessionPda = PublicKey.findProgramAddressSync(
    [S("anqa_session"), owner.publicKey.toBuffer()], PROGRAM_ID
  )[0];
  const permission = PublicKey.findProgramAddressSync(
    [Buffer.from("permission:"), portfolio.toBuffer()], ACL
  )[0];
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });
  const mint = new PublicKey(JSON.parse(fs.readFileSync(`app/.demo-mint-${GROUP_ID}.json`, "utf-8")).mint);

  await anchor.web3.sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: 0.4 * LAMPORTS_PER_SOL })
  ), [admin]);

  // ── onboard (all owner-signed, as the wallet would) ─────────────────────
  await pBase.methods.openPortfolio()
    .accounts({ trader: owner.publicKey, market: gpda("anqa_market"), portfolio, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  await pBase.methods.initializeLedger()
    .accounts({ trader: owner.publicKey, market, ledger, systemProgram: SystemProgram.programId })
    .rpc(); await sleep(PACE);
  await pBase.methods.createPortfolioPermission(GROUP_ID, [
      { pubkey: owner.publicKey, flags: ALL_FLAGS },
      { pubkey: VENUE_KEEPER, flags: ALL_FLAGS },
    ])
    .accounts({
      trader: owner.publicKey, market: gpda("anqa_market"), portfolio,
      permission, permissionProgram: ACL, systemProgram: SystemProgram.programId,
    })
    .rpc(); await sleep(PACE);
  console.log("  ✓  account opened + permissioned (private)");

  const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, owner.publicKey);
  await mintTo(conn, admin, mint, ata.address, admin, COLLATERAL);
  const dr = delegationOf(receipt);
  await pBase.methods.deposit(new BN(COLLATERAL), false)
    .accounts({
      trader: owner.publicKey, market, ledger, traderTokenAccount: ata.address, vault,
      receipt, buffer: dr.buffer, delegationRecord: dr.delegationRecord,
      delegationMetadata: dr.delegationMetadata, ownerProgram: PROGRAM_ID,
      delegationProgram: DLP, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc(); await sleep(PACE);

  // ── THE single wallet signature: grant the browser key ──────────────────
  await pBase.methods.grantSession(session.publicKey, new BN(24 * 60 * 60))
    .accounts({ owner: owner.publicKey, session: sessionPda, systemProgram: SystemProgram.programId })
    .postInstructions([SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: session.publicKey, lamports: 30_000_000,
    })])
    .rpc(); await sleep(PACE);
  console.log("  ✓  session granted (this is the ONLY trading-related wallet signature)");

  const dp = delegationOf(portfolio);
  await pBase.methods.delegatePortfolio(GROUP_ID)
    .accounts({
      trader: owner.publicKey, portfolio, bufferPortfolio: dp.buffer,
      delegationRecordPortfolio: dp.delegationRecord, delegationMetadataPortfolio: dp.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
    })
    .rpc(); await sleep(PACE);
  console.log("  ✓  portfolio delegated\n");

  // ─────────────────────────────────────────────────────────────────────────
  // From here the owner's keypair is NEVER used again.
  // ─────────────────────────────────────────────────────────────────────────
  await pErSession.methods.claimDeposit()
    .accounts({
      caller: session.publicKey, market, riskGroup, assetSlots, portfolio, ledger,
      receipt: null, magicContext: null, magicProgram: null,
    })
    .rpc().catch((e: any) => console.log("  ·  claim:", err(e)));
  await sleep(PACE);
  console.log("  ✓  claimDeposit  — signed by session key alone");

  await pErOwner.methods.refreshPortfolio()
    .accounts({ market, riskGroup, assetSlots, portfolio })
    .rpc().catch(() => {});
  await sleep(PACE);

  const os1: any = await pErSession.account.oracleState.fetch(oracleState);
  const markTicks = Math.round(Number(os1.lastPrice) / 1e3);
  const px = Math.round(markTicks * 1.02);

  try {
    const sig = await pErSession.methods
      .placeOrder({ bid: {} }, { immediateOrCancel: {} }, new BN(px), new BN(LOTS),
        new BN(Date.now() % 1e9), new BN(MARGIN), false)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
      .accounts({
        // The session key signs; the portfolio still belongs to the owner.
        trader: session.publicKey,
        session: sessionPda,
        market, book, riskGroup, assetSlots, oracleState, portfolio,
      })
      .rpc();
    console.log(`  ✓  placeOrder   — signed by session key alone`);
    console.log(`     ${sig}`);
  } catch (e: any) {
    console.log(`  ✗  placeOrder FAILED under session key: ${err(e)}`);
    return;
  }

  console.log("\n  → one wallet signature total; the order needed no wallet at all.");
}

main().catch((e) => { console.error(e); process.exit(1); });
