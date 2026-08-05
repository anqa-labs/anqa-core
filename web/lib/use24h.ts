"use client";

import { useEffect, useState } from "react";

/**
 * The 24-hour picture: high, low, and the change since yesterday.
 *
 * Read from the same Pyth history the chart draws and the venue's mark is
 * relayed from — so these are this market's numbers, not a lookalike borrowed
 * from a centralised exchange. Volume is deliberately absent: a dark venue's
 * own traded volume would have to come from the fill tape, which is a bounded
 * ring buffer and cannot honestly total a day. Better to omit a figure than to
 * publish one that is quietly wrong.
 */
export type Day = { high: number; low: number; change: number; changePct: number } | null;

export function use24h(pythSymbol: string, lotFrac = 1): Day {
  const [day, setDay] = useState<Day>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - 60 * 60 * 24;
        const r = await fetch(
          `/api/candles?symbol=${encodeURIComponent(pythSymbol)}&resolution=60&from=${from}&to=${to}`
        );
        const j = await r.json();
        const c: { high: number; low: number; open: number; close: number }[] = j.candles ?? [];
        if (!c.length) return;
        const high = Math.max(...c.map((x) => x.high));
        const low = Math.min(...c.map((x) => x.low));
        const open = c[0].open;
        const close = c[c.length - 1].close;
        if (!stop) {
          setDay({
            high: high / lotFrac,
            low: low / lotFrac,
            change: (close - open) / lotFrac,
            changePct: open ? ((close - open) / open) * 100 : 0,
          });
        }
      } catch {
        // A missing history is not worth a broken header; the strip shows "—".
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pythSymbol, lotFrac]);

  return day;
}
