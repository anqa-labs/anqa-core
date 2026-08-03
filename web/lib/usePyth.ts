"use client";

import { useSyncExternalStore } from "react";

/**
 * Live index prices, streamed straight from Pyth's Hermes service.
 *
 * The venue's own mark can only move as fast as the on-chain devnet feed is
 * pushed — every ~30 seconds when the market is calm — which is honest for
 * margin math but makes a terminal feel frozen. Hermes streams the same
 * feeds the venue marks against at sub-second cadence, so the *display*
 * follows the market live while every on-chain number stays anchored to the
 * posted mark.
 *
 * One EventSource per feed, shared app-wide through useSyncExternalStore.
 */

type Store = { price: number | null; subs: Set<() => void>; started: boolean };
const stores = new Map<string, Store>();

function store(feedId: string): Store {
  let s = stores.get(feedId);
  if (!s) {
    s = { price: null, subs: new Set(), started: false };
    stores.set(feedId, s);
  }
  return s;
}

function start(feedId: string) {
  const s = store(feedId);
  if (s.started || typeof window === "undefined") return;
  s.started = true;
  const es = new EventSource(
    `https://hermes.pyth.network/v2/updates/price/stream?ids[]=${feedId}&parsed=true`
  );
  es.onmessage = (ev) => {
    try {
      const p = JSON.parse(ev.data)?.parsed?.[0]?.price;
      if (p?.price) {
        s.price = Number(p.price) * 10 ** p.expo;
        s.subs.forEach((fn) => fn());
      }
    } catch {
      // one bad frame is not worth a broken stream
    }
  };
  // EventSource reconnects on its own; nothing to do on error.
}

/** Live price for a Pyth feed id, or null until the first tick arrives. */
export function usePythLive(feedId: string): number | null {
  return useSyncExternalStore(
    (cb) => {
      const s = store(feedId);
      start(feedId);
      s.subs.add(cb);
      return () => s.subs.delete(cb);
    },
    () => stores.get(feedId)?.price ?? null,
    () => null
  );
}
