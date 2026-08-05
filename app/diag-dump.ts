/** Dump group-scoped kernel accounts for offline replay through tests/diag.rs. */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { teeRpcFor } from "./tee-auth";
import fs from "fs"; import os from "os"; import path from "path";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const GROUP = new BN(process.env.ANQA_GROUP ?? 920);
const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);
(async () => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(await teeRpcFor(kp, "https://devnet-tee.magicblock.app"), "confirmed");
  const g = (t: string) => PublicKey.findProgramAddressSync([Buffer.from(t), le8(GROUP)], PROGRAM_ID)[0];
  const extra: [string, PublicKey][] = (process.env.ANQA_DUMP_PF ?? "")
    .split(",").filter(Boolean)
    .map((b58, i) => [`pf${i}`, PublicKey.findProgramAddressSync(
      [Buffer.from("anqa_portfolio"), le8(GROUP), new PublicKey(b58).toBuffer()], PROGRAM_ID)[0]]);
  for (const [name, key] of [["risk", g("anqa_risk")], ["assets", g("anqa_assets")], ...extra] as const) {
    const info = await er.getAccountInfo(key);
    if (!info) { console.log(`${name}: MISSING`); continue; }
    fs.writeFileSync(`/tmp/${name}.bin`, info.data.subarray(8)); // strip anchor disc
    console.log(`wrote /tmp/${name}.bin ${info.data.length - 8} bytes`);
  }
})();
