/**
 * Anonymous, read-only proof of Anqa's PER account boundary.
 *
 * Run from the repository root:
 *   npm run privacy:proof -- <CONNECTED_WALLET>
 *
 * The command deliberately carries no wallet, JWT, session token or private
 * RPC key. It proves the portfolio exists on Solana, then asks the same public
 * TEE endpoint for the live portfolio, full book and public tape.
 */
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(
  "4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW"
);
const BASE_RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const TEE_RPC =
  process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const MARKET_ID = new BN(process.env.ANQA_MARKET ?? "930");
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? "930");

const seed = (value: string) => Buffer.from(value);
const le8 = (value: BN) => value.toArrayLike(Buffer, "le", 8);
const pda = (name: string, id: BN, extra: Buffer[] = []) =>
  PublicKey.findProgramAddressSync(
    [seed(name), le8(id), ...extra],
    PROGRAM_ID
  )[0];

const pass = (label: string, result: string) =>
  console.log(`  PASS  ${label.padEnd(30)} ${result}`);
const fail = (label: string, result: string) =>
  console.log(`  FAIL  ${label.padEnd(30)} ${result}`);

async function main() {
  const rawOwner = process.argv[2] ?? process.env.ANQA_OWNER;
  if (!rawOwner) {
    throw new Error(
      "wallet address required: npm run privacy:proof -- <CONNECTED_WALLET>"
    );
  }

  const owner = new PublicKey(rawOwner);
  const portfolio = pda("anqa_portfolio", GROUP_ID, [owner.toBuffer()]);
  const book = pda("anqa_book", MARKET_ID);
  const tape = pda("anqa_tape", MARKET_ID);
  const base = new Connection(BASE_RPC, "confirmed");
  // Intentionally anonymous: plain endpoint, no query token or auth headers.
  const anonymous = new Connection(TEE_RPC.split("?")[0], "confirmed");

  console.log("\nANQA · ANONYMOUS PER READ PROOF");
  console.log(`  wallet     ${owner.toBase58()}`);
  console.log(`  portfolio  ${portfolio.toBase58()}`);
  console.log(`  market     ${MARKET_ID.toString()}`);
  console.log(`  endpoint   ${TEE_RPC.split("?")[0]} (no authentication)\n`);

  // Do not collapse network failure into privacy: every RPC error aborts the
  // command. A null below is therefore a real JSON-RPC account result.
  const [basePortfolio, privatePortfolio, privateBook, publicTape] =
    await Promise.all([
      base.getAccountInfo(portfolio),
      anonymous.getAccountInfo(portfolio),
      anonymous.getAccountInfo(book),
      anonymous.getAccountInfo(tape),
    ]);

  let valid = true;
  if (basePortfolio) {
    pass(
      "portfolio exists on Solana",
      `${basePortfolio.data.length} bytes · owner ${basePortfolio.owner
        .toBase58()
        .slice(0, 8)}…`
    );
  } else {
    fail("portfolio exists on Solana", "account absent");
    valid = false;
  }

  if (privatePortfolio === null) {
    pass("anonymous portfolio read", "null · PRIVATE");
  } else {
    fail("anonymous portfolio read", "returned bytes · EXPOSED");
    valid = false;
  }

  if (privateBook === null) {
    pass("anonymous full-book read", "null · PRIVATE");
  } else {
    fail("anonymous full-book read", "returned bytes · EXPOSED");
    valid = false;
  }

  if (publicTape) {
    pass(
      "anonymous public-tape read",
      `${publicTape.data.length} bytes · PUBLIC`
    );
  } else {
    fail("anonymous public-tape read", "null · endpoint/public tape unavailable");
    valid = false;
  }

  console.log(
    valid
      ? "\n  VERDICT  Same RPC: private state refused, public evidence readable.\n"
      : "\n  VERDICT  Privacy proof failed. Do not use this result in the demo.\n"
  );
  if (!valid) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n  ERROR  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
