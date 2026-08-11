import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const w = new PublicKey("73e74KeP3xTxRtiEWSoZGyh2vmwzbJY47yLK9BAUb7LN");
  const ledger = PublicKey.findProgramAddressSync([Buffer.from("anqa_ledger"), new BN(930).toArrayLike(Buffer, "le", 8), w.toBuffer()], PROGRAM_ID)[0];
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: admin.publicKey, lamports: 0 }));
  // Reference the ledger so the runtime loads it, then ask for it back.
  tx.instructions[0].keys.push({ pubkey: ledger, isSigner: false, isWritable: false });
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const sim = await er.simulateTransaction(tx, undefined, [ledger]);
  const acc = sim.value.accounts?.[0];
  if (!acc) return console.log("no account returned", JSON.stringify(sim.value.err));
  const data = Buffer.from((acc.data as any)[0], "base64");
  console.log("executor-view ledger bytes:", data.length);
  console.log("deposited (offset 48):", Number(data.readBigUInt64LE(8 + 32 + 8)) / 1e6);
})();
