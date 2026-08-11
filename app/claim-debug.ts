import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(admin), { commitment: "confirmed", skipPreflight: true })) as any;
  const S = (x: string) => Buffer.from(x);
  const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);
  const g = (t: string, e: Buffer[] = []) => PublicKey.findProgramAddressSync([S(t), le8(930), ...e], PROGRAM_ID)[0];
  const w = new PublicKey("73e74KeP3xTxRtiEWSoZGyh2vmwzbJY47yLK9BAUb7LN");
  const sig = await p.methods.claimDeposit().accounts({
    caller: admin.publicKey, market: g("anqa_market"), riskGroup: g("anqa_risk"), assetSlots: g("anqa_assets"),
    portfolio: g("anqa_portfolio", [w.toBuffer()]), ledger: g("anqa_ledger", [w.toBuffer()]),
    receipt: null, magicContext: null, magicProgram: null,
  }).rpc().catch((e: any) => { console.log("rpc error:", e?.msg ?? e?.message ?? e); return null; });
  console.log("sig", sig);
  if (sig) {
    await sleep(2000);
    const tx = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" } as any);
    console.log("err:", JSON.stringify(tx?.meta?.err));
    for (const l of tx?.meta?.logMessages ?? []) console.log(" ", l);
  }
})();
