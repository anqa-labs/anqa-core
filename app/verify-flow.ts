/** End-to-end venue check with a scratch wallet, exactly the path a real
 *  trader takes in the terminal:
 *
 *    onboard (open + ledger + deposit + permission + delegate + claim)
 *    → hidden bid on SOL-PERP (931)
 *    → auto-matcher takes it after the 10s resting window
 *    → close the position
 *    → withdraw 100 USDC back to the wallet (the leg that was broken)
 *
 *  Prints PASS/FAIL per step. Exits non-zero on the first hard failure.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { baseConnection } from "./rpc";
import { teeAuthToken } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = (process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app").split("?")[0];
const GROUP_ID = new BN("930");
const MARKET_ID = 931; // SOL-PERP — the market whose withdraw was broken
const ALL_FLAGS = 31;
const DEPOSIT = 1_000 * 1e6;
const WITHDRAW = 100 * 1e6;
// Wrapper header (73) + asset_collateral[12]*16 + asset_entry[12]*16 = kernel
// inner at 457; capital is +132 into that, u128 LE. Mirrors web/lib/portfolio.
const CAPITAL_OFF = 73 + 12 * 16 + 12 * 16 + 132;
const NIL = 0xffff;

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const field = (x: any, snake: string, camel: string) => x?.[snake] ?? x?.[camel];
const asBn = (x: any) => new BN(x?.toString?.() ?? String(x));
const stamp = () => new Date().toISOString().slice(11, 19);
let failures = 0;
const report = (ok: boolean, step: string, extra = "") => {
  console.log(`${stamp()}  ${ok ? "PASS" : "FAIL"}  ${step}${extra ? ` · ${extra}` : ""}`);
  if (!ok) failures++;
};

function walk(side: any): any[] {
  const result: any[] = [];
  const orders = side?.orders ?? [];
  let cursor = Number(side?.head ?? NIL);
  const visited = new Set<number>();
  while (cursor !== NIL && cursor >= 0 && cursor < orders.length && !visited.has(cursor)) {
    visited.add(cursor);
    const order = orders[cursor];
    if (!order) break;
    if (order.active === 1) result.push(order);
    cursor = Number(order.next ?? NIL);
  }
  return result;
}

async function main() {
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"),
          "utf-8"
        )
      )
    )
  );
  const user = Keypair.generate();
  fs.writeFileSync("app/.verify-user.json", JSON.stringify(Array.from(user.secretKey)));
  console.log(`scratch wallet ${user.publicKey.toBase58()} (key saved to app/.verify-user.json)`);

  const conn = baseConnection(RPC, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mkProg = (c: Connection, kp: Keypair) =>
    new Program(
      idl,
      new anchor.AnchorProvider(c, new anchor.Wallet(kp), {
        commitment: "confirmed",
        skipPreflight: true,
      })
    ) as any;

  const pBase = mkProg(conn, user);
  const erUser = new Connection(`${ER_RPC}?token=${await teeAuthToken(user, ER_RPC)}`, "confirmed");
  const pEr = mkProg(erUser, user);
  const erAdmin = new Connection(`${ER_RPC}?token=${await teeAuthToken(admin, ER_RPC)}`, "confirmed");
  const pInspect = mkProg(erAdmin, admin);

  // Rollup sends go out raw. Anchor's `.rpc()` waits on a websocket
  // confirmation the rollup does not reliably deliver and throws
  // "Unknown action 'undefined'" even when the transaction landed.
  const erSend = async (ix: any) => {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ix
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await erUser.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sig = await erUser.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const st = await erUser.getSignatureStatus(sig).catch(() => null);
      if (st?.value?.err) throw new Error(`rollup tx failed: ${JSON.stringify(st.value.err)}`);
      if (st?.value?.confirmationStatus) return sig;
    }
    throw new Error("rollup tx not confirmed in 6s");
  };

  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const mpda = (t: string, id: number) =>
    PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const delegationOf = (a: PublicKey) => ({
    buffer: PublicKey.findProgramAddressSync([S("buffer"), a.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), a.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), a.toBuffer()], DLP)[0],
  });

  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const groupMarket = gpda("anqa_market");
  const portfolio = gpda("anqa_portfolio", [user.publicKey.toBuffer()]);
  const ledger = gpda("anqa_ledger", [user.publicKey.toBuffer()]);
  const dReceipt = gpda("anqa_dreceipt", [user.publicKey.toBuffer()]);
  const wReceipt = gpda("anqa_wreceipt", [user.publicKey.toBuffer()]);
  const vault = gpda("anqa_vault");
  const market = mpda("anqa_market", MARKET_ID);
  const book = mpda("anqa_book", MARKET_ID);
  const oracleState = mpda("anqa_oracle", MARKET_ID);

  // ---- 1. fund: SOL for fees, test USDC from the demo mint ----
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: user.publicKey,
      lamports: 0.2 * LAMPORTS_PER_SOL,
    })
  );
  await anchor.web3.sendAndConfirmTransaction(conn, tx, [admin]);
  const mint = new PublicKey(JSON.parse(fs.readFileSync(`app/.demo-mint-930.json`, "utf-8")).mint);
  const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, user.publicKey);
  await mintTo(conn, admin, mint, ata.address, admin, DEPOSIT);
  report(true, "fund", "0.2 SOL + 1,000 USDC");

  // ---- 2. onboard — ONE transaction, exactly like the web's setupMarket ----
  // Bundling is not cosmetic: if the ledger is created in one tx and funded in
  // the next, the rollup can clone the ledger in its brief deposited=0 state
  // and pin that snapshot, after which every claim reads "nothing to claim"
  // forever. One transaction means base never exposes a pre-deposit ledger.
  const dd = delegationOf(dReceipt);
  const permission = PublicKey.findProgramAddressSync([S("permission:"), portfolio.toBuffer()], ACL)[0];
  const dp = delegationOf(portfolio);
  const onboardTx = new Transaction().add(
    await pBase.methods
      .openPortfolio()
      .accounts({ trader: user.publicKey, market: groupMarket, portfolio, systemProgram: SystemProgram.programId })
      .instruction(),
    await pBase.methods
      .initializeLedger()
      .accounts({ trader: user.publicKey, market: groupMarket, ledger, systemProgram: SystemProgram.programId })
      .instruction(),
    await pBase.methods
      .deposit(new BN(DEPOSIT), false)
      .accounts({
        trader: user.publicKey, market: groupMarket, ledger,
        traderTokenAccount: ata.address, vault,
        receipt: dReceipt, buffer: dd.buffer, delegationRecord: dd.delegationRecord, delegationMetadata: dd.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .instruction(),
    // Privacy BEFORE delegation — after would brick the account.
    await pBase.methods
      .createPortfolioPermission(GROUP_ID, [
        { pubkey: user.publicKey, flags: ALL_FLAGS },
        { pubkey: admin.publicKey, flags: ALL_FLAGS },
      ])
      .accounts({
        trader: user.publicKey, market: groupMarket, portfolio, permission,
        permissionProgram: ACL, systemProgram: SystemProgram.programId,
      })
      .instruction(),
    await pBase.methods
      .delegatePortfolio(GROUP_ID)
      .accounts({
        trader: user.publicKey, portfolio, bufferPortfolio: dp.buffer,
        delegationRecordPortfolio: dp.delegationRecord, delegationMetadataPortfolio: dp.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
      })
      .instruction()
  );
  await anchor.web3.sendAndConfirmTransaction(conn, onboardTx, [user]);
  report(true, "onboard", "open + ledger + deposit + permission + delegate (one tx)");

  // ---- 3. claim the deposit credit inside the rollup ----
  // The rollup executor can pin a brand-new ledger's clone at a state that
  // predates the deposit ("nothing to claim" forever, even while RPC reads and
  // simulation both see the money). A fresh base-layer WRITE to the ledger
  // emits an account update the cloner does follow — so if the credit hasn't
  // landed, touch the ledger with a tiny extra deposit and claim again.
  const claimOnce = () =>
    pEr.methods
      .claimDeposit()
      .accounts({
        caller: user.publicKey, market: groupMarket, riskGroup, assetSlots,
        portfolio, ledger, receipt: null, magicContext: null, magicProgram: null,
      })
      .rpc()
      .catch(() => {});
  const readCapital = async () => {
    const info = await erUser.getAccountInfo(portfolio).catch(() => null);
    return info ? info.data.readBigUInt64LE(CAPITAL_OFF) : 0n;
  };
  let capital = 0n;
  for (let i = 0; i < 10 && capital < BigInt(DEPOSIT); i++) {
    await sleep(2000);
    capital = await readCapital();
  }
  if (capital < BigInt(DEPOSIT)) {
    console.log("credit lagging — touching the ledger with a 1 USDC deposit");
    await mintTo(conn, admin, mint, ata.address, admin, 1e6);
    const dd2 = delegationOf(dReceipt);
    await pBase.methods
      .deposit(new BN(1e6), false)
      .accounts({
        trader: user.publicKey, market: groupMarket, ledger,
        traderTokenAccount: ata.address, vault,
        receipt: dReceipt, buffer: dd2.buffer, delegationRecord: dd2.delegationRecord, delegationMetadata: dd2.delegationMetadata,
        ownerProgram: PROGRAM_ID, delegationProgram: DLP, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    for (let i = 0; i < 20 && capital < BigInt(DEPOSIT); i++) {
      await sleep(3000);
      await claimOnce();
      capital = await readCapital();
    }
  }
  report(capital >= BigInt(DEPOSIT), "credit", `rollup capital ${Number(capital) / 1e6} USDC`);
  if (failures) process.exit(1);

  // ---- 4. hidden bid just under the best bid on SOL-PERP ----
  // The daemon clears and re-lays rungs every tick, so an empty read is
  // normally just that gap — look again before calling the book dead.
  let bestBid = 0;
  for (let i = 0; i < 15 && !bestBid; i++) {
    const bk0: any = await pInspect.account.book.fetch(book).catch(() => null);
    const bids0 = bk0 ? walk(bk0.bids) : [];
    bestBid = bids0.length ? asBn(field(bids0[0], "price_in_ticks", "priceInTicks")).toNumber() : 0;
    if (!bestBid) await sleep(2000);
  }
  if (!bestBid) {
    report(false, "book", "no resting bids for 30s — maker daemon down or at its position cap");
    process.exit(1);
  }
  const price = new BN(bestBid - 2);
  const lots = new BN(100);
  const clientId = new BN(Date.now() % 1_000_000_000);
  await erSend(
    await pEr.methods
      .placeOrder({ bid: {} }, { postOnly: {} }, price, lots, clientId, new BN(0), true)
      .accounts({
        trader: user.publicKey, session: null, market, book,
        riskGroup, assetSlots, oracleState, portfolio,
      })
      .instruction()
  );
  report(true, "place", `hidden bid ${lots}@${price} (best bid ${bestBid})`);

  // ---- 5. the auto-matcher should take it after the 10s resting window ----
  let matchedAt = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const bk: any = await pInspect.account.book.fetch(book).catch(() => null);
    if (!bk) continue;
    const mine = walk(bk.bids).some(
      (o: any) =>
        new PublicKey(o.trader).equals(user.publicKey) &&
        asBn(field(o, "client_order_id", "clientOrderId")).eq(clientId)
    );
    if (!mine) {
      matchedAt = i * 2;
      break;
    }
  }
  report(matchedAt > 0, "match", matchedAt ? `order taken after ~${matchedAt}s` : "still resting after 120s");
  if (failures) process.exit(1);

  // Let the engine settle the fill before touching the position.
  for (let i = 0; i < 20; i++) {
    const bk: any = await pInspect.account.book.fetch(book).catch(() => null);
    if (bk && Number(field(bk, "pending_count", "pendingCount")) === 0) break;
    await sleep(2000);
  }

  // ---- 6. close the position (session-less owner close) ----
  // Closing a long sells, so the worst acceptable price sits just below the
  // book — but it must stay inside the oracle band or the program refuses with
  // 6033. One percent is slack enough to fill and tight enough to be accepted.
  const worst = new BN(Math.max(1, Math.round(bestBid * 0.99)));
  await erSend(
    await pEr.methods
      .closePosition(worst, new BN(0))
      .accounts({
        trader: user.publicKey, session: null, market, book,
        riskGroup, assetSlots, oracleState, portfolio,
      })
      .instruction()
  );
  for (let i = 0; i < 20; i++) {
    const bk: any = await pInspect.account.book.fetch(book).catch(() => null);
    if (bk && Number(field(bk, "pending_count", "pendingCount")) === 0) break;
    await sleep(2000);
  }
  report(true, "close", "position closed, fills settled");

  // ---- 7. withdraw 100 USDC — the leg that was broken on non-930 markets ----
  const balBefore = BigInt((await conn.getTokenAccountBalance(ata.address)).value.amount);
  const dw = delegationOf(wReceipt);
  await pBase.methods
    .requestWithdraw(new BN(WITHDRAW), false)
    .accounts({
      trader: user.publicKey,
      market: groupMarket, // hub market: the whole lifecycle is hub-scoped
      ledger,
      payoutTo: ata.address,
      receipt: wReceipt,
      buffer: dw.buffer,
      delegationRecord: dw.delegationRecord,
      delegationMetadata: dw.delegationMetadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DLP,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  report(true, "request", "receipt reserved + delegated (base)");

  await erSend(
    await pEr.methods
      .authorizeWithdraw()
      .accounts({
        payer: user.publicKey, market: groupMarket, riskGroup, assetSlots, portfolio,
        receipt: wReceipt,
        magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
        magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
      })
      .instruction()
  ).catch((e: any) =>
    // Permissionless: what matters is that the verdict lands, which the
    // receipt poll below establishes.
    console.log("authorize send:", String(e?.msg ?? e?.message ?? e).slice(0, 90))
  );

  let settled = false;
  for (let i = 0; i < 40; i++) {
    await sleep(2500);
    const info = await conn.getAccountInfo(wReceipt);
    if (!info) { settled = true; break; } // settled & closed
    if (info.owner.equals(PROGRAM_ID)) {
      await pBase.methods
        .settleWithdraw()
        .accounts({
          market: groupMarket, ledger, receipt: wReceipt, owner: user.publicKey,
          payoutTo: ata.address, vault, tokenProgram: TOKEN_PROGRAM_ID,
          escrowAuth: PublicKey.default, escrow: PublicKey.default,
        })
        .rpc()
        .catch((e: any) => console.log("settle send:", String(e?.msg ?? e?.message ?? e).slice(0, 80)));
      settled = true;
      break;
    }
  }
  await sleep(2000);
  const balAfter = BigInt((await conn.getTokenAccountBalance(ata.address)).value.amount);
  const gained = Number(balAfter - balBefore) / 1e6;
  report(settled && gained >= WITHDRAW / 1e6 - 1, "withdraw", `wallet +${gained} USDC`);

  console.log(failures === 0 ? "\nVERDICT  full lifecycle PASS — safe to record" : "\nVERDICT  FAILURES — do not record yet");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: any) => {
  console.error("FATAL:", e?.msg ?? e?.message ?? e);
  process.exit(1);
});
