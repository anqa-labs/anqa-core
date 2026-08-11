import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  for (const w of ["BJTfBsBGT1TYNeXZVi2zgxFaGEnfJiYtHDyyyYBzhLBL", "346kC5YfLaPXgpA13LcvmEaDtAAMaimpYiJ35YqbU2q2", "F8LegzimiCnVvM2EzupdifPW6ksRhGuG6LwxfLZnvHd6", "8qk2URihaG1hTFvMepm7mm7Sz5skJntvmgwZSKuzX5Em", "73e74KeP3xTxRtiEWSoZGyh2vmwzbJY47yLK9BAUb7LN"]) {
    const pf = PublicKey.findProgramAddressSync([Buffer.from("anqa_portfolio"), new BN(930).toArrayLike(Buffer, "le", 8), new PublicKey(w).toBuffer()], PROGRAM_ID)[0];
    const info = await er.getAccountInfo(pf).catch(() => null);
    console.log(w.slice(0, 6), info ? `capital ${Number(info.data.readBigUInt64LE(205)) / 1e6}` : "no portfolio on ER");
  }
})();
