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
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(maker, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const erK = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(maker), { commitment: "processed", skipPreflight: true })) as any;
  const pk = new Program(idl, new anchor.AnchorProvider(erK, new anchor.Wallet(admin), { commitment: "processed" })) as any;
  const g = (t: string, e: Buffer[] = []) => PublicKey.findProgramAddressSync([S(t), le8(930), ...e], PROGRAM_ID)[0];
  const m = (t: string, id: number) => PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const id = 932; // a market the daemon reports flat
  const market = m("anqa_market", id), book = m("anqa_book", id), oracleState = m("anqa_oracle", id);
  const mkt: any = await pk.account.market.fetch(market);
  const osx: any = await pk.account.oracleState.fetch(oracleState);
  const tick = Number(mkt.tickSize);
  const px = Number(osx.priceE6 ?? osx.price_e6 ?? 0);
  const midTicks = Number(process.env.MID ?? 19063);
  console.log("market", id, "tick", tick, "oracle e6", px, "mid ticks", midTicks);
  const ix = await p.methods.placeOrder({ bid: {} }, { postOnly: {} }, new BN(midTicks - 5), new BN(1000), new BN(Date.now() % 1e9), new BN(0), false)
    .accounts({ trader: maker.publicKey, session: null, market, book, riskGroup: g("anqa_risk"), assetSlots: g("anqa_assets"), oracleState, portfolio: g("anqa_portfolio", [maker.publicKey.toBuffer()]) }).instruction();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ix);
  tx.feePayer = maker.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(maker);
  const sim = await er.simulateTransaction(tx);
  console.log("err:", JSON.stringify(sim.value.err));
  for (const l of sim.value.logs ?? []) console.log(" ", l);
})();
