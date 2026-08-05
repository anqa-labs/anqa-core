/**
 * Read-only live settlement audit.
 *
 * Lists recent settle_fill transactions for one market, including the program
 * outcome that the keeper's terse "settled" log currently hides. Portfolio
 * accounts touched by each transaction are decoded far enough to print their
 * owner, which lets us locate a trader from a wallet prefix without exposing
 * any key material.
 */

import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { teeRpcFor } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = Number(process.env.ANQA_MARKET ?? 930);
const LIMIT = Number(process.env.ANQA_LIMIT ?? 120);
const OWNER_PREFIX = process.env.ANQA_OWNER_PREFIX ?? "6mKY";

const portfolioDisc = createHash("sha256").update("account:Portfolio").digest().subarray(0, 8);
const le8 = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);
const book = PublicKey.findProgramAddressSync(
  [Buffer.from("anqa_book"), le8(MARKET_ID)],
  PROGRAM_ID,
)[0];

function txKeys(tx: any): PublicKey[] {
  const msg = tx.transaction.message;
  if (Array.isArray(msg.accountKeys)) {
    return msg.accountKeys.map((x: any) => new PublicKey(x.pubkey ?? x));
  }
  const all = msg.getAccountKeys?.({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  return all ? [...all.staticAccountKeys, ...(all.accountKeysFromLookups?.writable ?? []), ...(all.accountKeysFromLookups?.readonly ?? [])] : [];
}

async function main() {
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"),
          "utf8",
        ),
      ),
    ),
  );
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const signatures = await er.getSignaturesForAddress(book, { limit: LIMIT }, "confirmed");

  console.log(`market ${MARKET_ID} book ${book.toBase58()} — ${signatures.length} recent transactions`);
  let settles = 0;
  for (const item of signatures) {
    const tx = await er.getTransaction(item.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;
    const logs = tx.meta?.logMessages ?? [];
    if (!logs.some((line) => line.includes("Instruction: SettleFill"))) continue;
    settles++;

    const outcome = logs.some((line) => line.includes("dark fill settled"))
      ? "ACCEPTED"
      : logs.some((line) => line.includes("dark fill refused"))
        ? "REFUSED"
        : tx.meta?.err
          ? "TX_ERROR"
          : "UNKNOWN";
    const reason = logs.find((line) => line.includes("kernel refused"));

    const keys = txKeys(tx);
    const infos = keys.length ? await er.getMultipleAccountsInfo(keys, "confirmed") : [];
    const owners: string[] = [];
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      if (!info || !info.owner.equals(PROGRAM_ID)) continue;
      const data = Buffer.from(info.data);
      if (data.length < 40 || !data.subarray(0, 8).equals(portfolioDisc)) continue;
      owners.push(new PublicKey(data.subarray(8, 40)).toBase58());
    }

    const when = item.blockTime ? new Date(item.blockTime * 1000).toISOString() : "unknown-time";
    const hit = owners.some((owner) => owner.startsWith(OWNER_PREFIX)) ? ` MATCH:${OWNER_PREFIX}` : "";
    console.log(`${when} ${outcome}${hit} ${item.signature}`);
    if (owners.length) console.log(`  owners: ${[...new Set(owners)].join(" ")}`);
    if (reason) console.log(`  ${reason}`);
    if (outcome === "TX_ERROR") console.log(`  ${JSON.stringify(tx.meta?.err)}`);
  }
  console.log(`settle_fill transactions found: ${settles}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
