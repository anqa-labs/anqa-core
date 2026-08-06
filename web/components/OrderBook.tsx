"use client";

import { useState } from "react";
import { Badge } from "./ui";
import { lotFraction, ticksToUsd } from "@/lib/anqa";
import { useDepth, type Level } from "@/lib/useDepth";
import { useTickFlash, useTweened } from "@/lib/useLive";
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
    <section className="flex flex-col h-full min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
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
            {tab === "book" ? (anqa.market?.dark ? "aggregate" : "lit") : "public"}
          </Badge>
        </div>
      </header>

      {tab === "book" ? <BookView anqa={anqa} tick={tick} /> : <TradesView anqa={anqa} tick={tick} />}
    </section>
  );
}

function BookView({ anqa, tick }: { anqa: Anqa; tick: any }) {
  // Book prices are per lot; the trader reads per whole base asset.
  const frac = lotFraction(anqa.market);
  const px = (t: any) => ticksToUsd(Number(t.toString()), tick) / frac;

  // Aggregate depth: totals per price, published by the program from inside
  // the rollup. It says how much is resting and never whose it is — the one
  // piece of opacity that would cost the taker rather than protect the maker.
  const depth = useDepth(anqa.marketInfo.id);
  const asks = depth?.asks ?? [];
  const bids = depth?.bids ?? [];
  const bestAsk = asks.length ? Math.min(...asks.map((l) => px(l.priceInTicks))) : null;
  const bestBid = bids.length ? Math.max(...bids.map((l) => px(l.priceInTicks))) : null;
  const spread = bestAsk !== null && bestBid !== null ? Math.max(0, bestAsk - bestBid) : null;
  const midpoint = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
  const spreadPct = spread !== null && midpoint !== null && midpoint > 0
    ? (spread / midpoint) * 100
    : null;
  // One price tick as the trader sees it: SOL is currently $0.01, BTC $1.00.
  const tickUsd = ticksToUsd(1, tick) / frac;
  // Which levels the trader has size in — theirs to know, nobody else's.
  const mine = new Set(
    [...anqa.myBids, ...anqa.myAsks].map((o) => Number(o.priceInTicks.toString()))
  );
  const maxLots = Math.max(1, ...[...asks, ...bids].map((l) => l.baseLots));

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
          <Rows rows={asks} mine={mine} side="ask" px={px} maxLots={maxLots} frac={frac} />
        </div>

        <SpreadBar tickUsd={tickUsd} spreadPct={spreadPct} />

        <div className="flex-1 min-h-0 overflow-y-auto">
          <Rows rows={bids} mine={mine} side="bid" px={px} maxLots={maxLots} frac={frac} />
        </div>
      </div>

      <footer className="shrink-0 px-3 py-1.5 border-t border-line-soft text-[10px] text-dim">
        {asks.length + bids.length === 0
          ? "Nothing resting yet."
          : `${((depth!.totalBidLots + depth!.totalAskLots) * frac).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${anqa.marketInfo.base} resting · sizes are totals, never whose.`}
      </footer>
    </>
  );
}

/** Phoenix-style divider: price increment, label, and live relative spread. */
function SpreadBar({
  tickUsd,
  spreadPct,
}: {
  tickUsd: number;
  spreadPct: number | null;
}) {
  const shown = useTweened(spreadPct, 280);
  const flash = useTickFlash(spreadPct);
  const tickDp = tickUsd >= 1 ? 2 : Math.min(8, Math.max(2, Math.ceil(-Math.log10(tickUsd))));

  return (
    <div className="grid grid-cols-3 shrink-0 items-center px-3 py-2 border-y border-line-soft bg-surface/60 text-[11px]">
      <span className="tnum text-text">
        {tickUsd.toLocaleString(undefined, {
          minimumFractionDigits: tickDp,
          maximumFractionDigits: tickDp,
        })}
      </span>
      <span className="text-center font-medium text-muted">Spread</span>
      <span
        key={flash.key}
        className={`tnum text-right text-text px-1 -mr-1 ${
          flash.dir ? "spread-tick" : ""
        }`}
      >
        {shown === null ? "—" : `${shown.toFixed(3)}%`}
      </span>
    </div>
  );
}

function Rows({
  rows,
  mine,
  side,
  px,
  maxLots,
  frac,
}: {
  rows: Level[];
  mine: Set<number>;
  side: "bid" | "ask";
  px: (t: any) => number;
  maxLots: number;
  frac: number;
}) {
  const tone = side === "bid" ? "text-bid" : "text-ask";
  const bar = side === "bid" ? "bg-bid/12" : "bg-ask/12";
  let running = 0;

  return (
    <>
      {rows.map((l) => {
        running += l.baseLots;
        return (
          <DepthRow
            key={l.priceInTicks}
            level={l}
            runningLots={running}
            mine={mine.has(l.priceInTicks)}
            tone={tone}
            bar={bar}
            px={px}
            maxLots={maxLots}
            frac={frac}
          />
        );
      })}
    </>
  );
}

/** A stable price level. New levels slide in; changing sizes count and flash. */
function DepthRow({
  level,
  runningLots,
  mine,
  tone,
  bar,
  px,
  maxLots,
  frac,
}: {
  level: Level;
  runningLots: number;
  mine: boolean;
  tone: string;
  bar: string;
  px: (t: any) => number;
  maxLots: number;
  frac: number;
}) {
  const size = useTweened(level.baseLots * frac, 280) ?? level.baseLots * frac;
  const total = useTweened(runningLots * frac, 280) ?? runningLots * frac;
  const flash = useTickFlash(level.baseLots);

  return (
    <div className="relative grid grid-cols-3 px-3 py-[3px] text-[11px] row-hover row-in">
      <div
        className={`absolute inset-y-0 right-0 depth-bar ${bar}`}
        style={{ width: `${Math.min(100, (level.baseLots / maxLots) * 100)}%` }}
      />
      <span className={`relative tnum font-medium ${tone}`}>
        {px(level.priceInTicks).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
      <span
        key={flash.key}
        className={`relative tnum text-right text-text px-1 -mr-1 ${
          flash.dir === "up" ? "flash-up" : flash.dir === "down" ? "flash-down" : ""
        }`}
      >
        {size.toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </span>
      <span className="relative tnum text-right text-muted">
        {total.toLocaleString(undefined, { maximumFractionDigits: 3 })}
        {/* Only the trader can tell which levels carry their own size. */}
        {mine && <span className="text-phoenix/80 ml-1 text-[9px]">yours</span>}
      </span>
    </div>
  );
}

function TradesView({ anqa, tick }: { anqa: Anqa; tick: any }) {
  const frac = lotFraction(anqa.market);
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
          anqa.tape.map((p, i) => (
            <div key={p.seq} className={`grid grid-cols-3 px-3 py-[3px] text-[11px] ${i === 0 ? "print-in" : ""}`}>
              <span className="tnum text-bright">
                {(ticksToUsd(p.priceInTicks, tick) / frac).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}
              </span>
              <span className="tnum text-right text-muted">
                {(p.baseLots * frac).toLocaleString(undefined, { maximumFractionDigits: 4 })}
              </span>
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
