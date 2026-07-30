"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { BookPanel } from "@/components/BookPanel";
import { TapePanel } from "@/components/TapePanel";
import { OrderEntry } from "@/components/OrderEntry";
import { AccountPanel } from "@/components/AccountPanel";
import { ProofPanel } from "@/components/ProofPanel";
import { PositionPanel } from "@/components/PositionPanel";
import { useAnqa } from "@/lib/useAnqa";

type Toast = { id: number; msg: string; err?: boolean };

/**
 * The terminal.
 *
 * Left, what you do. Centre, what you are allowed to see. Right, what the
 * world is told. The layout is the argument.
 */
export default function Terminal() {
  const anqa = useAnqa();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((msg: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <div className="flex flex-col h-dvh">
      <Header anqa={anqa} />

      {anqa.error && (
        <div className="shrink-0 px-4 py-1.5 bg-ask/10 border-b border-ask/25 text-[11px] text-ask">
          {anqa.error}
        </div>
      )}

      <main className="flex-1 min-h-0 grid gap-2 p-2 grid-cols-1 lg:grid-cols-[268px_minmax(0,1fr)_312px] lg:grid-rows-[minmax(0,1fr)_240px]">
        <div className="flex flex-col gap-2 min-h-0 lg:row-span-2">
          <OrderEntry anqa={anqa} onDone={notify} />
          <PositionPanel anqa={anqa} onDone={notify} />
        </div>

        <BookPanel anqa={anqa} />

        <div className="flex flex-col gap-2 min-h-0 lg:row-span-2">
          <TapePanel anqa={anqa} />
          <ProofPanel anqa={anqa} />
        </div>

        <div className="min-h-0">
          <AccountPanel anqa={anqa} onDone={notify} />
        </div>
      </main>

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
          className={`print-in px-3 py-1.5 rounded-md border text-[12px] backdrop-blur-sm ${
            t.err
              ? "bg-ask/12 border-ask/35 text-ask"
              : "bg-raised/95 border-line text-text"
          }`}
        >
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

  return (
    <footer className="shrink-0 flex items-center gap-4 h-7 px-4 border-t border-line-soft text-[10px] text-dim">
      <span>
        rollup slot <span className="tnum text-muted">{slot ?? "—"}</span>
      </span>
      <span>
        market <span className="tnum text-muted">{anqa.marketId.toString()}</span>
      </span>
      {anqa.loading && <span className="text-phoenix/70">syncing…</span>}
      <span className="ml-auto">devnet</span>
    </footer>
  );
}
