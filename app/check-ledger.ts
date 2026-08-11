import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
import { baseConnection } from "./rpc";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const base = baseConnection("https://api.devnet.solana.com");
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const w = new PublicKey("73e74KeP3xTxRtiEWSoZGyh2vmwzbJY47yLK9BAUb7LN");
  const ledger = PublicKey.findProgramAddressSync([Buffer.from("anqa_ledger"), new BN(930).toArrayLike(Buffer, "le", 8), w.toBuffer()], PROGRAM_ID)[0];
  const b = await base.getAccountInfo(ledger);
  const e = await er.getAccountInfo(ledger).catch(() => null);
  const dep = (i: any) => (i ? Number(i.data.readBigUInt64LE(8 + 32 + 8)) / 1e6 : null);
  console.log("ledger", ledger.toBase58());
  console.log("base deposited:", dep(b), " er-clone deposited:", dep(e));
})();
