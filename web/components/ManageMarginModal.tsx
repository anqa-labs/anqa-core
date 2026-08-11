"use client";

import { useEffect, useState } from "react";
import type { CrossPosition } from "@/lib/useAllPositions";
import {
  collateralOfRaw,
  committedTotalRaw,
  equity,
  readKernel,
  reservedOfRaw,
  PF_INNER,
} from "@/lib/portfolio";
import type { Anqa } from "@/lib/useAnqa";

// Mirror the program's gates so the modal predicts, and the program decides.
const MAINT_FRAC = 0.025;
const INITIAL_FRAC = 0.05;

/**
 * Flash-style collateral management for one open position.
 *
 * Isolated margin means a position's liquidation price is a function of the
 * collateral behind it and nothing else — so this modal is really a
 * liquidation-price editor. Everything it shows is a client-side prediction;
 * the program re-derives all of it against the live mark and refuses anything
 * unsafe, so the worst a stale preview can do is produce a readable error.
 */
export function ManageMarginModal({
  row,
  anqa,
  busy,
  onSubmit,
  onClose,
}: {
  row: CrossPosition;
  anqa: Anqa;
  busy: string | null;
  onSubmit: (mode: "add" | "remove", usd: number) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  // Live account numbers, polled like the deposit modal: the program judges
  // against its own refresh, this only keeps the "max" honest.
  const [free, setFree] = useState(0);
  const [committed, setCommitted] = useState(row.legMarginUsd);

  const owner = anqa.wallet?.publicKey;
  useEffect(() => {
    if (!owner) return;
    let stop = false;
    const tick = async () => {
      const info = await anqa.conns.er
        .getAccountInfo(anqa.acc.portfolioOf(owner))
        .catch(() => null);
      if (!info || stop) return;
      const data = Uint8Array.from(info.data);
      const eq = Number(equity(readKernel(data.subarray(PF_INNER)))) / 1e6;
      setFree(
        Math.max(0, eq - committedTotalRaw(data) - reservedOfRaw(data))
      );
      setCommitted(collateralOfRaw(data, row.market.assetIndex));
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58(), row.market.id]);

  const n = Number(amount) || 0;
  const mark = row.mark ?? row.entry ?? 0;
  const pnl =
    row.entry !== null && row.mark !== null
      ? (row.isLong ? row.mark - row.entry : row.entry - row.mark) * row.size
      : 0;
  // What the program will allow out: remainder + pnl must clear initial
  // margin at the mark. Same inequality, solved for the amount.
  const maxRemove = Math.max(
    0,
    Math.min(committed, committed + pnl - mark * row.size * INITIAL_FRAC)
  );
  const cap = mode === "add" ? free : maxRemove;

  const next = mode === "add" ? committed + n : committed - n;
  const projectedLiq =
    row.entry !== null && row.size > 0 && next > 0
      ? row.isLong
        ? (row.entry - next / row.size) / (1 - MAINT_FRAC)
        : (row.entry + next / row.size) / (1 + MAINT_FRAC)
      : null;
  const showLiq = (v: number | null) =>
    v === null || v <= 0
      ? "—"
      : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const overCap = n > cap + 1e-9;
  const label =
    mode === "add"
      ? overCap
        ? "Not enough free collateral"
        : "Add collateral"
      : overCap
        ? "Would breach initial margin"
        : "Remove collateral";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="w-full max-w-md bg-ink border border-line rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.6)] overflow-hidden">
        <header className="flex items-center h-11 px-4 border-b border-line-soft">
          <span className="text-[13px] font-semibold text-bright">
            {row.market.symbol} margin
          </span>
          <span
            className={`ml-2 inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold ${
              row.isLong ? "bg-bid/12 text-bid" : "bg-ask/12 text-ask"
            }`}
          >
            {row.isLong ? "Long" : "Short"}
          </span>
          <button
            onClick={() => !busy && onClose()}
            className="ml-auto h-7 w-7 grid place-items-center rounded text-dim hover:text-text hover:bg-raised transition-colors"
          >
            ✕
          </button>
        </header>

        <div className="p-4 flex flex-col gap-3">
          <div className="flex p-0.5 bg-void border border-line rounded-lg">
            {(["add", "remove"] as const).map((m) => (
              <button
                key={m}
                disabled={!!busy}
                onClick={() => {
                  setMode(m);
                  setAmount("");
                }}
                className={`flex-1 h-8 text-[12px] rounded-md capitalize transition-colors ${
                  mode === m ? "bg-line text-bright" : "text-dim hover:text-text"
                }`}
              >
                {m} collateral
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 h-11 px-3 bg-void border border-line rounded-lg focus-within:border-phoenix-soft transition-colors">
            <input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className="tnum flex-1 min-w-0 bg-transparent text-[16px] text-bright outline-none placeholder:text-dim/50"
            />
            <button
              onClick={() => setAmount(cap > 0 ? cap.toFixed(2) : "")}
              className="text-[10px] text-phoenix/80 hover:text-phoenix transition-colors"
            >
              max
            </button>
            <span className="text-[11px] text-dim">USDC</span>
          </div>

          {/* before → after, the two numbers this action exists to move */}
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1.5 text-[11px] px-0.5">
            <span className="text-dim">
              {mode === "add" ? "Free collateral" : "Removable now"}
            </span>
            <span />
            <span className="tnum text-right text-text">
              ${cap.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>

            <span className="text-dim">Position margin</span>
            <span className="tnum text-right text-muted">
              ${committed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="tnum text-right text-bright">
              {n > 0 && !overCap
                ? `→ $${next.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : ""}
            </span>

            <span className="text-dim">Liq. price (est.)</span>
            <span className="tnum text-right text-ask/80">
              {showLiq(row.liq)}
            </span>
            <span className="tnum text-right text-bright">
              {n > 0 && !overCap ? `→ ${showLiq(projectedLiq)}` : ""}
            </span>
          </div>

          <button
            className="cta cta-primary w-full h-10 text-[13px]"
            disabled={!!busy || n <= 0 || overCap}
            onClick={() => onSubmit(mode, n)}
          >
            {busy ? `${busy}…` : label}
          </button>

          <p className="text-[10px] text-dim leading-relaxed pt-1 border-t border-line-soft">
            No tokens move — collateral shifts between your account&apos;s free
            balance and this position, privately, inside the rollup. Removal is
            refused by the program if the position would fall below initial
            margin at the live mark.
          </p>
        </div>
      </div>
    </div>
  );
}
