/** Sweep leftover devnet SOL from throwaway demo/test keypairs back to admin. */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import fs from "fs"; import os from "os"; import path from "path";
(async () => {
  const conn = baseConnection("https://api.devnet.solana.com");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const files = fs.readdirSync("app").filter((f) =>
    /^\.(demo-maker|demo-taker|diag-taker)-\d+\.json$/.test(f)
  ).map((f) => "app/" + f);
  let swept = 0;
  for (const f of files) {
    try {
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf-8"))));
      if (kp.publicKey.equals(admin.publicKey)) continue;
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < 10_000_000) continue; // dust
      const keep = f.includes("930") && f.includes("maker") ? 200_000_000 : 0; // live maker keeps gas
      const send = bal - keep - 5_000;
      if (send <= 0) continue;
      await sendAndConfirmTransaction(conn, new Transaction().add(
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: admin.publicKey, lamports: send })
      ), [kp]);
      swept += send;
      console.log(`${f}  →  ${(send / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    } catch (e: any) { console.log(`${f}  skip: ${String(e.message ?? e).slice(0, 40)}`); }
  }
  console.log(`swept ${(swept / LAMPORTS_PER_SOL).toFixed(3)} SOL total`);
})();
