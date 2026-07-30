"use client";

import { useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { Badge, Button, Empty, Panel, Stat } from "./ui";
import { readableError } from "./OrderEntry";
import { cancelTrigger, closePosition, placeTrigger } from "@/lib/actions";
import { usd, usdToTicks } from "@/lib/anqa";
import { freeMargin, readKernel } from "@/lib/portfolio";
import type { Anqa } from "@/lib/useAnqa";

/**
 * Position, margin, and protection.
 *
 * The stop-loss controls here write into slots inside the portfolio itself —
 * which is why they survive a session: a trigger delegates with the account
 * and fires inside the rollup, next to the book it closes into.
 */
export function PositionPanel({
  anqa,
  onDone,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stop, setStop] = useState("");
  const owner = anqa.wallet?.publicKey;

  const kernel = useMemo(
    () => (anqa.portfolio ? readKernel(anqa.portfolio.inner) : null),
    [anqa.portfolio]
  );
  const reserved = anqa.portfolio
    ? BigInt(new BN(anqa.portfolio.reservedMargin, 10, "le").toString())
    : 0n;

  const position = kernel?.positions.find(
    (p) => p.assetIndex === (anqa.market?.assetIndex ?? 0)
  );
  const mark = anqa.markPrice;
  const tick = anqa.market?.tickSize ?? 1;

  const run = async (label: string, fn: (p: any, c: any) => Promise<any>) => {
    const p = anqa.programFor("er");
    if (!p || !owner) return;
    setBusy(true);
    try {
      await fn(p, { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner });
      onDone(`${label} done`);
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(false);
    }
  };

  const flatten = () => {
    if (!mark) return;
    // Reduce-only, bounded 4% away so a thin book cannot fill it anywhere.
    const worst = position?.isLong ? mark * 0.96 : mark * 1.04;
    run("Close", (p, c) =>
      closePosition(p, c, new BN(usdToTicks(worst / 1e6, tick)), new BN(0), [])
    );
  };

  const arm = () => {
    const price = Number(stop);
    if (!price || !position) return onDone("Stop price required", true);
    const atoms = Math.round(price * 1e6);
    // A long is protected below, a short above.
    const direction = position.isLong ? ("below" as const) : ("above" as const);
    const limit = position.isLong ? price * 0.97 : price * 1.03;
    run("Stop armed", (p, c) =>
      placeTrigger(p, c, {
        triggerId: new BN(Date.now() % 1_000_000),
        triggerPrice: new BN(atoms),
        direction,
        limitPriceInTicks: new BN(usdToTicks(limit, tick)),
        maxBaseLots: new BN(0), // whatever the position is when it fires
      })
    );
    setStop("");
  };

  return (
    <Panel
      title="position"
      right={
        position ? (
          <Badge tone={position.isLong ? "live" : "warn"}>
            {position.isLong ? "long" : "short"}
          </Badge>
        ) : undefined
      }
      bodyClassName="flex flex-col overflow-hidden"
    >
      {!kernel ? (
        <Empty>No account yet.</Empty>
      ) : (
        <>
          <div className="shrink-0 grid grid-cols-2 gap-3 p-3 border-b border-line-soft">
            <Stat
              label="size"
              value={position ? `${position.lots} lots` : "flat"}
              tone={position ? (position.isLong ? "bid" : "ask") : "default"}
            />
            <Stat
              label="unrealised"
              value={usd(kernel.pnl.toString())}
              tone={kernel.pnl > 0n ? "bid" : kernel.pnl < 0n ? "ask" : "default"}
            />
            <Stat label="capital" value={usd(kernel.capital.toString())} />
            <Stat
              label="free margin"
              value={usd(freeMargin(kernel, reserved).toString())}
              hint={reserved > 0n ? `${usd(reserved.toString())} in orders` : undefined}
            />
          </div>

          {position && (
            <div className="shrink-0 flex gap-1.5 p-3 border-b border-line-soft">
              <Button size="sm" variant="ghost" disabled={busy} onClick={flatten}>
                {busy ? "…" : "Close position"}
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between shrink-0 px-3 h-8 border-b border-line-soft">
            <span className="text-[10px] uppercase tracking-[0.12em] text-dim">
              stops
            </span>
          </div>

          {position && (
            <div className="shrink-0 flex gap-1.5 p-3 pb-2">
              <input
                value={stop}
                onChange={(e) => setStop(e.target.value)}
                placeholder={
                  mark ? ((mark / 1e6) * (position.isLong ? 0.97 : 1.03)).toFixed(2) : "0.00"
                }
                inputMode="decimal"
                className="tnum flex-1 min-w-0 h-7 bg-void border border-line rounded px-2 text-[12px]
                           text-bright outline-none focus:border-phoenix-soft placeholder:text-dim/60"
              />
              <Button size="sm" disabled={busy} onClick={arm}>
                Arm
              </Button>
            </div>
          )}

          {anqa.triggers.length === 0 ? (
            <div className="px-3 pb-3 text-[10px] text-dim leading-relaxed">
              {position
                ? "No stop set. A stop lives in your account, so it travels with you into the rollup and fires there."
                : "Open a position to protect it."}
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto">
              {anqa.triggers.map((t) => (
                <div
                  key={t.id}
                  className="group flex items-center justify-between px-3 py-[6px] text-[12px] hover:bg-surface/60"
                >
                  <span className="text-[10px] uppercase tracking-wide text-dim w-10">
                    {t.direction === "below" ? "stop" : "take"}
                  </span>
                  <span className="tnum flex-1 text-text">
                    {usd(t.price.toString())}
                  </span>
                  <button
                    onClick={() => run("Cancelled", (p, c) => cancelTrigger(p, c, new BN(t.id)))}
                    disabled={busy}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-dim hover:text-ask"
                  >
                    cancel
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
