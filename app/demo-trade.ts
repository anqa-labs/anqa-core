/**
 * Cross the demo book once, as a visitor would, and settle it.
 *
 * Exists to give the tape a heartbeat: a terminal whose public record is
 * empty cannot show what a public record is for. Also the smallest possible
 * proof of the dark path end to end — a taker who names no counterparty, an
 * engine that settles it, a print nobody can trace back.
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
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_DEMO_MARKET ?? 777);
const DEC = 6;
const COLLATERAL = 500_000 * 10 ** DEC;
const LOTS = Number(process.env.ANQA_LOTS ?? 3);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = 700;

async function main() {
  const conn = baseConnection(RPC);
  const er = new Connection(ER_RPC, "confirmed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );

  const takerFile = `app/.demo-taker-${MARKET_ID}.json`;
  let taker: Keypair;
  if (fs.existsSync(takerFile)) {
    taker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(takerFile, "utf-8"))));
  } else {
    taker = Keypair.generate();
    fs.writeFileSync(takerFile, JSON.stringify(Array.from(taker.secretKey)));
  }

  const mint = new PublicKey(
    JSON.parse(fs.readFileSync(`app/.demo-mint-${MARKET_ID}.json`, "utf-8")).mint
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mk = (c: Connection, kp: Keypair) =>
    new Program(idl, new anchor.AnchorProvider(c, new anchor.Wallet(kp), {
      commitment: "confirmed",
      skipPreflight: false,
    })) as any;
  const pBase = mk(conn, taker);
  const pEr = mk(er, taker);
  const pAdminEr = mk(er, admin);

  const pda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(MARKET_ID), ...e], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const vault = pda("anqa_vault");
  const tape = pda("anqa_tape");
  const portfolio = pda("anqa_portfolio", [taker.publicKey.toBuffer()]);
  const ledger = pda("anqa_ledger", [taker.publicKey.toBuffer()]);
  const receipt = pda("anqa_dreceipt", [taker.publicKey.toBuffer()]);
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });

  console.log(`\n════ demo taker ${taker.publicKey.toBase58().slice(0, 8)}… ════\n`);

  if ((await conn.getBalance(taker.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
    await anchor.web3.sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: taker.publicKey,
          lamports: 0.2 * LAMPORTS_PER_SOL,
        })
      ),
      [admin]
    );
  }
  if (!(await conn.getAccountInfo(portfolio))) {
    await pBase.methods.openPortfolio()
      .accounts({ trader: taker.publicKey, market, portfolio, systemProgram: SystemProgram.programId })
      .rpc(); await sleep(PACE);
    await pBase.methods.initializeLedger()
      .accounts({ trader: taker.publicKey, market, ledger, systemProgram: SystemProgram.programId })
      .rpc(); await sleep(PACE);
    const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, taker.publicKey);
    await mintTo(conn, admin, mint, ata.address, admin, COLLATERAL);
    const d = delegationOf(receipt);
    await pBase.methods.deposit(new BN(COLLATERAL), false)
      .accounts({
        trader: taker.publicKey, market, ledger,
        traderTokenAccount: ata.address, vault,
        receipt, buffer: d.buffer,
        delegationRecord: d.delegationRecord, delegationMetadata: d.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc(); await sleep(PACE);
    const dp = delegationOf(portfolio);
    await pBase.methods.delegatePortfolio(MARKET_ID)
      .accounts({
        trader: taker.publicKey, portfolio,
        bufferPortfolio: dp.buffer, delegationRecordPortfolio: dp.delegationRecord,
        delegationMetadataPortfolio: dp.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
      })
      .rpc(); await sleep(PACE);
    console.log("  ✓  taker onboarded");
  }
  await pEr.methods.claimDeposit()
    .accounts({
      caller: taker.publicKey, market, riskGroup, assetSlots, portfolio, ledger,
      receipt: null, magicContext: null, magicProgram: null,
    })
    .rpc().catch(() => {});
  await sleep(PACE);

  // Cross the best ask, naming nobody — the dark path.
  const bk0: any = await pEr.account.book.fetch(book);
  const bestAsk = bk0.asks.orders[bk0.asks.head];
  if (!bestAsk || bk0.asks.head === 65535) {
    console.log("  ·  no asks resting; run app/demo-maker.ts first\n");
    return;
  }
  const price = Number(bestAsk.priceInTicks);
  await pEr.methods
    .placeOrder({ bid: {} }, { limit: {} }, new BN(price), new BN(LOTS), new BN(Date.now() % 1e9))
    .accounts({ trader: taker.publicKey, market, book, riskGroup, assetSlots, oracleState, portfolio })
    .rpc();
  await sleep(PACE);
  const bk1: any = await pEr.account.book.fetch(book);
  console.log(`  ✓  crossed ${LOTS}@${price} — ${bk1.pendingCount} fill(s) queued, no counterparty named`);

  // The engine settles what the book matched.
  for (let i = 0; i < 6; i++) {
    const bk: any = await pEr.account.book.fetch(book);
    if (Number(bk.pendingCount) === 0) break;
    const head = bk.pending[bk.pendingHead];
    await pAdminEr.methods.settleFill()
      .accounts({
        caller: admin.publicKey, market, book, riskGroup, assetSlots, oracleState,
        takerPortfolio: pda("anqa_portfolio", [new PublicKey(head.taker).toBuffer()]),
        makerPortfolio: pda("anqa_portfolio", [new PublicKey(head.maker).toBuffer()]),
        tape,
      })
      .rpc();
    await sleep(PACE);
  }
  const tp: any = await pEr.account.fillTape.fetch(tape);
  const last = tp.entries[(Number(tp.count) - 1) % tp.entries.length];
  console.log(`  ✓  settled — tape print #${tp.count}: ${last.baseLots}@${last.priceInTicks}\n`);
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
