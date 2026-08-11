/** Build the matcher's atomic clear+cross tx for market 931 and SIMULATE it,
 *  dumping program logs so the kernel's refusal reason is visible. */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const NIL = 0xffff;
const S = (x: string) => Buffer.from(x);
const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);
const f = (x: any, a: string, b: string) => x?.[a] ?? x?.[b];
const asBn = (x: any) => new BN(x?.toString?.() ?? String(x));
function walk(side: any): any[] {
  const r: any[] = []; const o = side?.orders ?? []; let c = Number(side?.head ?? NIL); const v = new Set<number>();
  while (c !== NIL && c >= 0 && c < o.length && !v.has(c)) { v.add(c); const x = o[c]; if (!x) break; if (x.active === 1) r.push(x); c = Number(x.next ?? NIL); }
  return r;
}
(async () => {
  const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.mm-maker-930.json", "utf-8"))));
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(maker, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(maker), { commitment: "processed", skipPreflight: true })) as any;
  const g = (t: string, e: Buffer[] = []) => PublicKey.findProgramAddressSync([S(t), le8(930), ...e], PROGRAM_ID)[0];
  const m = (t: string, id: number) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const market = m("anqa_market", 931), book = m("anqa_book", 931), oracleState = m("anqa_oracle", 931);
  const riskGroup = g("anqa_risk"), assetSlots = g("anqa_assets"), portfolio = g("anqa_portfolio", [maker.publicKey.toBuffer()]);
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const erK = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const pk = new Program(idl, new anchor.AnchorProvider(erK, new anchor.Wallet(admin), { commitment: "processed" })) as any;
  const bk: any = await pk.account.book.fetch(book);
  const q = walk(bk.bids);
  const idx = q.findIndex((o: any) => !new PublicKey(o.trader).equals(maker.publicKey));
  console.log("orders ahead of first user order:", idx);
  if (idx < 0) return console.log("no user order resting");
  const target = q[idx];
  const tPrice = asBn(f(target, "price_in_ticks", "priceInTicks")), tLots = asBn(f(target, "base_lots", "baseLots"));
  const order = process.env.REFRESH_FIRST === "1" ? "refresh-first" : "cancels-first";
  console.log("layout:", order, `target ${tLots}@${tPrice}`);
  const refreshIx = await p.methods.refreshPortfolio().accounts({ market, riskGroup, assetSlots, portfolio }).instruction();
  const cancels = [];
  for (const o of q.slice(0, idx))
    cancels.push(await p.methods.cancelOrder({ bid: {} }, asBn(f(o, "client_order_id", "clientOrderId")))
      .accounts({ trader: maker.publicKey, session: null, market, book, portfolio }).instruction());
  const placeIx = await p.methods.placeOrder({ ask: {} }, { immediateOrCancel: {} }, tPrice, tLots, new BN(Date.now() % 1e9), new BN(0), false)
    .accounts({ trader: maker.publicKey, session: null, market, book, riskGroup, assetSlots, oracleState, portfolio }).instruction();
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  if (process.env.REFRESH_FIRST === "1") ixs.push(refreshIx, ...cancels, placeIx);
  else ixs.push(...cancels, refreshIx, placeIx);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = maker.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(maker);
  const sim = await er.simulateTransaction(tx);
  console.log("err:", JSON.stringify(sim.value.err));
  for (const l of sim.value.logs ?? []) console.log(" ", l);
})();
