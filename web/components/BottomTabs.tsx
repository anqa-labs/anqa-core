"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Button } from "./ui";
import { readableError } from "@/lib/anqa";
import {
  cancelAll,
  cancelOrder,
  cancelTrigger,
  closePosition,
  grantSessionOnly,
  placeTrigger,
} from "@/lib/actions";
import { anqaAccounts, lotFraction, ticksToUsd, usdToTicks } from "@/lib/anqa";
import { walletUsdc } from "@/lib/margin";
import { MARKETS } from "@/lib/markets";
import { equity, readKernel, PF_INNER } from "@/lib/portfolio";
import { useAllOrders, type CrossOrder } from "@/lib/useAllOrders";
import { useAllPositions, type CrossPosition } from "@/lib/useAllPositions";
import { useTickFlash, useTweened } from "@/lib/useLive";
import { usePythLive } from "@/lib/usePyth";
import {
  SESSION_DURATION_SECS,
  sessionGrantIsFresh,
  waitForSessionGrant,
} from "@/lib/session";
import type { TradeSubmission } from "@/lib/tradeActivity";
import type { Anqa } from "@/lib/useAnqa";

// Each market has its own collateral mint; resolved from the registry.

type Tab = "positions" | "orders" | "resting" | "account";

/** Positions, working orders, stops, and the money — where a trader lives. */
export function BottomTabs({
  anqa,
  onDone,
  onSelectMarket,
  onDeposit,
  submissions,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
  onSelectMarket: (id: number) => void;
  /** Opens the deposit/withdraw dialog — the one place money moves. */
  onDeposit: () => void;
  submissions: TradeSubmission[];
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
  const frac = lotFraction(anqa.market);
  /** Per-lot USD — the unit the chain speaks; convert before showing. */
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6;

  // Live unrealised PnL: the kernel marks PnL at the posted mark, which on
  // devnet only moves every ~30s. Re-anchor the display to the streamed
  // index between marks — exact again the moment the kernel refreshes.
  const live = usePythLive(anqa.marketInfo.pythFeedId);
  const pnlLive = (() => {
    const base = Number(kernel?.pnl ?? 0n) / 1e6;
    if (!position || live === null || mark === null) return base;
    const delta = (live * frac - mark) * Number(position.lots);
    return base + (position.isLong ? delta : -delta);
  })();

  const run = async (
    label: string,
    layer: "base" | "er",
    fn: (p: any, c: any) => Promise<any>
  ) => {
    const p = anqa.programFor(layer);
    if (!p || !owner) return;
    setBusy(label);
    try {
      await fn(p, {
        acc: anqa.acc,
        marketId: anqa.marketId,
        owner,
        engine: owner,
      });
      onDone(`${label} done`);
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  /** Return a session-signed client, renewing once when it has expired. The
   *  wallet is never used as a silent fallback for the actual trade. */
  const requireTradingSession = async () => {
    if (!owner || !anqa.sessionKp || !anqa.sessionTradeExtra) {
      throw new Error("Connect a wallet to trade");
    }
    const session = anqa.sessionProgram();
    if (!session) throw new Error("Session key unavailable");

    const sessionPda = anqa.acc.sessionOf(owner);
    if (
      !anqa.sessionActive &&
      !sessionGrantIsFresh(sessionPda, anqa.sessionKp.publicKey)
    ) {
      const base = anqa.programFor("base");
      if (!base) throw new Error("Wallet not ready");
      setBusy("Enabling 1-click");
      await grantSessionOnly(
        base,
        { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner },
        anqa.sessionKp.publicKey,
        new BN(SESSION_DURATION_SECS)
      );

      const visible = await waitForSessionGrant(
        session,
        sessionPda,
        anqa.sessionKp.publicKey
      );
      if (!visible)
        throw new Error("Session is still syncing — try again in a moment");
    }

    return { program: session, extra: anqa.sessionTradeExtra };
  };

  /** Trading actions: signed by the session key when armed — no popups.
   *  The global session means any market's action works from anywhere, so a
   *  row can pass its own market and never force a navigation first. */
  const runTrade = async (
    label: string,
    fn: (p: any, c: any) => Promise<any>,
    forMarket?: { id: number; groupId: number }
  ) => {
    if (!owner) return;
    const acc = forMarket
      ? anqaAccounts(new BN(forMarket.id), new BN(forMarket.groupId))
      : anqa.acc;
    setBusy(label);
    try {
      const { program, extra } = await requireTradingSession();
      await fn(program, {
        acc,
        marketId: forMarket ? new BN(forMarket.id) : anqa.marketId,
        owner,
        engine: owner,
        ...extra,
      });
      onDone(`${label} done`);
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const [closing, setClosing] = useState<Set<number>>(new Set());

  /** Close is one reduce-only rollup send. Released collateral stays in the
   *  trading account; withdrawal remains an explicit wallet action. */
  const closeAndReturn = async (row: CrossPosition) => {
    if (!owner) return;
    const acc = anqaAccounts(new BN(row.market.id), new BN(row.market.groupId));
    const worstAsset = row.isLong
      ? (row.mark ?? 0) * 0.96
      : (row.mark ?? 0) * 1.04;
    const worstLot = worstAsset * row.market.lotFrac;
    setBusy(`Closing ${row.market.symbol}`);
    setClosing((current) => new Set(current).add(row.market.id));
    try {
      const { program, extra } = await requireTradingSession();
      await closePosition(
        program,
        {
          acc,
          marketId: new BN(row.market.id),
          owner,
          engine: owner,
          ...extra,
        },
        new BN(usdToTicks(worstLot, row.market.tick)),
        new BN(0),
        []
      );
      onDone(`${row.market.symbol} close sent — settling privately`);
      anqa.refresh();
      window.setTimeout(() => {
        setClosing((current) => {
          const next = new Set(current);
          next.delete(row.market.id);
          return next;
        });
      }, 30_000);
    } catch (e: any) {
      setClosing((current) => {
        const next = new Set(current);
        next.delete(row.market.id);
        return next;
      });
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  // The trader's whole book of risk — every market, one table. Margin is
  // isolated per market on-chain; the view should not be.
  const allPositions = useAllPositions();
  // Same rule for what's still waiting: a submitted order rests on its
  // market's book until filled or cancelled, wherever the trader is looking.
  const allOrders = useAllOrders();

  // The book stores an order, not its intent — so intent is read off the
  // portfolio. No position in that market yet: the order is trying to OPEN
  // one, and lives under "Resting orders" until it matches into a position.
  // Position already there: it's a working order managing it, shown under
  // "Orders" beside that market's TP/SL.
  const positioned = new Set(allPositions.map((r) => r.market.id));
  const pendingPositions = submissions.filter(
    (trade) => !positioned.has(trade.marketId)
  );
  const workingOrders = allOrders.filter((o) => positioned.has(o.market.id));
  const restingOrders = allOrders.filter((o) => !positioned.has(o.market.id));

  // Rows the trader just cancelled: keep them for one breath, faded, while
  // the chain catches up — the next poll removes them for real.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const markLeaving = (key: string) => setLeaving((s) => new Set(s).add(key));

  // The match moment. A resting order that vanishes without being cancelled
  // was matched — the instant its market shows a position, say so out loud.
  // Settlement can lag the match by a few seconds, so remember the pending
  // market and fire when the position lands.
  const prevResting = useRef<Map<string, CrossOrder> | null>(null);
  const pendingMatch = useRef<Map<number, { symbol: string; at: number }>>(
    new Map()
  );
  useEffect(() => {
    const now = new Map(
      restingOrders.map((o) => [
        `${o.market.id}-${o.side}-${o.clientOrderId.toString()}`,
        o,
      ])
    );
    const before = prevResting.current;
    prevResting.current = now;
    if (!before) return;
    for (const [key, o] of before) {
      if (now.has(key) || leaving.has(key)) continue;
      pendingMatch.current.set(o.market.id, {
        symbol: o.market.symbol,
        at: Date.now(),
      });
    }
    for (const [mid, p] of pendingMatch.current) {
      if (Date.now() - p.at > 30_000) pendingMatch.current.delete(mid);
      else if (positioned.has(mid)) {
        pendingMatch.current.delete(mid);
        onDone(`${p.symbol}: order matched — position open`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restingOrders, allPositions]);

  const counts: Record<Tab, number | null> = {
    positions:
      allPositions.length + pendingPositions.length || (position ? 1 : 0),
    orders: workingOrders.length + anqa.triggers.length,
    resting: restingOrders.length,
    account: null,
  };
  const labels: Record<Tab, string> = {
    positions: "Positions",
    orders: "Orders",
    resting: "Resting orders",
    account: "Account",
  };

  return (
    <section className="flex flex-col h-full min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
      <header className="flex items-center shrink-0 h-9 border-b border-line-soft overflow-x-auto">
        {(["positions", "orders", "resting", "account"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-full px-3 text-[12px] font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-phoenix text-bright"
                : "border-transparent text-dim hover:text-text"
            }`}
          >
            {labels[t]}
            {counts[t] !== null && (
              <span key={counts[t]} className="badge-pop ml-1">
                ({counts[t]})
              </span>
            )}
          </button>
        ))}
        {allOrders.length > 0 && (
          <button
            onClick={async () => {
              // One cancel_all per market that still holds an order.
              const ids = [...new Set(allOrders.map((o) => o.market.id))];
              for (const id of ids) {
                const m = allOrders.find((o) => o.market.id === id)!.market;
                await runTrade("Cancel all", cancelAll, m);
              }
            }}
            disabled={!!busy}
            className="ml-auto mr-3 text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
          >
            cancel all
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div key={tab} className="tab-swap h-full">
          {!anqa.wallet ? (
            <Empty>Connect a wallet.</Empty>
          ) : tab === "positions" ? (
            anqa.loading &&
            allPositions.length === 0 &&
            pendingPositions.length === 0 ? (
              <SkeletonRows />
            ) : allPositions.length === 0 && pendingPositions.length === 0 ? (
              <Empty>No open positions on any market.</Empty>
            ) : (
              <>
                <Head
                  cols={[
                    "Market",
                    "Side",
                    "Size",
                    "Entry",
                    "Unrealised (mark)",
                    "Liq. price",
                    "Margin",
                    "",
                  ]}
                  n={8}
                />
                {pendingPositions.map((trade) => (
                  <PendingPositionRow
                    key={trade.id}
                    trade={trade}
                    onGoto={() => onSelectMarket(trade.marketId)}
                  />
                ))}
                {allPositions.map((row) => (
                  <PositionRow
                    key={row.market.id}
                    row={row}
                    busy={busy}
                    closing={closing.has(row.market.id)}
                    onGoto={() => onSelectMarket(row.market.id)}
                    onClose={() => closeAndReturn(row)}
                  />
                ))}
              </>
            )
          ) : tab === "orders" ? (
            <OrdersTab
              anqa={anqa}
              position={position}
              busy={busy}
              run={runTrade}
              onDone={onDone}
              working={workingOrders}
              onSelectMarket={onSelectMarket}
            />
          ) : tab === "resting" ? (
            restingOrders.length === 0 ? (
              <Empty>
                Nothing resting — an order that opens a position waits here
                until it matches.
              </Empty>
            ) : (
              <>
                <Head
                  cols={["Market", "Side", "Price", "Size", "Visibility", ""]}
                />
                {restingOrders.map((o) => {
                  const key = `${o.market.id}-${
                    o.side
                  }-${o.clientOrderId.toString()}`;
                  return (
                    <OrderRow
                      key={key}
                      row={o}
                      busy={busy}
                      leaving={leaving.has(key)}
                      onGoto={() => onSelectMarket(o.market.id)}
                      onCancel={() => {
                        markLeaving(key);
                        runTrade(
                          "Cancel",
                          (p, c) => cancelOrder(p, c, o.side, o.clientOrderId),
                          o.market
                        );
                      }}
                    />
                  );
                })}
              </>
            )
          ) : (
            <AccountTab
              anqa={anqa}
              busy={busy}
              onDone={onDone}
              positions={allPositions}
              onDeposit={onDeposit}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** Two quiet shimmer rows while the first read is in flight. */
function SkeletonRows() {
  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <span className="skeleton h-3 w-20" />
          <span className="skeleton h-3 w-10" />
          <span className="skeleton h-3 w-24" />
          <span className="skeleton h-3 w-16" />
          <span className="skeleton h-3 flex-1 max-w-32" />
        </div>
      ))}
    </div>
  );
}

/** Working orders on top of existing positions: limit orders beside the
 *  TP/SL protecting the same market. Opening orders live in Resting. */
function OrdersTab({
  anqa,
  position,
  busy,
  run,
  onDone,
  working,
  onSelectMarket,
}: any) {
  const [stop, setStop] = useState("");
  const tick = anqa.market?.tickSize ?? 1;
  const frac = lotFraction(anqa.market);
  // Trader-facing prices are per BTC; the trigger compares per-lot atoms.
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6 / frac;

  return (
    <>
      {position && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line-soft">
          <input
            value={stop}
            onChange={(e) => setStop(e.target.value)}
            placeholder={
              mark
                ? (mark * (position.isLong ? 0.97 : 1.03)).toFixed(2)
                : "0.00"
            }
            inputMode="decimal"
            className="tnum w-32 h-7 bg-void border border-line rounded px-2 text-[11px] text-bright outline-none focus:border-phoenix-soft placeholder:text-dim/60"
          />
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => {
              const p = Number(stop);
              if (!p) return onDone("Stop price required", true);
              run("Stop armed", (prog: any, c: any) =>
                placeTrigger(prog, c, {
                  triggerId: new BN(Date.now() % 1_000_000),
                  triggerPrice: new BN(Math.round(p * frac * 1e6)),
                  direction: position.isLong ? "below" : "above",
                  limitPriceInTicks: new BN(
                    usdToTicks(
                      (position.isLong ? p * 0.97 : p * 1.03) * frac,
                      tick
                    )
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
      {working.length === 0 && anqa.triggers.length === 0 ? (
        <Empty>
          {position
            ? "No working orders — limit orders and TP/SL on your positions live here."
            : "Open a position first — the orders managing it will live here."}
        </Empty>
      ) : (
        <>
          <Head cols={["Market", "Type", "Price", "Size", "", ""]} />
          {working.map((o: CrossOrder) => (
            <div
              key={`${o.market.id}-${o.side}-${o.clientOrderId.toString()}`}
              className="grid grid-cols-6 items-center px-3 py-2 text-[11px] row-hover row-in"
            >
              <button
                onClick={() => onSelectMarket(o.market.id)}
                className="text-left font-medium text-bright hover:text-phoenix transition-colors"
              >
                {o.market.symbol}
              </button>
              <span className={o.side === "bid" ? "text-bid" : "text-ask"}>
                Limit {o.side === "bid" ? "buy" : "sell"}
              </span>
              <span className="tnum text-text">
                {(
                  ticksToUsd(o.priceInTicks, o.market.tick) / o.market.lotFrac
                ).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="tnum text-muted">
                {(o.baseLots * o.market.lotFrac).toLocaleString(undefined, {
                  maximumFractionDigits: o.market.sizeDp,
                })}{" "}
                {o.market.base}
              </span>
              {/* Two different kinds of unseen. On a dark market nobody can
                  read the book, so no order names its owner — but a *shown*
                  order still adds its size to the public ladder at its price,
                  and a hidden one does not. That is the distinction the
                  trader chose, so it is the one worth reporting. */}
              <span
                className={`text-[10px] ${
                  o.hidden ? "text-phoenix" : "text-dim"
                }`}
                title={
                  o.hidden
                    ? "Off the public ladder — nobody sees this size until it fills"
                    : o.dark
                    ? "Counted in the public depth at this price; the owner is still nobody's business"
                    : "Publicly visible"
                }
              >
                {o.hidden ? "hidden" : o.dark ? "on ladder" : "visible"}
              </span>
              <span className="text-right">
                <button
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      "Cancel",
                      (p: any, c: any) =>
                        cancelOrder(p, c, o.side, o.clientOrderId),
                      o.market
                    )
                  }
                  className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
                >
                  cancel
                </button>
              </span>
            </div>
          ))}
          {anqa.triggers.map((t: any) => {
            const m = MARKETS.find((x) => x.assetIndex === t.assetIndex);
            if (!m) return null;
            return (
              <div
                key={t.id}
                className="grid grid-cols-6 items-center px-3 py-2 text-[11px] row-hover row-in"
              >
                <button
                  onClick={() => onSelectMarket(m.id)}
                  className="text-left font-medium text-bright hover:text-phoenix transition-colors"
                >
                  {m.symbol}
                </button>
                <span className="text-text">
                  {t.direction === "below" ? "Stop loss" : "Take profit"}
                </span>
                <span className="tnum text-text">
                  {(
                    Number(t.price.toString()) /
                    1e6 /
                    m.lotFrac
                  ).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span className="tnum text-muted">
                  {Number(t.maxLots.toString()) === 0
                    ? "full position"
                    : `${(
                        Number(t.maxLots.toString()) * m.lotFrac
                      ).toLocaleString(undefined, {
                        maximumFractionDigits: m.sizeDp,
                      })} ${m.base}`}
                </span>
                <span className="text-muted text-[10px]">
                  when mark goes {t.direction}
                </span>
                <span className="text-right">
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "Cancelled",
                        (p: any, c: any) => cancelTrigger(p, c, new BN(t.id)),
                        m
                      )
                    }
                    className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
                  >
                    cancel
                  </button>
                </span>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

/**
 * The money, laid out the way it actually lives.
 *
 * Two places and no others: USDC in the trader's own wallet, and collateral
 * allocated to a market. A market's allocation is the entire risk of any
 * position there — losses cannot reach the wallet or another market — so the
 * table shows both sides and lets the trader move value between them.
 */
/**
 * The account, the way a perp venue shows it.
 *
 * One collateral asset — USDC — and two balances: what this market holds for
 * the trader, and what is still in their wallet. On an isolated venue the
 * first number is the entire risk of any position here, which is why it sits
 * beside the wallet rather than being buried in a settings screen.
 */
/**
 * The account, laid out the way a perp venue lays it out.
 *
 * One collateral asset — USDC — and two balances: what the venue holds for
 * the trader, and what is still in their wallet. The first funds every
 * market; isolation lives in the collateral each position is opened with,
 * not in separate accounts.
 */
function AccountTab({ anqa, busy, onDone, positions, onDeposit }: any) {
  const owner = anqa.wallet?.publicKey;
  const [wallet, setWallet] = useState(0);
  const [account, setAccount] = useState(0);
  const MINT = anqa.marketInfo.mint
    ? new PublicKey(anqa.marketInfo.mint)
    : null;

  useEffect(() => {
    if (!owner || !MINT) return;
    let stop = false;
    const tick = async () => {
      const w = await walletUsdc(anqa.conns.base, MINT, owner);
      const info = await anqa.conns.er
        .getAccountInfo(anqa.acc.portfolioOf(owner))
        .catch(() => null);
      const a = info
        ? Number(
            equity(readKernel(Uint8Array.from(info.data.subarray(PF_INNER))))
          ) / 1e6
        : 0;
      if (!stop) {
        setWallet(w);
        setAccount(a);
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58(), busy]);

  const openPnl = (positions ?? []).reduce(
    (a: number, r: CrossPosition) => a + (r.pnl ?? 0),
    0
  );
  // Collateral committed to open positions is spent from the balance the
  // moment a position opens — the account shows what is still free, the way
  // a debit works, not the total the trader owns.
  const committed = (positions ?? []).reduce(
    (a: number, r: CrossPosition) => a + (r.legMarginUsd ?? 0),
    0
  );
  const free = Math.max(0, account - committed);
  const money = (n: number) =>
    `$${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  if (!owner) return <Empty>Connect a wallet.</Empty>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-3 p-3">
      {/* the account */}
      <div className="border border-line-soft rounded-lg overflow-hidden">
        <div className="flex items-center h-11 px-4 border-b border-line-soft">
          <span className="text-[13px] font-semibold text-bright">
            Trading account
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-dim">
            <span className="grid place-items-center h-3.5 w-3.5 rounded-full border border-line text-[8px]">
              i
            </span>
            First deposit initialises your account.
          </span>
        </div>

        <div className="grid grid-cols-[0.8fr_1fr_1fr_auto] items-center gap-3 px-4 h-10 text-[12px] text-dim border-b border-line-soft">
          <span>Token</span>
          <span>Your anqa account</span>
          <span>Your wallet</span>
          <span>Action</span>
        </div>

        <div className="grid grid-cols-[0.8fr_1fr_1fr_auto] items-center gap-3 px-4 py-4 text-[13px]">
          <span className="flex items-center gap-2 font-medium text-bright">
            <span className="grid place-items-center h-6 w-6 rounded-full bg-phoenix/15 text-[10px] text-phoenix">
              $
            </span>
            USDC
          </span>
          <span className="tnum text-bright">
            {free.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="tnum text-muted">
            {wallet.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="flex items-center gap-2">
            <button
              onClick={onDeposit}
              disabled={!!busy}
              className="h-8 px-3 flex items-center gap-1.5 rounded-md border border-line text-[12px] text-text hover:border-phoenix-soft hover:text-bright transition-colors disabled:opacity-40"
            >
              <span className="text-[10px]">↓</span> Deposit
            </button>
            <button
              onClick={onDeposit}
              disabled={!!busy}
              className="h-8 px-3 flex items-center gap-1.5 rounded-md border border-line text-[12px] text-text hover:border-phoenix-soft hover:text-bright transition-colors disabled:opacity-40"
            >
              <span className="text-[10px]">↑</span> Withdraw
            </button>
          </span>
        </div>
      </div>

      {/* portfolio */}
      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold text-bright">
          Your portfolio
        </span>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Portfolio value" value={money(account + wallet)} />
          <Stat label="In positions" value={money(committed)} />
        </div>
        <Stat
          label="Open positions"
          value={`${openPnl < 0 ? "−" : "+"}${money(Math.abs(openPnl)).replace(
            "$",
            "$"
          )}`}
          tone={openPnl > 0 ? "bid" : openPnl < 0 ? "ask" : "muted"}
        />
      </div>
    </div>
  );
}

/** A single figure in a bordered card — the portfolio rail's unit. */
function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "bid" | "ask" | "muted";
}) {
  return (
    <div className="flex flex-col gap-0.5 px-2.5 py-2 bg-void/40 border border-line-soft rounded-lg">
      <span className="text-[9px] text-dim">{label}</span>
      <span
        className={`tnum text-[13px] font-semibold ${
          tone === "bid"
            ? "text-bid"
            : tone === "ask"
            ? "text-ask"
            : "text-bright"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** One resting order, any market: submitted but not yet filled. Cancelling
 *  signs with the global session, so no navigation is ever required. */
function OrderRow({
  row,
  busy,
  leaving = false,
  onCancel,
  onGoto,
}: {
  row: CrossOrder;
  busy: string | null;
  leaving?: boolean;
  onCancel: () => void;
  onGoto: () => void;
}) {
  return (
    <div
      className={`grid grid-cols-6 items-center px-3 py-2 text-[11px] row-hover ${
        leaving ? "row-leaving" : "row-in"
      }`}
    >
      <button
        onClick={onGoto}
        className="text-left font-medium text-bright hover:text-phoenix transition-colors"
      >
        {row.market.symbol}
      </button>
      <span className={row.side === "bid" ? "text-bid" : "text-ask"}>
        {row.side === "bid" ? "Buy" : "Sell"}
      </span>
      <span className="tnum text-text">
        {(
          ticksToUsd(row.priceInTicks, row.market.tick) / row.market.lotFrac
        ).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
      <span className="tnum text-muted">
        {(row.baseLots * row.market.lotFrac).toLocaleString(undefined, {
          maximumFractionDigits: row.market.sizeDp,
        })}{" "}
        {row.market.base}
      </span>
      <span className="text-phoenix/90 text-[10px]">
        {row.dark ? "hidden" : "visible"}
      </span>
      <span className="text-right">
        <button
          disabled={!!busy}
          onClick={onCancel}
          className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
        >
          cancel
        </button>
      </span>
    </div>
  );
}

/** Immediate feedback for a market order while the private matcher and
 * settlement keeper turn it into the canonical on-chain position row. */
function PendingPositionRow({
  trade,
  onGoto,
}: {
  trade: TradeSubmission;
  onGoto: () => void;
}) {
  return (
    <div className="grid grid-cols-8 items-center px-3 py-2.5 text-[11px] bg-phoenix/[0.025] row-in">
      <button
        onClick={onGoto}
        className="text-left font-medium text-bright hover:text-phoenix transition-colors"
      >
        {trade.symbol}
      </button>
      <span>
        <span
          className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold ${
            trade.side === "long" ? "bg-bid/12 text-bid" : "bg-ask/12 text-ask"
          }`}
        >
          {trade.side === "long" ? "Long" : "Short"}
        </span>
      </span>
      <span className="tnum text-text">
        {trade.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
        {trade.base}
      </span>
      <span className="text-phoenix flex items-center gap-1.5">
        <span className="live-dot w-1.5 h-1.5 rounded-full bg-phoenix" />
        Matching
      </span>
      <span className="text-dim">settling…</span>
      <span className="text-dim">—</span>
      <span className="tnum text-muted">
        $
        {trade.collateralUsd.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}
      </span>
      <span className="text-right text-[10px] text-dim">Session signed</span>
    </div>
  );
}

/** One position, marked with the protocol's accepted oracle price.
 *
 * The terminal also streams a faster index price, but using that here made the
 * PnL disagree with the MARK displayed in the market bar. Risk, liquidation
 * and settlement all speak in the accepted mark, so the position row does too.
 */
function PositionRow({
  row,
  busy,
  closing,
  onClose,
  onGoto,
}: {
  row: CrossPosition;
  busy: string | null;
  closing: boolean;
  onClose: () => void;
  onGoto: () => void;
}) {
  // `row.pnl` is derived from the same accepted mark shown in MarketBar.
  const pnl = useTweened(row.pnl, 350) ?? 0;
  const roe = row.legMarginUsd > 0 ? (pnl / row.legMarginUsd) * 100 : 0;
  const tone = pnl > 0 ? "text-bid" : pnl < 0 ? "text-ask" : "text-muted";
  return (
    <div className="grid grid-cols-8 items-center px-3 py-2.5 text-[11px] row-hover glow-in">
      <button
        onClick={onGoto}
        className="text-left font-medium text-bright hover:text-phoenix transition-colors"
      >
        {row.market.symbol}
      </button>
      <span>
        <span
          className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold ${
            row.isLong ? "bg-bid/12 text-bid" : "bg-ask/12 text-ask"
          }`}
        >
          {row.isLong ? "Long" : "Short"}
        </span>
      </span>
      <span className="tnum text-text">
        {row.size.toLocaleString(undefined, {
          maximumFractionDigits: row.market.sizeDp,
        })}{" "}
        {row.market.base}
      </span>
      <span className="tnum text-muted">
        {row.entry === null
          ? "—"
          : row.entry.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
      <span
        className={`tnum ${tone}`}
        title={
          row.mark === null
            ? "Waiting for the protocol mark"
            : `PnL at protocol mark ${row.mark.toLocaleString(undefined, {
                maximumFractionDigits: 8,
              })}`
        }
      >
        {pnl < 0 ? "−" : "+"}$
        {Math.abs(pnl).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
        <span className="ml-1 text-[9px] opacity-80">
          ({roe >= 0 ? "+" : ""}
          {roe.toFixed(2)}%)
        </span>
      </span>
      {/* Estimated liquidation price; "—" when price alone cannot get there. */}
      <span
        className="tnum text-ask/80"
        title="Estimated — moves with equity and your other positions"
      >
        {row.liq === null
          ? "—"
          : row.liq.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
      <span className="tnum text-muted">
        $
        {row.legMarginUsd.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </span>
      <span className="text-right">
        <button
          disabled={!!busy || row.mark === null || closing}
          onClick={onClose}
          className="h-6 px-2.5 rounded border border-ask/40 text-[10px] font-medium text-ask hover:bg-ask/15 transition-colors disabled:opacity-40"
        >
          {closing ? "Closing…" : "Close"}
        </button>
      </span>
    </div>
  );
}

function Head({ cols, n = 6 }: { cols: string[]; n?: number }) {
  return (
    <div
      className="grid px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-dim border-b border-line-soft sticky top-0 bg-ink"
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      {cols.map((c, i) => (
        <span key={i} className={i === cols.length - 1 ? "text-right" : ""}>
          {c}
        </span>
      ))}
    </div>
  );
}

/** A money figure that glides between values and flashes its direction. */
function LiveFigure({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint?: string;
}) {
  const shown = useTweened(value);
  const flash = useTickFlash(value);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">
        {label}
      </span>
      <span
        key={flash.key}
        className={`tnum text-[14px] text-bright px-0.5 -mx-0.5 ${
          flash.dir === "up"
            ? "flash-up"
            : flash.dir === "down"
            ? "flash-down"
            : ""
        }`}
      >
        {shown === null
          ? "—"
          : `$${shown.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`}
      </span>
      {hint && <span className="text-[9px] text-dim">{hint}</span>}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">
        {label}
      </span>
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
