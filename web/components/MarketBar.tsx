"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "./ui";
import { lotFraction } from "@/lib/anqa";
import { MARKETS } from "@/lib/markets";
import { MarketPicker } from "./MarketPicker";
import { usePythLive } from "@/lib/usePyth";
import { useTickFlash, useTweened } from "@/lib/useLive";
import type { Anqa } from "@/lib/useAnqa";

/**
 * The stats strip.
 *
 * Every figure here is one a dark venue can publish honestly. Open interest
 * is aggregate by design — the kernel tracks it per asset, and publishing the
 * total tells you the venue's size without telling you anyone's position.
 * Where a number genuinely is not available yet, it says so rather than
 * inventing one.
 */
export function MarketBar({
  anqa,
  onSelectMarket,
}: {
  anqa: Anqa;
  onSelectMarket: (id: number) => void;
}) {
  // The mark is quote atoms per lot; the strip shows per-BTC. Open interest
  // arrives as aggregate lots and becomes notional at the per-lot mark.
  const frac = lotFraction(anqa.market);
  const perLot = anqa.markPrice === null ? null : anqa.markPrice / 1e6;
  const mark = perLot === null ? null : perLot / frac;
  // Streamed sub-second; the venue's posted mark follows it on the next relay.
  const live = usePythLive(anqa.marketInfo.pythFeedId);
  const index = live ?? mark;
  const oiUsd =
    anqa.openInterest === null || perLot === null
      ? null
      : Number(anqa.openInterest) * perLot;

  // Directional feedback: color the index by its last move, flash on ticks.
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (index === null) return;
    if (prev.current !== null && index !== prev.current) {
      setDir(index > prev.current ? "up" : "down");
    }
    prev.current = index;
  }, [index]);

  return (
    <div className="shrink-0 flex items-center gap-5 h-14 px-4 border-b border-line-soft bg-ink overflow-x-auto">
      <div className="flex items-center gap-2.5 shrink-0 pr-5 border-r border-line-soft h-8">
        <MarketSelect current={anqa.marketInfo.id} onSelect={onSelectMarket} />
        <Badge tone="neutral">20x</Badge>
      </div>

      {/* the price — the one number that leads the room */}
      <div className="flex flex-col gap-0.5 shrink-0">
        <span className="text-[10px] uppercase tracking-[0.1em] text-dim">
          Index {live !== null && <span className="text-bid">· live</span>}
        </span>
        <span
          key={index ?? 0}
          className={`tnum text-[16px] font-semibold leading-none ${
            dir === "up" ? "text-bid tick-up" : dir === "down" ? "text-ask tick-down" : "text-bright"
          }`}
        >
          {index === null ? "—" : index.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>

      <LiveStat label="Mark" value={mark} tone="phoenix" decimals={2} />
      <LiveStat label="Open interest" value={oiUsd} hint="aggregate" prefix="$" decimals={0} />
      <PopStat label="Fills" value={anqa.tape.length ? anqa.tapeCount : 0} hint="on the tape" />
      <PopStat
        label="Resting"
        value={anqa.hiddenBids + anqa.hiddenAsks + anqa.myBids.length + anqa.myAsks.length}
        hint="orders, unreadable"
      />

      <div className="ml-auto flex items-center gap-2 shrink-0">
        {anqa.market?.dark && <Badge tone="dark">dark book</Badge>}
        {anqa.delegated ? (
          <Badge tone="live">
            <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" />
            rollup
          </Badge>
        ) : (
          <Badge tone="neutral">base</Badge>
        )}
        {anqa.market?.paused && <Badge tone="warn">paused</Badge>}
      </div>
    </div>
  );
}

/** The trigger. Shows where you are; the panel does the choosing. */
function MarketSelect({
  current,
  onSelect,
}: {
  current: number;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = MARKETS.find((m) => m.id === current) ?? MARKETS[0];

  // "/" opens it from anywhere, the way a terminal does — unless the trader
  // is already typing into something.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="h-8 pl-3 pr-2 flex items-center gap-2 bg-void border border-line rounded-lg text-[13px] font-semibold text-bright hover:bg-raised transition-colors"
      >
        {selected.symbol}
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-dim">
          <path
            d="M2 3.5 L5 6.5 L8 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <MarketPicker current={current} onSelect={onSelect} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** A stat that glides between values and flashes the direction it moved. */
function LiveStat({
  label,
  value,
  hint,
  prefix = "",
  decimals = 2,
  tone = "default",
}: {
  label: string;
  value: number | null;
  hint?: string;
  prefix?: string;
  decimals?: number;
  tone?: "default" | "phoenix";
}) {
  const shown = useTweened(value);
  const flash = useTickFlash(value);
  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span
          key={flash.key}
          className={`tnum text-[13px] font-medium leading-none px-0.5 -mx-0.5 ${
            tone === "phoenix" ? "text-phoenix" : "text-text"
          } ${flash.dir === "up" ? "flash-up" : flash.dir === "down" ? "flash-down" : ""}`}
        >
          {shown === null
            ? "—"
            : `${prefix}${shown.toLocaleString(undefined, {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
              })}`}
        </span>
        {hint && <span className="text-[9px] text-dim">{hint}</span>}
      </div>
    </div>
  );
}

/** A count that pops once whenever it changes. */
function PopStat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span key={value} className="badge-pop tnum text-[13px] font-medium leading-none text-text">
          {value}
        </span>
        {hint && <span className="text-[9px] text-dim">{hint}</span>}
      </div>
    </div>
  );
}
