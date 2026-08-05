"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "./ui";
import { lotFraction } from "@/lib/anqa";
import { MARKETS } from "@/lib/markets";
import { AssetIcon, MarketPicker } from "./MarketPicker";
import { usePythLive } from "@/lib/usePyth";
import { useTickFlash, useTweened } from "@/lib/useLive";
import { use24h } from "@/lib/use24h";
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
  // The day's range, off the same Pyth history the chart and the mark come from.
  const day = use24h(anqa.marketInfo.pythSymbol);

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
    <div className="shrink-0 flex items-center gap-6 h-14 px-4 border-b border-line-soft bg-ink overflow-x-auto">
      {/* pair + lead price, the way a perp terminal opens — the market you are
          on and the number it trades at, together on the left. */}
      <div className="flex items-center gap-3 shrink-0 pr-6 border-r border-line-soft h-9">
        <MarketSelect current={anqa.marketInfo.id} onSelect={onSelectMarket} />
        <span className="text-[10px] uppercase tracking-[0.12em] text-dim">Perp</span>
        <span
          key={index ?? 0}
          className={`tnum text-[17px] font-semibold leading-none ${
            dir === "up" ? "text-bid tick-up" : dir === "down" ? "text-ask tick-down" : "text-bright"
          }`}
        >
          {index === null
            ? "—"
            : index.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        {live !== null && (
          <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" title="Live index" />
        )}
      </div>

      <LiveStat label="Mark" value={mark} tone="phoenix" decimals={2} />
      <DayStat day={day} />
      <LiveStat label="24h high" value={day?.high ?? null} decimals={2} />
      <LiveStat label="24h low" value={day?.low ?? null} decimals={2} />
      <LiveStat label="Open interest" value={oiUsd} prefix="$" decimals={0} />
      <PopStat label="Fills" value={anqa.tape.length ? anqa.tapeCount : 0} />
      <PopStat
        label="Resting"
        value={anqa.hiddenBids + anqa.hiddenAsks + anqa.myBids.length + anqa.myAsks.length}
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

  // Hover opens it, with intent on both sides: a short delay before opening so
  // the panel does not flash as the cursor crosses the header on its way
  // somewhere else, and a grace period on leaving so it survives the diagonal
  // trip from the ticker down into the list.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>();
  // Measured on open rather than held in state: the header does not move
  // while the panel is up, and reading it once avoids a resize listener.
  const measure = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.left, bottom: r.bottom });
  };
  const arm = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <div
      className="relative"
      onMouseEnter={() => arm(() => { measure(); setOpen(true); }, 120)}
      onMouseLeave={() => arm(() => setOpen(false), 180)}
    >
      <button
        ref={trigger}
        onClick={() => { measure(); setOpen((o) => !o); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="h-8 pl-3 pr-2 flex items-center gap-2 bg-void border border-line rounded-lg text-[13px] font-semibold text-bright hover:bg-raised transition-colors"
      >
        <AssetIcon base={selected.base} size={16} />
        {selected.symbol}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`text-dim transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
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
        <MarketPicker
          current={current}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          onHoverIn={() => timer.current && clearTimeout(timer.current)}
          onHoverOut={() => arm(() => setOpen(false), 180)}
          anchor={anchor}
        />
      )}
    </div>
  );
}

/** The day's move, signed and coloured — the first thing a trader reads after
 *  the price itself. Absent rather than zeroed when history has not loaded. */
function DayStat({ day }: { day: ReturnType<typeof use24h> }) {
  const up = (day?.changePct ?? 0) >= 0;
  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">24h change</span>
      <span
        className={`tnum text-[13px] font-medium leading-none ${
          day === null ? "text-dim" : up ? "text-bid" : "text-ask"
        }`}
      >
        {day === null
          ? "—"
          : `${up ? "+" : "−"}${Math.abs(day.changePct).toFixed(2)}%`}
      </span>
    </div>
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
