"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_MARKET_ID, MARKETS } from "@/lib/markets";
import { Header } from "@/components/Header";
import { DepositModal } from "@/components/DepositModal";
import { MarketBar } from "@/components/MarketBar";
import { Chart } from "@/components/Chart";
import { OrderBook } from "@/components/OrderBook";
import { TradeForm } from "@/components/TradeForm";
import { BottomTabs } from "@/components/BottomTabs";
import { ProofPanel } from "@/components/ProofPanel";
import { useAnqa } from "@/lib/useAnqa";
import { lotFraction, ticksToUsd } from "@/lib/anqa";
import { useTweened } from "@/lib/useLive";

type Toast = { id: number; msg: string; err?: boolean };

/**
 * The terminal.
 *
 * Laid out the way a perp trader expects — chart centre, book beside it,
 * ticket right, positions below — so the one thing that *is* unusual reads
 * as a deliberate absence rather than a missing feature.
 *
 * Every cell is placed explicitly. Relying on grid auto-placement here put
 * panels in the wrong columns as soon as a row-span was involved.
 */
export default function Terminal() {
  const [mid, setMid] = useState<number>(DEFAULT_MARKET_ID);
  // Remember the trader's market across visits.
  useEffect(() => {
    const saved = Number(window.localStorage.getItem("anqa-market"));
    if (MARKETS.some((m) => m.id === saved)) setMid(saved);
  }, []);
  const selectMarket = useCallback((id: number) => {
    setMid(id);
    window.localStorage.setItem("anqa-market", String(id));
  }, []);
  const anqa = useAnqa(mid);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [depositOpen, setDepositOpen] = useState(false);

  const notify = useCallback((msg: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  return (
    <div className="flex flex-col h-dvh">
      <Header anqa={anqa} onDeposit={() => setDepositOpen(true)} />
      <MarketBar anqa={anqa} onSelectMarket={selectMarket} />

      {anqa.error && (
        <div className="shrink-0 px-4 py-1.5 bg-ask/10 border-b border-ask/25 text-[11px] text-ask">
          {anqa.error}
        </div>
      )}

      <main
        className="flex-1 min-h-0 grid gap-2 p-2
                   grid-cols-1
                   lg:grid-cols-[minmax(0,1fr)_300px_290px]
                   lg:grid-rows-[minmax(0,1.55fr)_minmax(0,1fr)]"
      >
        {/* The chart takes the room. The row under it is sized for its tab
            strip and a few rows of positions, not for the empty state — the
            price is what a trader looks at, and it was being given barely half
            the column while "no open positions" got the rest.

            A real floor, not just min-h-0: stacked on a narrow window the
            chart would otherwise collapse to nothing. */}
        <div className="rise-in enter-1 min-h-[420px] lg:min-h-0 lg:col-start-1 lg:row-start-1">
          <Chart anqa={anqa} />
        </div>

        <div className="rise-in enter-2 min-h-[320px] lg:min-h-0 lg:col-start-2 lg:row-start-1">
          <OrderBook anqa={anqa} />
        </div>

        <div className="rise-in enter-3 flex flex-col gap-2 min-h-0 lg:col-start-3 lg:row-start-1 lg:row-span-2">
          <TradeForm anqa={anqa} onDone={notify} onDeposit={() => setDepositOpen(true)} />
          <div className="hidden 2xl:block min-h-0 shrink-0">
            <ProofPanel anqa={anqa} />
          </div>
        </div>

        <div className="rise-in enter-4 min-h-[200px] lg:min-h-0 lg:col-start-1 lg:col-span-2 lg:row-start-2">
          <BottomTabs anqa={anqa} onDone={notify} onSelectMarket={selectMarket} onDeposit={() => setDepositOpen(true)} />
        </div>
      </main>

      <DepositModal
        anqa={anqa}
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        onDone={notify}
      />
      <Toasts toasts={toasts} />
      <Footer anqa={anqa} />
    </div>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-1.5 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast flex items-center gap-2 px-3.5 py-2 rounded-lg border text-[12px] shadow-lg shadow-black/40 backdrop-blur-sm ${
            t.err ? "bg-ask/12 border-ask/40 text-ask" : "bg-raised/95 border-bid/35 text-text"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.err ? "bg-ask" : "bg-bid"}`}
          />
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function Footer({ anqa }: { anqa: ReturnType<typeof useAnqa> }) {
  const [slot, setSlot] = useState<number | null>(null);

  useEffect(() => {
    const tick = () =>
      anqa.conns.er
        .getSlot()
        .then(setSlot)
        .catch(() => setSlot(null));
    tick();
    const t = setInterval(tick, 4000);
    return () => clearInterval(t);
  }, [anqa.conns]);

  // The chain doesn't pause between polls; neither should the number. A
  // linear tween across the poll interval reads as the slot simply ticking.
  const slotShown = useTweened(slot, 3800, true);
  const frac = anqa.market ? lotFraction(anqa.market) : 1;
  const tick = anqa.market?.tickSize ?? 1;

  return (
    <footer className="shrink-0 flex items-center gap-4 h-7 px-4 border-t border-line-soft text-[10px] text-dim">
      <span>
        rollup slot{" "}
        <span className="tnum text-muted">{slotShown === null ? "—" : Math.round(slotShown)}</span>
      </span>
      <span>
        market <span className="tnum text-muted">{anqa.marketId.toString()}</span>
      </span>
      {anqa.pendingFills > 0 && (
        <span className="text-phoenix/90 live-dot">
          {anqa.pendingFills} fill{anqa.pendingFills > 1 ? "s" : ""} awaiting settlement
        </span>
      )}
      {anqa.loading && <span className="text-phoenix/70">syncing…</span>}

      {/* the last few prints, drifting through — the venue's pulse */}
      {anqa.tape.length > 0 && (
        <span className="hidden md:flex items-center gap-3 ml-4 overflow-hidden">
          <span className="uppercase tracking-[0.1em] text-[9px]">tape</span>
          {anqa.tape.slice(0, 4).map((p) => (
            <span key={p.seq} className="print-in tnum text-muted whitespace-nowrap">
              {(ticksToUsd(p.priceInTicks, tick) / frac).toLocaleString(undefined, {
                minimumFractionDigits: 2,
              })}
              <span className="text-dim ml-1">
                ×{(p.baseLots * frac).toLocaleString(undefined, { maximumFractionDigits: 3 })}
              </span>
            </span>
          ))}
        </span>
      )}
      <span className="ml-auto">devnet</span>
    </footer>
  );
}
