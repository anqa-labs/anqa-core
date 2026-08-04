/**
 * Authenticating to the private rollup.
 *
 * The TEE validator sits behind a Query Filtering Service that decides, per
 * account, whether a caller may read it. To make that decision it has to know
 * who is asking — so a session is bound to a keypair: ask for a challenge,
 * sign it, exchange the signature for a JWT.
 *
 * It is not an access key. Anyone can mint one; without it you are simply
 * anonymous, which is fine for public accounts and useless for private ones.
 * Tokens last 30 days.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const TEE_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";

export async function teeAuthToken(kp: Keypair, rpc = TEE_RPC): Promise<string> {
  const base = rpc.split("?")[0];
  const pubkey = kp.publicKey.toBase58();

  const cr = await fetch(`${base}/auth/challenge?pubkey=${pubkey}`);
  if (!cr.ok) throw new Error(`challenge failed: ${cr.status}`);
  const { challenge } = await cr.json();

  // base58, like every other signature on Solana — base64 is rejected with
  // "failed to decode string to signature".
  const signature = bs58.encode(
    nacl.sign.detached(Buffer.from(challenge, "utf8"), kp.secretKey)
  );

  const lr = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, challenge, signature }),
  });
  if (!lr.ok) throw new Error(`login failed: ${lr.status} ${await lr.text()}`);
  const { token } = await lr.json();
  return token;
}

/** The RPC URL a signer should actually connect to. */
export async function teeRpcFor(kp: Keypair, rpc = TEE_RPC): Promise<string> {
  const base = rpc.split("?")[0];
  // Only the TEE endpoint authenticates; regional validators ignore tokens.
  if (!base.includes("-tee.")) return base;
  const token = await teeAuthToken(kp, base);
  return `${base}?token=${token}`;
}
