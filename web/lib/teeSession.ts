"use client";

// The bundled bs58 ships no types; the encode signature is all we need.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58: { encode: (b: Uint8Array) => string } = require("bs58");
import { PublicKey } from "@solana/web3.js";

/**
 * The terminal's session on the private rollup.
 *
 * The book is hidden by a filter that runs in front of the rollup's RPC and
 * decides, per account, whether the caller may read it. To decide, it has to
 * know who is calling — so the browser signs a challenge once and trades the
 * signature for a token that rides on the connection URL.
 *
 * This is not what protects anyone: minting a token is permissionless, and
 * without one you are merely anonymous. Membership on each account's
 * permission record is what grants sight. The token only says which key you
 * are, so that record can be checked.
 *
 * Cached in localStorage because it lasts 30 days and the alternative is a
 * signature prompt on every reload.
 */

const KEY = (owner: string) => `anqa-tee-token-${owner}`;

type Cached = { token: string; exp: number };

function cached(owner: string): string | null {
  try {
    const raw = window.localStorage.getItem(KEY(owner));
    if (!raw) return null;
    const c: Cached = JSON.parse(raw);
    // A minute of slack, so a token cannot expire mid-request.
    return c.exp * 1000 > Date.now() + 60_000 ? c.token : null;
  } catch {
    return null;
  }
}

function remember(owner: string, token: string) {
  try {
    const exp = JSON.parse(atob(token.split(".")[1])).exp as number;
    window.localStorage.setItem(KEY(owner), JSON.stringify({ token, exp }));
  } catch {
    // an unreadable token is still usable; it just will not be reused
  }
}

/**
 * Mint (or reuse) a session token for `owner`.
 *
 * `sign` is the wallet's `signMessage`. Returns null when the wallet cannot
 * sign messages — the terminal still works, it just reads public accounts
 * only, which is the honest degradation.
 */
export async function teeToken(
  rpc: string,
  owner: PublicKey,
  sign: ((m: Uint8Array) => Promise<Uint8Array>) | undefined
): Promise<string | null> {
  const base = rpc.split("?")[0];
  if (!base.includes("-tee.")) return null; // regional validators ignore tokens
  const key = owner.toBase58();

  const hit = cached(key);
  if (hit) return hit;
  if (!sign) return null;

  const cr = await fetch(`${base}/auth/challenge?pubkey=${key}`);
  if (!cr.ok) return null;
  const { challenge } = await cr.json();

  const signature = bs58.encode(await sign(new TextEncoder().encode(challenge)));

  const lr = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: key, challenge, signature }),
  });
  if (!lr.ok) return null;
  const { token } = await lr.json();
  remember(key, token);
  return token;
}

/**
 * The token already minted for `owner`, or null.
 *
 * For readers that need sight of private accounts but must never provoke a
 * signature prompt of their own — background polls for positions and resting
 * orders. `useAnqa` mints; these reuse. Read per poll rather than once at
 * mount, because a hook can start before the wallet has signed and must pick
 * the token up when it lands.
 */
export function cachedToken(owner: PublicKey | string): string | null {
  return cached(typeof owner === "string" ? owner : owner.toBase58());
}

/** The rollup URL to actually connect to, token attached when we have one. */
export function rpcWithToken(rpc: string, token: string | null): string {
  const base = rpc.split("?")[0];
  return token ? `${base}?token=${token}` : base;
}
