"use client";

import { useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Button } from "./ui";
import { readableError } from "@/lib/anqa";
import {
  authorizeWithdraw,
  cancelAll,
  cancelOrder,
  cancelTrigger,
  closePosition,
  placeTrigger,
  requestWithdraw,
  settleWithdraw,
  undelegatePortfolio,
} from "@/lib/actions";
import { ticksToUsd, usd, usdToTicks } from "@/lib/anqa";
import { readKernel } from "@/lib/portfolio";
import type { Anqa } from "@/lib/useAnqa";

const MINT = process.env.NEXT_PUBLIC_COLLATERAL_MINT
  ? new PublicKey(process.env.NEXT_PUBLIC_COLLATERAL_MINT)
  : null;

type Tab = "positions" | "orders" | "stops" | "balances";

/** Positions, working orders, stops, and the money — where a trader lives. */
export function BottomTabs({
  anqa,
  onDone,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("positions");
  const [busy, setBusy] = useState<string | null>(null);
  const owner = anqa.wallet?.publicKey;

  const kernel = useMemo(
    () => (anqa.portfolio ? readKernel(anqa.portfolio.inner) : null),
    [anqa.portfolio]
  );
  const position = kernel?.positions.find(
    (p) => p.assetIndex === (anqa.market?.assetIndex ?? 0)
  );
  const orders = [
    ...anqa.myBids.map((o) => ({ ...o, side: "bid" as const })),
    ...anqa.myAsks.map((o) => ({ ...o, side: "ask" as const })),
  ];
  const tick = anqa.market?.tickSize ?? 1;
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6;

  const run = async (label: string, layer: "base" | "er", fn: (p: any, c: any) => Promise<any>) => {
    const p = anqa.programFor(layer);
    if (!p || !owner) return;
    setBusy(label);
    try {
      await fn(p, { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner });
      onDone(`${label} done`);
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const counts: Record<Tab, number | null> = {
    positions: position ? 1 : 0,
    orders: orders.length,
    stops: anqa.triggers.length,
    balances: null,
  };

  return (
    <section className="flex flex-col min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
      <header className="flex items-center shrink-0 h-9 border-b border-line-soft overflow-x-auto">
        {(["positions", "orders", "stops", "balances"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-full px-3 text-[12px] font-medium capitalize whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t ? "border-phoenix text-bright" : "border-transparent text-dim hover:text-text"
            }`}
          >
            {t}
            {counts[t] !== null && ` (${counts[t]})`}
          </button>
        ))}
        {orders.length > 0 && (
          <button
            onClick={() => run("Cancel all", "er", cancelAll)}
            disabled={!!busy}
            className="ml-auto mr-3 text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
          >
            cancel all
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!anqa.wallet ? (
          <Empty>Connect a wallet.</Empty>
        ) : tab === "positions" ? (
          !position ? (
            <Empty>No open position.</Empty>
          ) : (
            <>
              <Head cols={["Market", "Side", "Size", "Unrealised", "Margin", ""]} />
              <div className="grid grid-cols-6 items-center px-3 py-2 text-[11px]">
                <span className="text-text">BTC-PERP</span>
                <span className={position.isLong ? "text-bid" : "text-ask"}>
                  {position.isLong ? "Long" : "Short"}
                </span>
                <span className="tnum text-text">{position.lots.toString()} lots</span>
                <span
                  className={`tnum ${
                    (kernel?.pnl ?? 0n) > 0n
                      ? "text-bid"
                      : (kernel?.pnl ?? 0n) < 0n
                        ? "text-ask"
                        : "text-muted"
                  }`}
                >
                  ${usd(kernel!.pnl.toString())}
                </span>
                <span className="tnum text-muted">
                  ${usd(kernel!.initialRequirement.toString())}
                </span>
                <span className="text-right">
                  <button
                    disabled={!!busy || mark === null}
                    onClick={() => {
                      const worst = position.isLong ? mark! * 0.96 : mark! * 1.04;
                      run("Close", "er", (p, c) =>
                        closePosition(p, c, new BN(usdToTicks(worst, tick)), new BN(0), [])
                      );
                    }}
                    className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
                  >
                    close
                  </button>
                </span>
              </div>
            </>
          )
        ) : tab === "orders" ? (
          orders.length === 0 ? (
            <Empty>No working orders.</Empty>
          ) : (
            <>
              <Head cols={["Market", "Side", "Price", "Size", "Visibility", ""]} />
              {orders.map((o, i) => (
                <div key={i} className="grid grid-cols-6 items-center px-3 py-2 text-[11px]">
                  <span className="text-text">BTC-PERP</span>
                  <span className={o.side === "bid" ? "text-bid" : "text-ask"}>
                    {o.side === "bid" ? "Buy" : "Sell"}
                  </span>
                  <span className="tnum text-text">
                    {ticksToUsd(o.priceInTicks, tick).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                    })}
                  </span>
                  <span className="tnum text-muted">{o.baseLots.toString()}</span>
                  <span className="text-phoenix/90 text-[10px]">
                    {anqa.market?.dark ? "hidden" : "visible"}
                  </span>
                  <span className="text-right">
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        run("Cancel", "er", (p, c) => cancelOrder(p, c, o.side, o.clientOrderId))
                      }
                      className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
                    >
                      cancel
                    </button>
                  </span>
                </div>
              ))}
            </>
          )
        ) : tab === "stops" ? (
          <StopsTab anqa={anqa} position={position} busy={busy} run={run} onDone={onDone} />
        ) : (
          <BalancesTab anqa={anqa} kernel={kernel} busy={busy} setBusy={setBusy} onDone={onDone} />
        )}
      </div>
    </section>
  );
}

function StopsTab({ anqa, position, busy, run, onDone }: any) {
  const [stop, setStop] = useState("");
  const tick = anqa.market?.tickSize ?? 1;
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6;

  return (
    <>
      {position && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line-soft">
          <input
            value={stop}
            onChange={(e) => setStop(e.target.value)}
            placeholder={mark ? (mark * (position.isLong ? 0.97 : 1.03)).toFixed(2) : "0.00"}
            inputMode="decimal"
            className="tnum w-32 h-7 bg-void border border-line rounded px-2 text-[11px] text-bright outline-none focus:border-phoenix-soft placeholder:text-dim/60"
          />
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => {
              const p = Number(stop);
              if (!p) return onDone("Stop price required", true);
              run("Stop armed", "er", (prog: any, c: any) =>
                placeTrigger(prog, c, {
                  triggerId: new BN(Date.now() % 1_000_000),
                  triggerPrice: new BN(Math.round(p * 1e6)),
                  direction: position.isLong ? "below" : "above",
                  limitPriceInTicks: new BN(
                    usdToTicks(position.isLong ? p * 0.97 : p * 1.03, tick)
                  ),
                  maxBaseLots: new BN(0),
                })
              );
              setStop("");
            }}
          >
            Arm stop
          </Button>
          <span className="text-[10px] text-dim ml-1">
            lives in your account — travels into the rollup with it
          </span>
        </div>
      )}
      {anqa.triggers.length === 0 ? (
        <Empty>{position ? "No stop set." : "Open a position to protect it."}</Empty>
      ) : (
        <>
          <Head cols={["Type", "Trigger", "Fires", "", "", ""]} />
          {anqa.triggers.map((t: any) => (
            <div key={t.id} className="grid grid-cols-6 items-center px-3 py-2 text-[11px]">
              <span className="text-text">{t.direction === "below" ? "Stop loss" : "Take profit"}</span>
              <span className="tnum text-text">${usd(t.price.toString())}</span>
              <span className="text-muted text-[10px]">
                when mark goes {t.direction}
              </span>
              <span />
              <span />
              <span className="text-right">
                <button
                  disabled={!!busy}
                  onClick={() => run("Cancelled", "er", (p: any, c: any) => cancelTrigger(p, c, new BN(t.id)))}
                  className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
                >
                  cancel
                </button>
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function BalancesTab({ anqa, kernel, busy, setBusy, onDone }: any) {
  const [amount, setAmount] = useState("");
  const owner = anqa.wallet?.publicKey;
  const deposited = anqa.ledger ? Number(anqa.ledger.deposited.toString()) : 0;
  const withdrawn = anqa.ledger ? Number(anqa.ledger.withdrawn.toString()) : 0;

  /** Withdrawal is three legs across two layers; drive them in order. */
  const exit = async () => {
    const n = Number(amount);
    if (!n || !MINT || !owner) return onDone("Amount required", true);
    const base = anqa.programFor("base");
    const er = anqa.programFor("er");
    if (!base || !er) return;
    const c = { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner };
    setBusy("Withdraw");
    try {
      await requestWithdraw(base, c, MINT, new BN(Math.round(n * 1e6)));
      onDone("Requested — the kernel is judging it");
      await authorizeWithdraw(er, c);
      onDone("Authorized — the receipt is coming home");
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const info = await anqa.conns.base.getAccountInfo(anqa.acc.withdrawReceiptOf(owner));
        if (!info) break;
        if (info.owner.equals(base.programId)) {
          await settleWithdraw(base, c, MINT);
          break;
        }
      }
      onDone("Withdrawn");
      anqa.refresh();
      setAmount("");
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const run = async (label: string, layer: "base" | "er", fn: any) => {
    const p = anqa.programFor(layer);
    if (!p || !owner) return;
    setBusy(label);
    try {
      await fn(p, { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner });
      onDone(`${label} done`);
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-3 flex flex-wrap items-end gap-6">
      <Figure label="Capital" value={kernel ? `$${usd(kernel.capital.toString())}` : "—"} hint="in the rollup" />
      <Figure label="Deposited" value={`$${usd(deposited)}`} hint="lifetime, on base" />
      <Figure label="Withdrawn" value={`$${usd(withdrawn)}`} hint="lifetime" />
      <div className="flex items-center gap-1.5">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className="tnum w-28 h-8 bg-void border border-line rounded px-2 text-[12px] text-bright outline-none focus:border-phoenix-soft placeholder:text-dim/60"
        />
        <Button size="sm" variant="ghost" disabled={!!busy || !anqa.portfolio} onClick={exit}>
          {busy === "Withdraw" ? "Withdrawing…" : "Withdraw"}
        </Button>
        {anqa.portfolioDelegated && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => run("End session", "er", undelegatePortfolio)}
          >
            End session
          </Button>
        )}
      </div>
      {busy === "Withdraw" && (
        <p className="w-full text-[10px] text-phoenix/80">
          Crossing the boundary: the rollup decides, the receipt commits home, base pays out.
          About two minutes on the shared validator.
        </p>
      )}
    </div>
  );
}

function Head({ cols }: { cols: string[] }) {
  return (
    <div className="grid grid-cols-6 px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-dim border-b border-line-soft sticky top-0 bg-ink">
      {cols.map((c, i) => (
        <span key={i} className={i === cols.length - 1 ? "text-right" : ""}>
          {c}
        </span>
      ))}
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">{label}</span>
      <span className="tnum text-[14px] text-bright">{value}</span>
      {hint && <span className="text-[9px] text-dim">{hint}</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-20 grid place-items-center">
      <p className="text-[11px] text-dim">{children}</p>
    </div>
  );
}
