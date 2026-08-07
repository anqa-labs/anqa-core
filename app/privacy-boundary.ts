/**
 * The privacy boundary, proven adversarially.
 *
 * A reviewer asked the right question: the TEE hides private accounts from RPC
 * reads, but what stops someone from running their OWN program that CPI-reads
 * the account and copies the bytes into an account they can read? On Solana any
 * executing program may read any account in its instruction's account list, so
 * if arbitrary code could execute against a private account, privacy would be a
 * facade.
 *
 * This script answers it against the live devnet TEE, end to end:
 *
 *   1. A freshly-deployed, non-builtin program (`READER`, source in
 *      programs/anqa-reader) DOES clone and execute inside the rollup — shown by
 *      running it against PUBLIC accounts, where it logs their real bytes.
 *   2. The same program, invoked against a PRIVATE account by a non-member —
 *      even with a real signed transaction and the caller's own minted session
 *      token — is refused 403 at the TEE's authenticated ingress, before it
 *      executes. The transaction never runs, so it never reads the bytes.
 *   3. Control: the identical real submit against a PUBLIC account is admitted.
 *
 * Conclusion: the Query Filtering Service is not merely a read-response filter;
 * it is admission control keyed to session membership. To CPI-read a private
 * account you must get a transaction naming it admitted, and ingress refuses
 * that for anyone who cannot sign as a permission member. The exfiltration path
 * is closed at ingress.
 *
 *   npx ts-node --transpile-only app/privacy-boundary.ts
 *
 * Reproduce the program: `cargo-build-sbf` in programs/anqa-reader, then
 * `solana program deploy` the .so and set ANQA_READER to the new id.
 */
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as https from "https";
import fs from "fs";
import { teeRpcFor } from "./tee-auth";

// The attacker program, deployed to devnet base this project. Rebuild+redeploy
// and override with ANQA_READER to prove it from scratch on a fresh key.
const READER = new PublicKey(process.env.ANQA_READER ?? "Are1Rg5BRvuzxFYHCFZkFoGAiaXF78Rhd5i8MNxJBzPv");
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const BASE_RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const TEE_RPC = (process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app").split("?")[0];
const GROUP = BigInt(process.env.ANQA_GROUP ?? "930");
const MARKET = BigInt(process.env.ANQA_MARKET ?? "930");

const loadKp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const pda = (name: string, id: bigint, extra: Buffer[] = []) => {
  const le = Buffer.alloc(8); le.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from(name), le, ...extra], PROGRAM_ID)[0];
};

// Raw JSON-RPC that surfaces the HTTP status, so a 403 ingress block is not
// mistaken for a null/empty success (the mistake that first hid this result).
function rpc(url: string, method: string, params: any[]): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let b: any = null; try { b = JSON.parse(d); } catch { b = d; } resolve({ status: res.statusCode ?? 0, body: b }); }); }
    );
    req.on("error", reject); req.write(payload); req.end();
  });
}

const PASS = (l: string, d: string) => console.log(`  \x1b[32mPASS\x1b[0m  ${l.padEnd(38)} ${d}`);
const FAIL = (l: string, d: string) => console.log(`  \x1b[31mFAIL\x1b[0m  ${l.padEnd(38)} ${d}`);

/** Run the reader in the ER via authenticated simulate; return its logs. */
async function readerSim(sessionKp: Keypair, target: PublicKey) {
  const url = await teeRpcFor(sessionKp);
  const conn = new Connection(url.split("?")[0], "confirmed");
  const bh = (await conn.getLatestBlockhash()).blockhash;
  const ix = new TransactionInstruction({ programId: READER, keys: [{ pubkey: target, isSigner: false, isWritable: false }], data: Buffer.from([]) });
  const tx = new Transaction().add(ix); tx.feePayer = sessionKp.publicKey; tx.recentBlockhash = bh;
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const { status, body } = await rpc(url, "simulateTransaction", [wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
  const logs: string[] = body?.result?.value?.logs ?? [];
  return { status, body, exfil: logs.filter((l) => l.includes("ANQA-EXFIL")) };
}

/** Submit a REAL signed reader tx from `kp` (its own session); return status. */
async function readerSubmit(kp: Keypair, target: PublicKey) {
  const url = await teeRpcFor(kp);
  const conn = new Connection(url.split("?")[0], "confirmed");
  const bh = (await conn.getLatestBlockhash()).blockhash;
  const ix = new TransactionInstruction({ programId: READER, keys: [{ pubkey: target, isSigner: false, isWritable: false }], data: Buffer.from([]) });
  const tx = new Transaction().add(ix); tx.feePayer = kp.publicKey; tx.recentBlockhash = bh; tx.sign(kp);
  const wire = tx.serialize().toString("base64");
  const { status, body } = await rpc(url, "sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  const s = JSON.stringify(body?.error ?? body?.result ?? body);
  const blocked = status === 403 || /denied|forbidden/i.test(s);
  const admitted = !blocked && (typeof body?.result === "string" || /insufficient|debit|fund|blockhash|not found|account/i.test(s));
  return { status, blocked, admitted, detail: s.slice(0, 70) };
}

async function main() {
  const base = new Connection(BASE_RPC, "confirmed");
  const tapePub = pda("anqa_tape", MARKET);
  const book = pda("anqa_book", MARKET);
  const attacker = Keypair.generate();

  console.log("\nANQA · PRIVACY BOUNDARY (adversarial)");
  console.log(`  reader   ${READER.toBase58()} (non-builtin, deployed to base)`);
  console.log(`  attacker ${attacker.publicKey.toBase58()} (random, non-member)`);
  console.log(`  book     ${book.toBase58()} (private)`);
  console.log(`  tape     ${tapePub.toBase58()} (public control)\n`);

  // 1. The arbitrary program executes in the ER against a PUBLIC account.
  const pubRun = await readerSim(attacker, tapePub);
  if (pubRun.exfil.length) PASS("arbitrary program executes in ER", `read public tape: ${pubRun.exfil[0].slice(14, 70)}…`);
  else FAIL("arbitrary program executes in ER", `no log (status ${pubRun.status})`);

  // 2. Real signed non-member submit against the PRIVATE book -> ingress 403.
  const privSubmit = await readerSubmit(attacker, book);
  if (privSubmit.blocked) PASS("non-member submit vs private book", "403 blocked at ingress — never executes");
  else FAIL("non-member submit vs private book", `ADMITTED (${privSubmit.detail})`);

  // 3. Control: identical real submit against the PUBLIC tape is admitted.
  const pubSubmit = await readerSubmit(attacker, tapePub);
  if (pubSubmit.admitted) PASS("control: submit vs public tape", "admitted (200) — block is privacy-specific");
  else FAIL("control: submit vs public tape", `unexpected: status ${pubSubmit.status} ${pubSubmit.detail}`);

  // 4. Anonymous read of the private book returns null.
  const anonRead = await new Connection(TEE_RPC, "confirmed").getAccountInfo(book).catch(() => null);
  if (anonRead === null) PASS("anonymous read of private book", "null");
  else FAIL("anonymous read of private book", `${anonRead.data.length} bytes EXPOSED`);
  // (Sanity: it does exist on base, so null is a filter result, not absence.)
  const onBase = await base.getAccountInfo(book);
  console.log(`\n  book exists on base: ${onBase ? `${onBase.data.length} bytes` : "absent"} — so the null above is filtering, not absence.`);

  const ok = pubRun.exfil.length && privSubmit.blocked && pubSubmit.admitted && anonRead === null;
  console.log(
    ok
      ? "\n  VERDICT  Arbitrary code runs in the ER, yet cannot touch a private account: ingress refuses admission to non-members. Exfil closed at ingress.\n"
      : "\n  VERDICT  Boundary behaved unexpectedly — inspect above before using in the demo.\n"
  );
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(`\n  ERROR  ${e?.message ?? e}\n`); process.exitCode = 1; });
