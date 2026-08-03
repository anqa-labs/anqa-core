/**
 * Resolve a Pyth price-update account for a feed.
 *
 * BTC and SOL have persistent sponsored push accounts on devnet; ETH does
 * not — its updates land in fresh transient accounts that close minutes
 * later. With `ANQA_FEED_ACCT=auto`, this scans the receiver program for the
 * freshest post of the feed and returns it, so a market can run on a feed
 * that has no fixed address. A `dataSlice` keeps the scan cheap: we pull the
 * eight publish-time bytes per account, not five megabytes of history.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const FEED_ID_OFFSET = 41;
const PUBLISH_TIME_OFFSET = 93;
const PRICE_UPDATE_SIZE = 134;

/** The freshest N transient posts for a feed, newest first. */
export async function resolveFeedCandidates(
  conn: Connection,
  feedHex: string,
  n = 10
): Promise<PublicKey[]> {
  const res = await conn.getProgramAccounts(RECEIVER, {
    dataSlice: { offset: PUBLISH_TIME_OFFSET, length: 8 },
    filters: [
      { dataSize: PRICE_UPDATE_SIZE },
      { memcmp: { offset: FEED_ID_OFFSET, bytes: bs58.encode(Buffer.from(feedHex, "hex")) } },
    ],
  });
  return res
    .map(({ pubkey, account }) => ({ key: pubkey, t: Number(account.data.readBigInt64LE(0)) }))
    .sort((a, b) => b.t - a.t)
    .slice(0, n)
    .map((x) => x.key);
}

export async function resolveFeedAccount(
  conn: Connection,
  feedHex: string,
  fallback: string
): Promise<PublicKey> {
  const configured = process.env.ANQA_FEED_ACCT;
  if (configured && configured !== "auto") return new PublicKey(configured);
  if (configured !== "auto") return new PublicKey(fallback);

  // The scan is slow and the accounts are short-lived: take the freshest
  // candidates and return the first one still alive right now.
  const candidates = await resolveFeedCandidates(conn, feedHex);
  for (const key of candidates) {
    if (await conn.getAccountInfo(key)) return key;
  }
  throw new Error(`no live price update for feed ${feedHex.slice(0, 8)}…`);
}
