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

import { Keypair, PublicKey } from "@solana/web3.js";

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
    signTransaction: async (tx: any) => {
      tx.partialSign ? tx.partialSign(kp) : tx.sign([kp]);
      return tx;
    },
    signAllTransactions: async (txs: any[]) => {
      for (const tx of txs) tx.partialSign ? tx.partialSign(kp) : tx.sign([kp]);
      return txs;
    },
  };
}
