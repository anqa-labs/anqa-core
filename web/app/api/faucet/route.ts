import { NextResponse } from "next/server";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

/**
 * Devnet play-money faucet.
 *
 * A trader arriving with an empty wallet has nothing to deposit, and a demo
 * that cannot be tried is not a demo. This mints test collateral — never a
 * real asset, on a devnet mint whose authority is a throwaway key. It refuses
 * outright unless a faucet key is configured, so a production deploy that
 * forgets to unset it simply has no faucet rather than a surprise.
 */

const AMOUNT = 250_000; // whole tokens, 6 decimals
const DECIMALS = 6;

export async function POST(req: Request) {
  const key = process.env.ANQA_FAUCET_KEY;
  const mintStr = process.env.NEXT_PUBLIC_COLLATERAL_MINT;
  if (!key || !mintStr) {
    return NextResponse.json({ error: "Faucet is not configured" }, { status: 503 });
  }

  let owner: PublicKey;
  try {
    const body = await req.json();
    owner = new PublicKey(body.owner);
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  try {
    const conn = new Connection(
      process.env.NEXT_PUBLIC_BASE_RPC ?? "https://api.devnet.solana.com",
      "confirmed"
    );
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
    const mint = new PublicKey(mintStr);
    const ata = getAssociatedTokenAddressSync(mint, owner);

    const tx = new Transaction();
    if (!(await conn.getAccountInfo(ata))) {
      tx.add(createAssociatedTokenAccountInstruction(authority.publicKey, ata, owner, mint));
    }
    tx.add(
      createMintToInstruction(mint, ata, authority.publicKey, BigInt(AMOUNT) * 10n ** BigInt(DECIMALS))
    );

    const sig = await sendAndConfirmTransaction(conn, tx, [authority], {
      commitment: "confirmed",
    });
    return NextResponse.json({ signature: sig, amount: AMOUNT });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 });
  }
}
