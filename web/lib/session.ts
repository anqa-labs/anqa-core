"use client";

/**
 * The browser-held session key.
 *
 * One ephemeral keypair per (market, owner), living in localStorage. The
 * owner signs a single grant transaction; from then on this key signs every
 * trading instruction locally and no wallet prompt ever appears. The key can
 * only trade — custody instructions still demand the owner — so the blast
 * radius of a leaked browser key is one account's open orders until expiry.
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

/** Trade-only authority lifetime. Custody still always requires the wallet. */
export const SESSION_DURATION_SECS = 7 * 24 * 60 * 60;

type SessionReader = {
  account: {
    tradeSession: {
      fetch: (address: PublicKey) => Promise<{
        sessionKey: PublicKey;
        expiresAt: { toString: () => string };
      }>;
    };
  };
};

const verifiedGrants = new Map<string, { sessionKey: string; expiresAt: number }>();

/** Covers the short window between a successful clone read and React's next
 * base-layer refresh, preventing a second click from prompting to re-grant. */
export function sessionGrantIsFresh(
  address: PublicKey,
  sessionKey: PublicKey
): boolean {
  const grant = verifiedGrants.get(address.toBase58());
  return (
    grant?.sessionKey === sessionKey.toBase58() &&
    grant.expiresAt > Date.now() / 1000 + 60
  );
}

/** Wait for a new or renewed base-layer grant to reach the rollup clone. */
export async function waitForSessionGrant(
  program: unknown,
  address: PublicKey,
  sessionKey: PublicKey,
  attempts = 12
): Promise<boolean> {
  const reader = program as SessionReader;
  for (let i = 0; i < attempts; i += 1) {
    const grant = await reader.account.tradeSession
      .fetch(address)
      .catch(() => null);
    if (
      grant?.sessionKey.equals(sessionKey) &&
      Number(grant.expiresAt.toString()) > Date.now() / 1000 + 60
    ) {
      verifiedGrants.set(address.toBase58(), {
        sessionKey: sessionKey.toBase58(),
        expiresAt: Number(grant.expiresAt.toString()),
      });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const storageKey = (owner: PublicKey) => `anqa-session-key-${owner.toBase58()}`;

/** Load the session keypair for this owner, minting one if none exists.
 *  One key per wallet — the grant is platform-wide. */
export function sessionKeypair(owner: PublicKey): Keypair | null {
  if (typeof window === "undefined") return null;
  const key = storageKey(owner);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    // corrupted entry — fall through and mint a fresh one
  }
  const kp = Keypair.generate();
  window.localStorage.setItem(key, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/** Wrap a Keypair as the minimal wallet Anchor's provider needs. */
export function keypairWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T
    ) => {
      if (tx instanceof Transaction) tx.partialSign(kp);
      else tx.sign([kp]);
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[]
    ) => {
      for (const tx of txs) {
        if (tx instanceof Transaction) tx.partialSign(kp);
        else tx.sign([kp]);
      }
      return txs;
    },
  };
}
