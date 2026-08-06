"use client";

import { useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import dynamic from "next/dynamic";
import { Badge } from "./ui";
import { readableError } from "@/lib/anqa";
import { placeOrder, placeTrigger } from "@/lib/actions";
import { lotFraction, usdToTicks } from "@/lib/anqa";
import { fundMarket } from "@/lib/margin";
import { useAllPositions } from "@/lib/useAllPositions";
import { equity, readKernel } from "@/lib/portfolio";
import { sessionGrantIsFresh, waitForSessionGrant } from "@/lib/session";
import type { TradeSubmission } from "@/lib/tradeActivity";
import type { Anqa } from "@/lib/useAnqa";

const WalletButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

// Each market has its own collateral mint; resolved from the registry.

const MAX_LEV = 25;
const LEV_PRESETS = [5, 10, 15, 25];

type PortfolioReader = {
  account: {
    portfolio: {
      fetch: (address: PublicKey) => Promise<{ inner: number[] | Uint8Array }>;
    };
  };
};

/**
 * The order ticket.
 *
 * It doubles as the onboarding path, because on this venue they are the same
 * sequence: an account, collateral, and a session in the rollup are all
 * preconditions for an order, and hiding them behind a separate screen only
 * makes the first order fail for reasons the trader cannot see. So the button
 * always says the next true thing.
 *
 * Sizing speaks the language of a perp venue: the trader states what they
 * pay and at what leverage, and the ticket derives the position — not the
 * other way round.
 */
export function TradeForm({
  anqa,
  onDone,
  onDeposit,
  onSubmitted,
  onSubmissionResolved,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
  /** Opens the deposit dialog — shown when the account cannot cover a trade. */
  onDeposit: () => void;
  onSubmitted: (trade: TradeSubmission) => void;
  onSubmissionResolved: (id: number) => void;
}) {
  const positions = useAllPositions();
  const [side, setSide] = useState<"bid" | "ask">("bid");
  const [type, setType] = useState<"limit" | "market">("market");
  const [price, setPrice] = useState("");
  const [pay, setPay] = useState("");
  const [lev, setLev] = useState(5);
  /** Time in force for limit orders. GTC and post-only rest on the book;
   *  IOC and FOK execute-or-die and never rest. Market mode is always IOC. */
  const [tif, setTif] = useState<"gtc" | "postOnly" | "ioc" | "fok">("gtc");
  const [hidden, setHidden] = useState(false);
  /** Only an order that rests can be hidden: hiding withholds size from the
   *  public ladder, and an order that fills on arrival was never on it. Market
   *  mode and IOC/FOK therefore cannot hide. Computed here rather than at
   *  submit time because the control needs it too. */
  const canRest = type === "limit" && (tif === "gtc" || tif === "postOnly");
  const [tpslOpen, setTpslOpen] = useState(false);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const owner = anqa.wallet?.publicKey;
  const MINT = anqa.marketInfo.mint
    ? new PublicKey(anqa.marketInfo.mint)
    : null;
  const tick = anqa.market?.tickSize ?? 1;
  // The chain speaks per-lot prices; the trader thinks per-BTC. Everything
  // user-facing here is per-BTC USD, converted through `frac` only at the
  // boundary where ticks and trigger atoms are built.
  const frac = lotFraction(anqa.market);
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6 / frac;
  const kernel = useMemo(
    () => (anqa.portfolio ? readKernel(anqa.portfolio.inner) : null),
    [anqa.portfolio]
  );
  // Collateral already standing behind this market. Isolated margin means
  // this IS the risk of any position here, so the ticket treats it as the
  // starting point and only ever asks the wallet for the difference.
  const allocated = kernel ? Number(equity(kernel)) / 1e6 : 0;
  /** Free balance in the account — collateral already committed to open
   *  positions is spoken for, and wallet money is not tradeable until it is
   *  deposited. This is what "max" means. */
  const committed = positions.reduce(
    (a: number, r: { legMarginUsd?: number }) => a + (r.legMarginUsd ?? 0),
    0
  );
  const allocatable = Math.max(0, allocated - committed);

  // Pay × leverage is the position the trader is asking for; the book only
  // speaks whole lots, so the ticket rounds down and shows what it kept.
  const payUsd = Number(pay) || 0;
  const effPrice = type === "market" ? mark ?? 0 : Number(price) || mark || 0;
  const target = payUsd * lev;
  const perLot = effPrice * frac;
  const lots = perLot > 0 ? Math.floor(target / perLot) : 0;
  const sizeBtc = lots * frac;
  const notional = perLot * lots;
  // What this trade would liquidate at, given the collateral being put up.
  // Isolated margin makes it exact: only `payUsd` stands behind it.
  //   long:  C + s*(P - entry) = f*s*P  ->  P = (entry - C/s) / (1 - f)
  //   short: C + s*(entry - P) = f*s*P  ->  P = (entry + C/s) / (1 + f)
  const MAINT_FRAC = 0.025;
  const liqPreview =
    payUsd > 0 && sizeBtc > 0 && effPrice > 0
      ? side === "bid"
        ? (effPrice - payUsd / sizeBtc) / (1 - MAINT_FRAC)
        : (effPrice + payUsd / sizeBtc) / (1 + MAINT_FRAC)
      : null;

  const tpN = Number(tp) || 0;
  const slN = Number(sl) || 0;
  const long = side === "bid";

  // The execution band. A perp fill mints a position at its entry and the mark
  // revalues it immediately, so the program refuses any order more than
  // `max_band_bps` from the mark — before it looks at margin, size or anything
  // else. Recomputing it here is the difference between a disabled button and a
  // burnt transaction with an error the trader has to decode.
  const bandBps: number = anqa.market?.oracle?.maxBandBps ?? 0;
  const band =
    mark !== null && bandBps > 0
      ? {
          low: mark * (1 - bandBps / 10_000),
          high: mark * (1 + bandBps / 10_000),
        }
      : null;
  const outOfBand =
    band !== null &&
    type === "limit" &&
    effPrice > 0 &&
    (effPrice < band.low || effPrice > band.high);

  /** Not enough in the account to back this trade. */
  const needsDeposit = payUsd > allocatable + 0.01;

  const blocker = !payUsd
    ? "Enter the collateral for this trade"
    : lev <= 0
    ? "Leverage is zero — the position is zero"
    : type === "limit" && !Number(price)
    ? "Price is required"
    : lots < 1
    ? `Below one lot — pay × leverage must reach ~$${
        perLot
          ? perLot.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : "—"
      }`
    : outOfBand
    ? `Outside the ${(bandBps / 100).toFixed(
        1
      )}% band — price must be between ${band!.low.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })} and ${band!.high.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })}`
    : // Isolated margin: Pay beyond the pot is fine — the ticket
    // allocates the shortfall from the wallet before ordering.
    tpslOpen && tpN > 0 && (long ? tpN <= effPrice : tpN >= effPrice)
    ? `Take profit must be ${long ? "above" : "below"} the entry price`
    : tpslOpen && slN > 0 && (long ? slN >= effPrice : slN <= effPrice)
    ? `Stop loss must be ${long ? "below" : "above"} the entry price`
    : null;

  const needOpen = !anqa.portfolio;
  const needDelegate = !anqa.portfolioDelegated;
  const oneClickReady = !!(
    anqa.sessionActive ||
    (owner &&
      anqa.sessionKp &&
      sessionGrantIsFresh(anqa.acc.sessionOf(owner), anqa.sessionKp.publicKey))
  );
  const needGrant = !oneClickReady;

  /**
   * Arm TP/SL once the position exists.
   *
   * A trigger is reduce-only by construction — the program refuses one with
   * no open position, and on a dark market the fill queues for the engine
   * before the position appears. So the ticket waits for settlement and arms
   * the stops the moment there is something to protect.
   */
  const armStops = async (
    wantLong: boolean,
    tpPrice: number,
    slPrice: number
  ) => {
    const p = anqa.sessionProgram();
    if (!p || !owner || !anqa.sessionTradeExtra) return;
    const tradeCtx = {
      acc: anqa.acc,
      marketId: anqa.marketId,
      owner,
      engine: owner,
      ...anqa.sessionTradeExtra,
    };
    const pfKey = anqa.acc.portfolioOf(owner);
    const assetIndex = anqa.market?.assetIndex ?? 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const pf: any = await (p as any).account.portfolio.fetch(pfKey);
        const k = readKernel(pf.inner);
        const pos = k.positions.find((x) => x.assetIndex === assetIndex);
        if (!pos || pos.isLong !== wantLong) continue;
        const id = Date.now() % 1_000_000_000;
        const armed: string[] = [];
        // Trigger prices compare against the per-lot mark; the trader typed
        // a per-BTC price, so scale through the lot fraction here.
        if (tpPrice > 0) {
          await placeTrigger(p, tradeCtx, {
            triggerId: new BN(id),
            triggerPrice: new BN(Math.round(tpPrice * frac * 1e6)),
            direction: wantLong ? "above" : "below",
            limitPriceInTicks: new BN(
              usdToTicks(
                (wantLong ? tpPrice * 0.97 : tpPrice * 1.03) * frac,
                tick
              )
            ),
            maxBaseLots: new BN(0), // 0 = the whole position, however much settled
          });
          armed.push(`TP $${tpPrice.toLocaleString()}`);
        }
        if (slPrice > 0) {
          await placeTrigger(p, tradeCtx, {
            triggerId: new BN(id + 1),
            triggerPrice: new BN(Math.round(slPrice * frac * 1e6)),
            direction: wantLong ? "below" : "above",
            limitPriceInTicks: new BN(
              usdToTicks(
                (wantLong ? slPrice * 0.97 : slPrice * 1.03) * frac,
                tick
              )
            ),
            maxBaseLots: new BN(0),
          });
          armed.push(`SL $${slPrice.toLocaleString()}`);
        }
        if (armed.length) onDone(`${armed.join(" · ")} armed`);
        anqa.refresh();
        return;
      } catch {
        // Not settled yet, or a transient read — keep waiting.
      }
    }
    onDone(
      "Fill not settled yet — arm TP/SL from the Orders tab once the position opens",
      true
    );
  };

  /** Matching and settlement are separate on a dark book. The order send can
   * succeed even when the risk kernel later consumes the fill as refused, so
   * only call it open after the private portfolio actually changes. */
  const confirmPositionChange = async (
    program: unknown,
    submissionId: number,
    beforeLots: bigint
  ) => {
    if (!owner) return;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const portfolio = await (program as PortfolioReader).account.portfolio
        .fetch(anqa.acc.portfolioOf(owner))
        .catch(() => null);
      if (!portfolio) continue;
      const leg = readKernel(portfolio.inner).positions.find(
        (position) => position.assetIndex === (anqa.market?.assetIndex ?? 0)
      );
      const afterLots = leg
        ? leg.isLong
          ? leg.lots
          : -leg.lots
        : 0n;
      if (afterLots !== beforeLots) {
        onSubmissionResolved(submissionId);
        onDone(`${anqa.marketInfo.symbol} position open`);
        anqa.refresh();
        return;
      }
    }
    onSubmissionResolved(submissionId);
    onDone(
      `${anqa.marketInfo.symbol} order did not settle — no position was opened`,
      true
    );
    anqa.refresh();
  };

  const submit = async () => {
    if (!owner) return;
    if (blocker) return onDone(blocker, true);
    // A market order still needs a bound; cross the band, not the universe.
    const limit =
      type === "market"
        ? side === "bid"
          ? effPrice * 1.02
          : effPrice * 0.98
        : Number(price);
    // May this order rest on the book? Only GTC and post-only limit orders.
    setBusy("Collateral");
    try {
      // Make sure the account can cover this position's collateral —
      // account, session and any top-up ride one signature. The collateral
      // itself is committed to the position by `place_order` below.
      const base = anqa.programFor("base");
      const session = anqa.sessionProgram();
      if (
        !base ||
        !MINT ||
        !anqa.sessionKp ||
        !session ||
        !anqa.sessionTradeExtra
      ) {
        throw new Error("Wallet not ready");
      }
      // Established accounts go straight to the rollup. Base-layer balance
      // and funding reads belong to Deposit, not in front of every trade.
      if (needOpen || needDelegate || needGrant) {
        await fundMarket(
          base,
          // Funding setup is wallet-authorized once, but deposit claims are
          // trade-scoped rollup actions. Use the session signer so a lagging
          // credit can never turn into repeated wallet approval popups.
          session,
          {
            acc: anqa.acc,
            marketId: anqa.marketId,
            owner,
            engine: owner,
          },
          {
            usd: payUsd,
            mint: MINT,
            sessionKey: anqa.sessionKp.publicKey,
            sessionPda: anqa.acc.sessionOf(owner),
            need: { open: needOpen, delegate: needDelegate, grant: needGrant },
            conn: anqa.conns.base,
            onStep: (msg) => setBusy(msg),
          }
        );
      }

      // The grant is written on base and clone-read by the rollup. On a first
      // trade, wait only for that one account to become visible before sending
      // with the new key. This avoids capturing the wallet provider that was
      // active before onboarding and then producing a second popup.
      if (needGrant) {
        setBusy("Arming 1-click");
        const visible = await waitForSessionGrant(
          session,
          anqa.acc.sessionOf(owner),
          anqa.sessionKp.publicKey
        );
        if (!visible)
          throw new Error("Session is still syncing — try again in a moment");
      }

      setBusy("Order");
      const existingLeg = anqa.portfolio
        ? readKernel(anqa.portfolio.inner).positions.find(
            (position) =>
              position.assetIndex === (anqa.market?.assetIndex ?? 0)
          )
        : null;
      const beforeLots = existingLeg
        ? existingLeg.isLong
          ? existingLeg.lots
          : -existingLeg.lots
        : 0n;
      const submissionId = Date.now();
      const clientOrderId = new BN(submissionId % 2_000_000_000);
      await placeOrder(
        session,
        {
          acc: anqa.acc,
          marketId: anqa.marketId,
          owner,
          engine: owner,
          ...anqa.sessionTradeExtra,
        },
        {
          side,
          orderType:
            type === "market" || tif === "ioc"
              ? "immediateOrCancel"
              : tif === "fok"
              ? "fillOrKill"
              : tif === "postOnly"
              ? "postOnly"
              : "limit",
          priceInTicks: new BN(usdToTicks(limit * frac, tick)),
          baseLots: new BN(lots),
          clientOrderId,
          // Isolated margin: what this position may lose, recorded on-chain
          // beside it and enforced by the isolated liquidator.
          collateralAtoms: new BN(Math.round(payUsd * 1e6)),
          // Only an order that rests can be hidden; there is nothing to withhold
          // from the ladder when the whole order crosses on arrival.
          hidden: hidden && canRest,
          makers: [], // dark: name nobody
        }
      );
      if (!canRest) {
        onSubmitted({
          id: submissionId,
          marketId: anqa.marketInfo.id,
          symbol: anqa.marketInfo.symbol,
          base: anqa.marketInfo.base,
          side: long ? "long" : "short",
          size: sizeBtc,
          notionalUsd: notional,
          collateralUsd: payUsd,
          submittedAt: Date.now(),
        });
        void confirmPositionChange(session, submissionId, beforeLots);
      }
      const wantStops = tpslOpen && (tpN > 0 || slN > 0);
      onDone(
        canRest
          ? "Order on the book — cancel from Resting orders until it matches"
          : anqa.market?.dark
          ? `Opening ${long ? "long" : "short"} — matching privately${
              wantStops ? "; arming TP/SL after settlement" : ""
            }`
          : `Opening ${long ? "long" : "short"}${
              wantStops ? " — arming TP/SL after settlement" : ""
            }`
      );
      if (wantStops) void armStops(long, tpN, slN);
      setPay("");
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  // Two states: connect, then trade. Whatever a market still needs — the
  // account, the session, the collateral — rides inside the first order.
  const step = !anqa.wallet ? "connect" : "trade";

  return (
    <section className="flex flex-col shrink-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
      <header className="flex items-center shrink-0 h-8 px-2 border-b border-line-soft">
        <div className="flex items-center gap-2 px-1">
          <span className="text-[11px] font-semibold text-bright">Trade</span>
          <span className="text-[10px] text-dim">Isolated</span>
        </div>
        <div className="ml-auto">
          {anqa.portfolioDelegated ? (
            <Badge tone="live">
              <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" />
              {oneClickReady ? "1-click ready" : "enable 1-click"}
            </Badge>
          ) : (
            <Badge tone="neutral">
              {anqa.portfolio ? "on base" : "no account"}
            </Badge>
          )}
        </div>
      </header>

      {/* side — the two doors into a perp */}
      <div className="shrink-0 p-2.5 pb-0">
        <div className="grid grid-cols-2 gap-1 p-1 bg-void border border-line rounded-lg">
          <button
            onClick={() => setSide("bid")}
            className={`h-8 rounded-md text-[13px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
              long
                ? "bg-bid/15 text-bid shadow-[inset_0_0_0_1px_var(--color-bid)]"
                : "text-dim hover:text-text"
            }`}
          >
            <span className="text-[11px]">↗</span> Long
          </button>
          <button
            onClick={() => setSide("ask")}
            className={`h-8 rounded-md text-[13px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
              !long
                ? "bg-ask/15 text-ask shadow-[inset_0_0_0_1px_var(--color-ask)]"
                : "text-dim hover:text-text"
            }`}
          >
            <span className="text-[11px]">↘</span> Short
          </button>
        </div>
      </div>

      <div className="p-2.5 flex flex-col gap-2.5">
        {/* price + order type */}
        <div className="flex gap-1.5">
          <div className="flex-1 min-w-0 flex items-center gap-2 h-10 px-2.5 bg-void border border-line rounded-md focus-within:border-phoenix-soft transition-colors">
            <input
              value={type === "market" ? mark?.toFixed(2) ?? "" : price}
              onChange={(e) => setPrice(e.target.value)}
              readOnly={type === "market"}
              placeholder={mark?.toFixed(2) ?? "0.00"}
              inputMode="decimal"
              className={`tnum w-full bg-transparent text-[14px] outline-none placeholder:text-dim/60 ${
                type === "market" ? "text-muted" : "text-bright"
              }`}
            />
            <span className="text-[10px] text-dim">USD</span>
          </div>
          <div className="flex items-center p-0.5 bg-void border border-line rounded-md">
            {(["market", "limit"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`h-full px-2.5 text-[11px] font-medium capitalize rounded transition-colors ${
                  type === t
                    ? "bg-raised text-bright"
                    : "text-dim hover:text-text"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {mark !== null && type === "limit" && (
          <div className="flex items-baseline gap-2 -mt-1">
            <button
              onClick={() => setPrice(mark.toFixed(2))}
              className="text-[10px] text-dim hover:text-phoenix transition-colors"
            >
              use mark{" "}
              {mark.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </button>
            {band && (
              <span
                className={`tnum text-[10px] ml-auto ${
                  outOfBand ? "text-ask" : "text-dim"
                }`}
              >
                band{" "}
                {band.low.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
                –
                {band.high.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>
            )}
          </div>
        )}

        {/* pay */}
        <div className="flex flex-col gap-1 px-2.5 py-2 bg-void border border-line rounded-md focus-within:border-phoenix-soft transition-colors">
          <div className="flex items-baseline justify-between text-[10px]">
            <span className="text-dim">
              Collateral — the whole risk of this trade
            </span>
            <span className="text-dim">
              {allocated > 0.01 && (
                <>
                  now{" "}
                  <span className="tnum text-phoenix/80">
                    $
                    {allocated.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </span>{" "}
                </>
              )}
              <button
                onClick={() =>
                  setPay(allocatable > 0 ? allocatable.toFixed(2) : "")
                }
                className="text-phoenix/80 hover:text-phoenix transition-colors"
              >
                max
              </button>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={pay}
              onChange={(e) => setPay(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className="tnum w-full bg-transparent text-[16px] text-bright outline-none placeholder:text-dim/60"
            />
            <span className="shrink-0 text-[11px] font-medium text-muted bg-raised border border-line rounded px-1.5 py-0.5">
              USDC
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1 pt-0.5">
            {([25, 50, 75, 100] as const).map((pct) => (
              <button
                key={pct}
                onClick={() =>
                  setPay(
                    allocatable > 0
                      ? ((allocatable * pct) / 100).toFixed(2)
                      : ""
                  )
                }
                className="h-5 text-[10px] rounded border border-line text-dim hover:text-text hover:border-phoenix-soft transition-colors"
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        {/* the position it buys: pay × leverage */}
        <div className="flex flex-col gap-1 px-2.5 py-2 bg-void border border-line rounded-md">
          <div className="flex items-baseline justify-between text-[10px]">
            <span className={long ? "text-bid" : "text-ask"}>
              {long ? "Long" : "Short"}:{" "}
              <span className="tnum">
                $
                {notional.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </span>
            </span>
            {target > 0 && notional < target && lots >= 1 && (
              <span className="text-dim tnum">
                rounded from $
                {target.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="tnum w-full text-[16px] text-bright">
              {sizeBtc
                ? sizeBtc.toLocaleString(undefined, {
                    maximumFractionDigits: anqa.marketInfo.sizeDp,
                  })
                : 0}
            </span>
            <span className="shrink-0 text-[11px] font-medium text-muted bg-raised border border-line rounded px-1.5 py-0.5">
              {anqa.marketInfo.base}
            </span>
          </div>
        </div>

        {/* leverage */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted">Leverage</span>
            <div className="flex items-center gap-1 h-6 px-1.5 bg-void border border-line rounded">
              <input
                value={lev}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n))
                    setLev(Math.min(MAX_LEV, Math.max(0, n)));
                }}
                inputMode="decimal"
                className="tnum w-8 bg-transparent text-right text-[11px] text-bright outline-none"
              />
              <span className="text-[10px] text-dim">x</span>
            </div>
          </div>
          <div className="flex items-center gap-2 py-1">
            <span className="tnum text-[10px] text-dim">0x</span>
            <input
              type="range"
              min={0}
              max={MAX_LEV}
              step={0.5}
              value={lev}
              onChange={(e) => setLev(Number(e.target.value))}
              className="lev-slider flex-1"
              style={{ ["--fill" as string]: `${(lev / MAX_LEV) * 100}%` }}
            />
            <span className="tnum text-[10px] text-dim">{MAX_LEV}x</span>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {LEV_PRESETS.map((l) => (
              <button
                key={l}
                onClick={() => setLev(l)}
                className={`h-6 text-[10px] font-medium rounded border transition-colors ${
                  lev === l
                    ? "border-phoenix/50 text-ember bg-phoenix/10"
                    : "border-line text-dim hover:text-text hover:border-phoenix-soft"
                }`}
              >
                {l}x
              </button>
            ))}
          </div>
          {lev > 20 && (
            <p className="text-[10px] text-phoenix/80 leading-relaxed">
              Above the venue&rsquo;s 20x initial margin — needs free collateral
              beyond your pay amount.
            </p>
          )}
        </div>

        {/* take profit / stop loss */}
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => setTpslOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-muted hover:text-text transition-colors select-none"
          >
            <span
              className={`inline-block text-[9px] transition-transform ${
                tpslOpen ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
            Take Profit / Stop Loss
          </button>
          {tpslOpen && (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                <TriggerField
                  label="Take profit"
                  value={tp}
                  onChange={setTp}
                  placeholder={
                    effPrice
                      ? (effPrice * (long ? 1.05 : 0.95)).toFixed(2)
                      : "0.00"
                  }
                />
                <TriggerField
                  label="Stop loss"
                  value={sl}
                  onChange={setSl}
                  placeholder={
                    effPrice
                      ? (effPrice * (long ? 0.95 : 1.05)).toFixed(2)
                      : "0.00"
                  }
                />
              </div>
              {lots >= 1 && (tpN > 0 || slN > 0) && (
                <div className="flex justify-between text-[10px] tnum">
                  <span className={tpN > 0 ? "text-bid" : "text-dim"}>
                    {tpN > 0
                      ? `est. +$${Math.abs(
                          (long ? tpN - effPrice : effPrice - tpN) * lots
                        ).toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}`
                      : ""}
                  </span>
                  <span className={slN > 0 ? "text-ask" : "text-dim"}>
                    {slN > 0
                      ? `est. −$${Math.abs(
                          (long ? effPrice - slN : slN - effPrice) * lots
                        ).toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}`
                      : ""}
                  </span>
                </div>
              )}
              <p className="text-[10px] text-dim leading-relaxed">
                Reduce-only. Armed automatically once the fill settles into a
                position.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 py-1.5 border-y border-line-soft">
          <Line
            label="Position value"
            value={
              notional
                ? `$${notional.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}`
                : "—"
            }
          />
          <Line
            label="Your risk"
            value={
              payUsd > 0
                ? `$${payUsd.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}`
                : "—"
            }
          />
          <Line
            label="Liq. price (est.)"
            value={
              liqPreview === null
                ? "—"
                : liqPreview.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })
            }
          />
        </div>

        {type === "limit" && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.08em] text-dim">
              Time in force
            </span>
            <div className="flex items-center p-0.5 bg-void border border-line rounded-md">
              {(
                [
                  ["gtc", "GTC"],
                  ["postOnly", "Post"],
                  ["ioc", "IOC"],
                  ["fok", "FOK"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setTif(v)}
                  title={
                    v === "gtc"
                      ? "Good till cancelled — rests until filled or cancelled"
                      : v === "postOnly"
                      ? "Post only — never takes; rejected instead of crossing"
                      : v === "ioc"
                      ? "Immediate or cancel — takes what's there, discards the rest"
                      : "Fill or kill — entire size fills now or nothing happens"
                  }
                  className={`h-6 px-2 text-[10px] font-medium rounded transition-colors ${
                    tif === v
                      ? "bg-raised text-bright"
                      : "text-dim hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-dim">
              {tif === "gtc"
                ? "rests until filled"
                : tif === "postOnly"
                ? "maker only, never takes"
                : tif === "ioc"
                ? "fills now, rest discarded"
                : "all or nothing, now"}
            </span>
          </div>
        )}

        {/* Shown on every dark market, including where it cannot be used. An
            order that fills on arrival has nothing to withhold from the ladder,
            but hiding the control taught nobody that — so it stays visible and
            disabled, and says why. */}
        {anqa.market?.dark && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.08em] text-dim">
              Visibility
            </span>
            <div className="flex items-center p-0.5 bg-void border border-line rounded-md">
              {(
                [
                  [false, "Shown"],
                  [true, "Hidden"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={label}
                  onClick={() => {
                    // Asking to hide a market order is not a mistake to refuse —
                    // it is a request for the only order that *can* be hidden.
                    // So the control converts the ticket instead of scolding:
                    // limit at the mark, good-till-cancelled, hidden.
                    if (v && !canRest) {
                      setType("limit");
                      setTif("gtc");
                      if (!price && mark !== null) setPrice(mark.toFixed(2));
                    }
                    setHidden(v);
                  }}
                  title={
                    v
                      ? canRest
                        ? "Hidden — kept off the public ladder. Same queue position, same fills; it appears on the tape once it trades."
                        : "Hidden needs an order that rests — this switches you to a limit order at the mark"
                      : "Shown — counted in the public depth at your price"
                  }
                  className={`h-6 px-2 text-[10px] font-medium rounded transition-colors ${
                    hidden === v && canRest
                      ? "bg-raised text-bright"
                      : "text-dim hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-dim">
              {!canRest
                ? "market fills on arrival — tap Hidden to rest instead"
                : hidden
                ? "off the ladder until it fills"
                : "adds to public depth"}
            </span>
          </div>
        )}

        {/* the next true action */}
        <div className="mt-auto pt-1 flex flex-col gap-1.5">
          {step === "connect" && <WalletButton />}

          {step === "trade" && (
            <>
              {needsDeposit ? (
                <p className="text-[10px] text-dim leading-relaxed">
                  Your account holds $
                  {allocatable.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  — deposit to trade this size.
                </p>
              ) : (
                blocker &&
                payUsd > 0 && (
                  <p className="text-[10px] text-ask leading-relaxed">
                    {blocker}
                  </p>
                )
              )}
              {needsDeposit ? (
                <button
                  className="cta cta-primary"
                  onClick={onDeposit}
                  disabled={!!busy}
                >
                  Deposit USDC to account
                </button>
              ) : (
                <button
                  className={`cta ${
                    long ? "cta-long" : "cta-short"
                  } flex flex-col items-center justify-center leading-tight`}
                  disabled={!!busy || !!blocker || !anqa.sessionKp || !MINT}
                  onClick={submit}
                >
                  <span>
                    {busy
                      ? `${busy}…`
                      : `Open ${long ? "long" : "short"}${
                          lots >= 1
                            ? ` · ${sizeBtc.toLocaleString(undefined, {
                                maximumFractionDigits: anqa.marketInfo.sizeDp,
                              })} ${anqa.marketInfo.base}`
                            : ""
                        }`}
                  </span>
                  {!busy && lots >= 1 && (
                    <span className="text-[10px] font-medium opacity-75">
                      $
                      {notional.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}{" "}
                      at {lev}x · risking $
                      {payUsd.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  )}
                </button>
              )}
            </>
          )}

          <p className="text-[10px] text-dim leading-relaxed">
            {step === "connect" && "Connect a wallet to trade."}
            {step === "trade" &&
              (needOpen
                ? "Isolated margin: the collateral you enter is this position's entire risk — it can never reach another market or your wallet. One signature opens this market; every order after is instant."
                : anqa.market?.dark
                ? "Your order names no counterparty. The engine settles the fill; only the price prints."
                : "Crosses the book directly.")}
          </p>
        </div>
      </div>
    </section>
  );
}

function TriggerField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5 bg-void border border-line rounded-md focus-within:border-phoenix-soft transition-colors">
      <span className="text-[9px] uppercase tracking-[0.08em] text-dim">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="decimal"
          className="tnum w-full bg-transparent text-[12px] text-bright outline-none placeholder:text-dim/60"
        />
        <span className="text-[9px] text-dim">USD</span>
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] text-dim">{label}</span>
      <span className="tnum text-[11px] text-text">{value}</span>
    </div>
  );
}
