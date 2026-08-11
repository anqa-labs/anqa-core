import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.verify-user.json", "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const pf = PublicKey.findProgramAddressSync([Buffer.from("anqa_portfolio"), new BN(930).toArrayLike(Buffer, "le", 8), user.publicKey.toBuffer()], PROGRAM_ID)[0];
  const info = await er.getAccountInfo(pf);
  const off = 73 + 12*16 + 12*16 + 132;
  console.log("capital @", off, "=", Number(info!.data.readBigUInt64LE(off)) / 1e6, "USDC");
})();
