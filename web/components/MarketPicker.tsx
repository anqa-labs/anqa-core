"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BN } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { anqaAccounts, ER_RPC } from "@/lib/anqa";
import { MARKETS, type MarketInfo } from "@/lib/markets";
import { usePythLive } from "@/lib/usePyth";

/**
 * The market picker.
 *
 * A venue with nine listings needs more than a list of tickers: the choice
 * is made on price and how the day has gone, so those travel with the name.
 * Prices stream from the same Pyth feeds the venue marks against — the same
 * source as the chart — and the day's change comes from that feed's own
 * history rather than a lookalike borrowed from elsewhere.
 *
 * Keyboard-first, because anyone switching markets often is not reaching for
 * a mouse: type to filter, arrows to move, enter to take it, escape to leave.
 */
export function MarketPicker({
  current,
  onSelect,
  onClose,
  onHoverIn,
  onHoverOut,
  anchor,
}: {
  current: number;
  onSelect: (id: number) => void;
  onClose: () => void;
  /** Hover intent, so the panel survives the cursor travelling into it. */
  onHoverIn?: () => void;
  onHoverOut?: () => void;
  /** Where the trigger sits, in viewport coordinates. */
  anchor?: { left: number; bottom: number };
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [changes, setChanges] = useState<Record<number, number | null>>({});
  const [marks, setMarks] = useState<Record<number, number | null>>({});
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? MARKETS.filter(
          (m) => m.symbol.toLowerCase().includes(q) || m.base.toLowerCase().includes(q)
        )
      : MARKETS;
  }, [query]);

  // Keep the cursor on a row that still exists as the filter narrows.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // The day's move, from the venue's own feed history. One request per
  // market, once — this panel is not open for long.
  useEffect(() => {
    let stop = false;
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 30;
    Promise.all(
      MARKETS.map(async (m) => {
        try {
          const r = await fetch(
            `/api/candles?resolution=60&from=${from}&to=${to}&symbol=${encodeURIComponent(m.pythSymbol)}`
          );
          const { candles } = await r.json();
          if (!candles?.length) return [m.id, null] as const;
          const last = candles[candles.length - 1];
          const dayAgo = candles[Math.max(0, candles.length - 25)];
          if (!dayAgo?.open) return [m.id, null] as const;
          return [m.id, ((last.close - dayAgo.open) / dayAgo.open) * 100] as const;
        } catch {
          return [m.id, null] as const;
        }
      })
    ).then((pairs) => {
      if (!stop) setChanges(Object.fromEntries(pairs));
    });
    return () => {
      stop = true;
    };
  }, []);

  // The venue's own mark, beside the index it is derived from — the pair a
  // trader on a dark market actually wants to compare. One batched read.
  useEffect(() => {
    const conn = new Connection(ER_RPC, "confirmed");
    const keys = MARKETS.map((m) => anqaAccounts(new BN(m.id), new BN(m.groupId)).oracleState);
    let stop = false;
    const tick = async () => {
      const infos = await conn.getMultipleAccountsInfo(keys).catch(() => []);
      if (stop) return;
      const next: Record<number, number | null> = {};
      MARKETS.forEach((m, i) => {
        const info = (infos as any[])[i];
        next[m.id] = info ? Number(info.data.readBigUInt64LE(16)) / 1e6 / m.lotFrac : null;
      });
      setMarks(next);
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, rows.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter" && rows[cursor]) {
        onSelect(rows[cursor].id);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, onSelect, onClose]);

  // Anchored to the trigger, not thrown over the whole screen. Switching
  // market is a glance and a click, so the venue behind it should stay
  // visible — a full-screen sheet makes a small choice feel like leaving the
  // terminal. The panel grows out of the ticker it belongs to.
  // Rendered at the document root, not inside the header.
  //
  // `z-index` only competes within its own stacking context, and the header
  // sits in one — so however high the panel bid, the chart and the book still
  // painted over it. A portal takes it out of that argument entirely; the
  // trigger's rect is passed in because the panel no longer shares a
  // coordinate space with it.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed z-[100] origin-top-left animate-picker"
      style={{ left: anchor?.left ?? 16, top: (anchor?.bottom ?? 60) + 6 }}
      onMouseEnter={onHoverIn}
      onMouseLeave={onHoverOut}
    >
      <div className="w-[min(940px,92vw)] bg-ink border border-line rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.6)] overflow-hidden">
        {/* search */}
        <div className="flex items-center gap-2.5 h-12 px-4 border-b border-line-soft">
          <svg width="14" height="14" viewBox="0 0 14 14" className="text-dim shrink-0">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M9.5 9.5 L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search markets"
            className="flex-1 bg-transparent text-[13px] text-bright outline-none placeholder:text-dim/70"
          />
        </div>

        {/* column heads */}
        <div className="grid grid-cols-[1.6fr_1fr_1fr_1.2fr] items-center px-4 h-9 text-[11px] text-dim border-b border-line-soft picker-row">
          <span>Market</span>
          <span className="text-right">Price</span>
          <span className="text-right">24h change</span>
          <span className="text-right">Venue mark</span>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto">
          {rows.length === 0 && (
            <p className="px-4 py-6 text-[12px] text-dim">No market matches “{query}”.</p>
          )}
          {rows.map((m, i) => (
            <Row
              key={m.id}
              market={m}
              change={changes[m.id] ?? null}
              mark={marks[m.id] ?? null}
              selected={m.id === current}
              active={i === cursor}
              onHover={() => setCursor(i)}
              onPick={() => {
                onSelect(m.id);
                onClose();
              }}
            />
          ))}
        </div>

        {/* keyboard hints, the way a terminal does it */}
        <div className="flex items-center gap-4 h-9 px-4 border-t border-line-soft text-[10px] text-dim">
          <Hint keys={["↑", "↓"]} label="Navigate" />
          <Hint keys={["Enter"]} label="Select" />
          <Hint keys={["Esc"]} label="Close" />
        </div>
      </div>
    </div>,
    document.body
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {keys.map((k) => (
        <kbd
          key={k}
          className="grid place-items-center h-4 min-w-4 px-1 rounded bg-void border border-line text-[9px] text-muted"
        >
          {k}
        </kbd>
      ))}
      {label}
    </span>
  );
}

function Row({
  market,
  change,
  mark,
  selected,
  active,
  onHover,
  onPick,
}: {
  market: MarketInfo;
  change: number | null;
  mark: number | null;
  selected: boolean;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  // The same stream the chart and the stats strip read — one subscription
  // per feed, shared, so nine rows cost nine feeds and not nine connections.
  const price = usePythLive(market.pythFeedId);
  const up = (change ?? 0) >= 0;

  return (
    <button
      onMouseEnter={onHover}
      onClick={onPick}
      className={`picker-row w-full grid grid-cols-[1.6fr_1fr_1fr_1.2fr] items-center px-4 py-2.5 text-[12px] text-left ${
        active ? "bg-raised" : "hover:bg-raised/60"
      } ${selected ? "shadow-[inset_2px_0_0_var(--color-phoenix)]" : ""}`}
    >
      <span className="flex items-center gap-2.5">
        <span className="grid place-items-center h-6 w-6 rounded-full bg-void border border-line text-[9px] font-semibold text-muted">
          {market.base.slice(0, 3)}
        </span>
        <span className="font-medium text-bright">{market.base}</span>
        <span className="h-4 px-1.5 grid place-items-center rounded bg-void border border-line text-[9px] text-dim">
          20x
        </span>
      </span>

      <span className="tnum text-right text-text">
        {price === null
          ? "—"
          : price.toLocaleString(undefined, {
              minimumFractionDigits: price < 1 ? 4 : 2,
              maximumFractionDigits: price < 1 ? 4 : 2,
            })}
      </span>

      <span className={`tnum text-right ${change === null ? "text-dim" : up ? "text-bid" : "text-ask"}`}>
        {change === null ? "—" : `${up ? "▲" : "▼"} ${Math.abs(change).toFixed(2)}%`}
      </span>

      <span className="tnum text-right text-muted">
        {mark === null
          ? "—"
          : mark.toLocaleString(undefined, {
              minimumFractionDigits: mark < 1 ? 4 : 2,
              maximumFractionDigits: mark < 1 ? 4 : 2,
            })}
      </span>
    </button>
  );
}
