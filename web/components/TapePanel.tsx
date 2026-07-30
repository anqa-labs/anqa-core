"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Empty, Panel } from "./ui";
import { ticksToUsd } from "@/lib/anqa";
import type { Anqa } from "@/lib/useAnqa";

/**
 * The tape — everything the world is ever told.
 *
 * Price, size, sequence, time. No maker, no taker, no side, no order id.
 * It is an account rather than an event stream because inside a private
 * rollup even transaction logs are permission-gated; the tape is committed
 * to base chain so the public record survives people who never touch the
 * rollup at all.
 */
export function TapePanel({ anqa }: { anqa: Anqa }) {
  const tick = anqa.market?.tickSize ?? 1;
  const [freshSeq, setFreshSeq] = useState<number | null>(null);
  const lastSeen = useRef(0);

  useEffect(() => {
    const top = anqa.tape[0]?.seq ?? 0;
    if (top > lastSeen.current) {
      lastSeen.current = top;
      setFreshSeq(top);
      const t = setTimeout(() => setFreshSeq(null), 800);
      return () => clearTimeout(t);
    }
  }, [anqa.tape]);

  return (
    <Panel
      title="tape"
      right={
        <Badge tone="neutral">
          <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" />
          public
        </Badge>
      }
      bodyClassName="flex flex-col overflow-hidden"
    >
      <div className="grid grid-cols-[auto_1fr_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-dim border-b border-line-soft">
        <span className="w-8">#</span>
        <span>price</span>
        <span className="text-right">size</span>
      </div>

      {anqa.tape.length === 0 ? (
        <Empty>
          Nothing has printed yet. When a hidden order fills, this is the only
          place it shows up.
        </Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {anqa.tape.map((p) => (
            <div
              key={p.seq}
              className={`grid grid-cols-[auto_1fr_auto] gap-3 items-baseline px-3 py-[5px] text-[12px] ${
                p.seq === freshSeq ? "print-in" : ""
              }`}
            >
              <span className="tnum w-8 text-[10px] text-dim">{p.seq}</span>
              <span className="tnum text-bright">
                {ticksToUsd(p.priceInTicks, tick).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}
              </span>
              <span className="tnum text-right text-muted">{p.baseLots}</span>
            </div>
          ))}
        </div>
      )}

      {anqa.pendingFills > 0 && (
        <footer className="shrink-0 px-3 py-1.5 border-t border-line-soft text-[10px] text-phoenix/90">
          {anqa.pendingFills} matched fill{anqa.pendingFills > 1 ? "s" : ""} awaiting
          settlement
        </footer>
      )}
    </Panel>
  );
}
