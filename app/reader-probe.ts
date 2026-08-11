/** Execution-time view of the fresh ledger: invoke the anqa-reader program on
 *  the ER as the ADMIN (a member), handing it the scratch ledger. Its logs
 *  show the exact bytes the transaction executor was given. */
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const READER = new PublicKey("Are1Rg5BRvuzxFYHCFZkFoGAiaXF78Rhd5i8MNxJBzPv");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.verify-user.json", "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const ledger = PublicKey.findProgramAddressSync([Buffer.from("anqa_ledger"), new BN(930).toArrayLike(Buffer, "le", 8), user.publicKey.toBuffer()], PROGRAM_ID)[0];
  console.log("wallet", user.publicKey.toBase58(), "ledger", ledger.toBase58());
  const ix = new TransactionInstruction({
    programId: READER,
    keys: [{ pubkey: ledger, isSigner: false, isWritable: false }],
    data: Buffer.alloc(0),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(admin);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log("sig", sig);
  await sleep(2500);
  const t = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" } as any);
  console.log("err:", JSON.stringify(t?.meta?.err));
  for (const l of t?.meta?.logMessages ?? []) console.log(" ", l);
})();
