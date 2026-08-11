import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.verify-user.json", "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(admin), { commitment: "confirmed" })) as any;
  const pf = PublicKey.findProgramAddressSync([Buffer.from("anqa_portfolio"), new BN(930).toArrayLike(Buffer, "le", 8), user.publicKey.toBuffer()], PROGRAM_ID)[0];
  const acct: any = await p.account.portfolio.fetch(pf);
  console.log("claimedHighWater:", new BN(acct.claimedHighWater, 10, "le").toString());
  const info = await er.getAccountInfo(pf);
  if (info) {
    for (const off of [205, 457, 465, 473]) {
      try { console.log(`offset ${off}:`, Number(info.data.readBigUInt64LE(off)) / 1e6); } catch {}
    }
    console.log("account bytes:", info.data.length);
  }
})();
