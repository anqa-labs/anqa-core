import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const S = (x: string) => Buffer.from(x);
const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);
(async () => {
  const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.mm-maker-930.json", "utf-8"))));
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(maker, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(maker), { commitment: "processed", skipPreflight: true })) as any;
  const g = (t: string, e: Buffer[] = []) => PublicKey.findProgramAddressSync([S(t), le8(930), ...e], PROGRAM_ID)[0];
  const m = (t: string, id: number) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const id = Number(process.env.MKT ?? 932);
  const mid = Number(process.env.MID ?? 19116);
  const market = m("anqa_market", id), book = m("anqa_book", id), oracleState = m("anqa_oracle", id);
  const batch = [];
  for (let i = 0; i < 6; i++)
    batch.push({ side: { bid: {} }, priceInTicks: new BN(mid - 5 - i * 6), baseLots: new BN(Math.round(2000 * Math.pow(0.85, i))), clientOrderId: new BN(0x10000000 + i), hidden: false });
  const ix = await p.methods.placeMultiple(batch)
    .accounts({ trader: maker.publicKey, market, book, riskGroup: g("anqa_risk"), assetSlots: g("anqa_assets"), oracleState, portfolio: g("anqa_portfolio", [maker.publicKey.toBuffer()]) }).instruction();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ix);
  tx.feePayer = maker.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(maker);
  const sim = await er.simulateTransaction(tx);
  console.log("market", id, "err:", JSON.stringify(sim.value.err));
  for (const l of sim.value.logs ?? []) console.log(" ", l);
})();
