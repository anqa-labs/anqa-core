import { NextResponse } from "next/server";

/**
 * OHLC history for the chart.
 *
 * Proxied from Pyth Benchmarks — deliberately, because that is the **same
 * feed the venue's mark is derived from**. `sync_internal_oracle` relays a
 * Pyth price on-chain and the crank marks every position against it, so
 * charting Pyth's own history is charting this market's history, not a
 * lookalike borrowed from some centralised exchange.
 *
 * Proxying rather than calling from the browser keeps the origin off the
 * client, sidesteps CORS, and lets the edge cache absorb repeat requests.
 */

import { MARKETS } from "@/lib/markets";

const PYTH = "https://benchmarks.pyth.network/v1/shims/tradingview/history";
const DEFAULT_FEED = process.env.NEXT_PUBLIC_PYTH_SYMBOL ?? "Crypto.BTC/USD";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolution = url.searchParams.get("resolution") ?? "5";
  // Whitelisted against the registry — this proxy serves our markets only.
  const requested = url.searchParams.get("symbol");
  const symbol =
    requested && MARKETS.some((m) => m.pythSymbol === requested) ? requested : DEFAULT_FEED;
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 60 * 60 * 24);

  try {
    const r = await fetch(
      `${PYTH}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}`,
      { next: { revalidate: 15 } }
    );
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = await r.json();
    if (j.s !== "ok" || !Array.isArray(j.t)) {
      return NextResponse.json({ candles: [] });
    }
    const candles = j.t.map((t: number, i: number) => ({
      time: t,
      open: j.o[i],
      high: j.h[i],
      low: j.l[i],
      close: j.c[i],
      volume: j.v?.[i] ?? 0,
    }));
    return NextResponse.json({ candles });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ candles: [], error: msg.slice(0, 120) }, { status: 200 });
  }
}
