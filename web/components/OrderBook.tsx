"use client";

import { useState } from "react";
import { Badge } from "./ui";
import { ticksToUsd } from "@/lib/anqa";
import type { Anqa } from "@/lib/useAnqa";

/**
 * Order book and trades — the two views every terminal has, and the two that
 * differ most on a dark venue.
 *
 * The **book** keeps the familiar shape (price / size / total, depth bars,
 * spread down the middle) so the absence reads as absence rather than as a
 * missing feature: your rows are priced and sized, everyone else's are drawn
 * as bars with no numbers on them. On a TEE validator that is all the venue
 * will serve you; here it is rendered that way on principle.
 *
 * The **trades** tab is the tape, and it is complete — every fill, price and
 * size, exactly what the world gets.
 */
export function OrderBook({ anqa }: { anqa: Anqa }) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  const tick = anqa.market?.tickSize ?? 1;

  return (
    <section className="flex flex-col min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
      <header className="flex items-center shrink-0 h-9 border-b border-line-soft">
        {(["book", "trades"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-full px-3 text-[12px] font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-phoenix text-bright"
                : "border-transparent text-dim hover:text-text"
            }`}
          >
            {t === "book" ? "Order book" : "Trades"}
          </button>
        ))}
        <div className="ml-auto pr-2">
          <Badge tone={tab === "book" && anqa.market?.dark ? "dark" : "neutral"}>
            {tab === "book" ? (anqa.market?.dark ? "hidden" : "lit") : "public"}
          </Badge>
        </div>
      </header>

      {tab === "book" ? <BookView anqa={anqa} tick={tick} /> : <TradesView anqa={anqa} tick={tick} />}
    </section>
  );
}

function BookView({ anqa, tick }: { anqa: Anqa; tick: any }) {
  const px = (t: any) => ticksToUsd(Number(t.toString()), tick);
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6;

  const asks = [...anqa.myAsks].sort(
    (a, b) => Number(a.priceInTicks.toString()) - Number(b.priceInTicks.toString())
  );
  const bids = [...anqa.myBids].sort(
    (a, b) => Number(b.priceInTicks.toString()) - Number(a.priceInTicks.toString())
  );
  const maxLots = Math.max(
    1,
    ...[...asks, ...bids].map((o) => Number(o.baseLots.toString()))
  );

  return (
    <>
      <div className="grid grid-cols-3 shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-dim border-b border-line-soft">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* asks, worst at top so the spread sits in the middle */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse">
          <Rows rows={asks} hidden={anqa.hiddenAsks} side="ask" px={px} maxLots={maxLots} />
        </div>

        <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-y border-line-soft bg-surface/40">
          <span className="tnum text-[13px] font-medium text-phoenix">
            {mark === null ? "—" : mark.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <span className="text-[10px] text-dim">mark</span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <Rows rows={bids} hidden={anqa.hiddenBids} side="bid" px={px} maxLots={maxLots} />
        </div>
      </div>

      <footer className="shrink-0 px-3 py-1.5 border-t border-line-soft text-[10px] text-dim">
        {anqa.hiddenBids + anqa.hiddenAsks === 0 && asks.length + bids.length === 0
          ? "Nothing resting yet."
          : `${anqa.hiddenBids + anqa.hiddenAsks} orders you may not read. Nobody reads yours.`}
      </footer>
    </>
  );
}

function Rows({
  rows,
  hidden,
  side,
  px,
  maxLots,
}: {
  rows: any[];
  hidden: number;
  side: "bid" | "ask";
  px: (t: any) => number;
  maxLots: number;
}) {
  const tone = side === "bid" ? "text-bid" : "text-ask";
  const bar = side === "bid" ? "bg-bid/12" : "bg-ask/12";
  const veils = Math.min(hidden, 7);
  let running = 0;

  return (
    <>
      {rows.map((o, i) => {
        const lots = Number(o.baseLots.toString());
        running += lots;
        return (
          <div key={i} className="relative grid grid-cols-3 px-3 py-[3px] text-[11px]">
            <div
              className={`absolute inset-y-0 right-0 ${bar}`}
              style={{ width: `${Math.min(100, (lots / maxLots) * 100)}%` }}
            />
            <span className={`relative tnum ${tone}`}>
              {px(o.priceInTicks).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            <span className="relative tnum text-right text-text">{lots}</span>
            <span className="relative tnum text-right text-phoenix/90">yours</span>
          </div>
        );
      })}

      {Array.from({ length: veils }).map((_, i) => (
        <div
          key={`veil-${i}`}
          className="grid grid-cols-3 items-center px-3 py-[3px]"
          title="Resting depth you are not permitted to read"
        >
          <span className="veil h-2.5 rounded-sm mr-4 opacity-35" />
          <span className="veil h-2.5 rounded-sm ml-6 opacity-35" />
          <span className="text-right text-[9px] text-dim">hidden</span>
        </div>
      ))}
    </>
  );
}

function TradesView({ anqa, tick }: { anqa: Anqa; tick: any }) {
  return (
    <>
      <div className="grid grid-cols-3 shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-dim border-b border-line-soft">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {anqa.tape.length === 0 ? (
          <div className="h-full grid place-items-center px-4">
            <p className="text-[11px] text-dim text-center max-w-[24ch] leading-relaxed">
              No fills yet. When a hidden order trades, this is where it shows up.
            </p>
          </div>
        ) : (
          anqa.tape.map((p) => (
            <div key={p.seq} className="grid grid-cols-3 px-3 py-[3px] text-[11px]">
              <span className="tnum text-bright">
                {ticksToUsd(p.priceInTicks, tick).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}
              </span>
              <span className="tnum text-right text-muted">{p.baseLots}</span>
              <span className="tnum text-right text-dim">
                {new Date(p.timestamp * 1000).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
          ))
        )}
      </div>
      <footer className="shrink-0 px-3 py-1.5 border-t border-line-soft text-[10px] text-dim">
        Price, size, time. No maker, no taker, no side.
      </footer>
    </>
  );
}
