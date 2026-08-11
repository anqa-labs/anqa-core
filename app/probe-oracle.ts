import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(admin), { commitment: "confirmed" })) as any;
  for (const id of [930, 931, 932]) {
    const o = PublicKey.findProgramAddressSync([Buffer.from("anqa_oracle"), new BN(id).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
    const a: any = await p.account.oracleState.fetch(o).catch((e: any) => ({ err: String(e).slice(0, 60) }));
    console.log(id, JSON.stringify(a, (_k, v) => (typeof v === "object" && v?.toString ? v.toString() : v)).slice(0, 300));
  }
})();
