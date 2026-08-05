import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { teeRpcFor } from "./tee-auth";
import fs from "fs"; import os from "os"; import path from "path";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const ID = Number(process.env.ANQA_DEMO_MARKET ?? 930);
(async () => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(await teeRpcFor(kp, "https://devnet-tee.magicblock.app"), "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(kp), { commitment: "confirmed" })) as any;
  const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);
  const bk: any = await p.account.book.fetch(
    PublicKey.findProgramAddressSync([Buffer.from("anqa_book"), le8(ID)], PROGRAM_ID)[0]);
  const head = Number(bk.pendingHead), cnt = Number(bk.pendingCount);
  console.log(`pending=${cnt} head=${head} fills=${bk.fillCount}`);
  const seen = new Set<string>();
  for (let i = 0; i < cnt; i++) {
    const f = bk.pending[(head + i) % 16];
    for (const k of [f.taker, f.maker]) {
      const b = new PublicKey(k).toBase58();
      if (!seen.has(b)) { seen.add(b); console.log(" party:", b); }
    }
  }
})();
