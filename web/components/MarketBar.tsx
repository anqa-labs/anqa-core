"use client";

import { Badge } from "./ui";
import { usd } from "@/lib/anqa";
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
export function MarketBar({ anqa }: { anqa: Anqa }) {
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6;

  return (
    <div className="shrink-0 flex items-center gap-6 h-14 px-4 border-b border-line-soft bg-ink overflow-x-auto">
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="text-[15px] font-medium text-bright tracking-wide">BTC-PERP</span>
        <Badge tone="neutral">20x</Badge>
      </div>

      <Stat
        label="Mark"
        value={mark === null ? "—" : mark.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        tone="phoenix"
      />
      <Stat
        label="Index"
        value={mark === null ? "—" : mark.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        hint="pyth"
      />
      <Stat
        label="Open interest"
        value={anqa.openInterest === null ? "—" : `$${usd(anqa.openInterest)}`}
        hint="aggregate"
      />
      <Stat label="Fills" value={anqa.tape.length ? `${anqa.tapeCount}` : "0"} hint="on the tape" />
      <Stat
        label="Resting"
        value={`${anqa.hiddenBids + anqa.hiddenAsks + anqa.myBids.length + anqa.myAsks.length}`}
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

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "phoenix";
}) {
  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`tnum text-[13px] font-medium ${
            tone === "phoenix" ? "text-phoenix" : "text-text"
          }`}
        >
          {value}
        </span>
        {hint && <span className="text-[9px] text-dim">{hint}</span>}
      </div>
    </div>
  );
}
