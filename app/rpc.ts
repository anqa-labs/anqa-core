/**
 * A base-layer connection that survives public devnet.
 *
 * The venue runs nine keepers, nine makers and a feed pusher, all polling the
 * same free endpoint from one IP. Public devnet answers that with
 * `429 Too Many Requests`, web3.js turns it into `failed to get balance of
 * account …`, and whichever loop was mid-flight dies. The keeper's requote
 * watchdog then respawns the maker, which issues its own burst, which 429s —
 * the load is self-reinforcing, so the ladder never comes back.
 *
 * Two things fix that here, and neither needs a paid endpoint:
 *
 *   1. **Retry on 429 instead of throwing.** A rate limit is a "come back
 *      later", not a failure, and every base-layer call in the venue is
 *      idempotent enough to repeat.
 *   2. **Cap in-flight requests per process.** Retrying alone just re-sends
 *      the same burst; the burst is what trips the limiter. Holding each
 *      process to a few concurrent calls spreads the same work flat.
 *
 * The honest cost: under sustained pressure calls queue rather than fail, so
 * a keeper tick can take seconds instead of milliseconds. Slow is recoverable.
 * Dead is not.
 *
 * The rollup endpoint does not need any of this — it is not rate limited, and
 * latency there is the whole point. Use a plain `Connection` for the ER.
 */

import { Connection, ConnectionConfig } from "@solana/web3.js";

/** Per-process ceiling on concurrent base-layer requests. */
const MAX_INFLIGHT = Number(process.env.ANQA_RPC_INFLIGHT ?? 4);
/** How many times to wait out a rate limit before giving up. */
const MAX_RETRIES = Number(process.env.ANQA_RPC_RETRIES ?? 6);

let inflight = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else inflight--;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backoff with jitter. The jitter matters more than the curve: nineteen
 * processes backing off on the same schedule just collide again in lockstep.
 */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  const server = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(server) && server > 0) return Math.min(server, 15_000);
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base + Math.random() * base;
}

const retryingFetch = async (input: any, init?: any): Promise<any> => {
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      let res: any;
      try {
        res = await fetch(input, init);
      } catch (e) {
        // A transport-level failure under load reads the same as a rate
        // limit from here, and deserves the same patience.
        if (attempt >= MAX_RETRIES) throw e;
        await sleep(backoffMs(attempt));
        continue;
      }
      const rateLimited = res.status === 429;
      const transient = res.status >= 500 && res.status < 600;
      if (!rateLimited && !transient) return res;
      if (attempt >= MAX_RETRIES) return res; // let web3.js report the real status
      await sleep(backoffMs(attempt, res.headers?.get?.("retry-after")));
    }
  } finally {
    release();
  }
};

/**
 * The connection every script should use for base layer. Same signature as
 * `new Connection(url, commitment)`.
 */
export function baseConnection(
  url: string,
  config: ConnectionConfig = { commitment: "confirmed" }
): Connection {
  return new Connection(url, { commitment: "confirmed", ...config, fetch: retryingFetch });
}

/**
 * Make Anchor confirmations HTTP-only.
 *
 * web3.js normally opens one `signatureSubscribe` WebSocket per transaction.
 * If the rollup socket disconnects, its reconnect loop can retain thousands of
 * dead subscriptions; the keeper eventually reached 4GB and crashed. Polling
 * `getSignatureStatuses` has the same confirmation semantics without keeping
 * any subscription state alive.
 */
export function useHttpConfirmation(connection: Connection): Connection {
  (connection as any).confirmTransaction = async (
    strategy: string | { signature: string; lastValidBlockHeight?: number },
    commitment: "processed" | "confirmed" | "finalized" = "confirmed"
  ) => {
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    const lastValid = typeof strategy === "string" ? undefined : strategy.lastValidBlockHeight;
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      const response = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = response.value[0];
      if (status) {
        if (status.err) return { context: response.context, value: { err: status.err } };
        const level = status.confirmationStatus;
        const done = commitment === "processed"
          || level === "finalized"
          || (commitment === "confirmed" && level === "confirmed");
        if (done) return { context: response.context, value: { err: null } };
      }
      if (lastValid !== undefined) {
        const height = await connection.getBlockHeight("confirmed");
        if (height > lastValid) {
          throw new Error(`transaction ${signature} expired before confirmation`);
        }
      }
      await sleep(250);
    }
    throw new Error(`transaction ${signature} was not confirmed in 60 seconds`);
  };
  return connection;
}
