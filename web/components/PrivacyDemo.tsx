"use client";

import { useEffect, useState } from "react";

type DemoStatus = "idle" | "resting" | "matched";

const PUBLIC_ASKS = [
  ["64,849.00", "0.430"],
  ["64,844.00", "0.690"],
] as const;

const PUBLIC_BIDS = [
  ["64,575.00", "0.540"],
  ["64,568.00", "0.710"],
] as const;

export function PrivacyDemo() {
  const [hidden, setHidden] = useState(true);
  const [status, setStatus] = useState<DemoStatus>("idle");
  const [remaining, setRemaining] = useState(10);

  useEffect(() => {
    if (status !== "resting") return;

    const timer = window.setInterval(() => {
      setRemaining((current) => {
        if (current > 1) return current - 1;
        window.clearInterval(timer);
        setStatus("matched");
        return 0;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [status]);

  const startDemo = () => {
    setRemaining(10);
    setStatus("resting");
  };

  const resetDemo = () => {
    setRemaining(10);
    setStatus("idle");
  };

  const orderIsPublic = !hidden && status === "resting";

  return (
    <div className="landing-demo overflow-hidden rounded-2xl border border-line bg-ink shadow-2xl shadow-black/40">
      <div className="flex flex-col gap-4 border-b border-line-soft px-5 py-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-bid" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-bright">
              Interactive order lifecycle
            </span>
          </div>
          <p className="mt-1.5 text-[10px] text-dim">Illustrative data · no wallet or transaction required</p>
        </div>

        <div className="sm:ml-auto flex rounded-lg border border-line bg-void p-1">
          <button
            type="button"
            disabled={status === "resting"}
            onClick={() => setHidden(false)}
            className={`rounded-md px-3 py-2 text-[10px] font-medium transition-colors disabled:cursor-not-allowed ${
              !hidden ? "bg-raised text-bright" : "text-dim hover:text-text"
            }`}
          >
            Shown order
          </button>
          <button
            type="button"
            disabled={status === "resting"}
            onClick={() => setHidden(true)}
            className={`rounded-md px-3 py-2 text-[10px] font-medium transition-colors disabled:cursor-not-allowed ${
              hidden ? "bg-phoenix/10 text-phoenix" : "text-dim hover:text-text"
            }`}
          >
            Hidden order
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-line-soft lg:border-b-0 lg:border-r">
          <div className="flex items-center border-b border-line-soft px-5 py-3.5">
            <span className="text-[10px] font-medium text-bright">Public market view</span>
            <span className="ml-auto rounded border border-line px-2 py-1 text-[8px] uppercase tracking-[0.12em] text-dim">
              RPC read
            </span>
          </div>

          <div className="p-4 sm:p-5">
            <div className="grid grid-cols-2 px-3 pb-2 text-[8px] uppercase tracking-[0.13em] text-dim">
              <span>Price</span>
              <span className="text-right">Size</span>
            </div>
            {PUBLIC_ASKS.map(([price, size]) => (
              <DemoBookRow key={price} price={price} size={size} side="ask" />
            ))}

            <div className="my-2 grid grid-cols-2 border-y border-line-soft bg-surface/60 px-3 py-2.5 text-[10px]">
              <span className="tnum text-text">1.00 spread</span>
              <span className="tnum text-right text-muted">0.014%</span>
            </div>

            {orderIsPublic && (
              <div className="landing-demo-order relative my-1 grid grid-cols-2 overflow-hidden rounded-md border border-phoenix-soft px-3 py-2 text-[10px]">
                <span className="tnum relative text-phoenix">64,580.00</span>
                <span className="tnum relative text-right text-bright">0.154</span>
                <span className="absolute right-2 top-0.5 text-[7px] uppercase tracking-[0.1em] text-phoenix">your order</span>
              </div>
            )}

            {PUBLIC_BIDS.map(([price, size]) => (
              <DemoBookRow key={price} price={price} size={size} side="bid" />
            ))}

            {status === "matched" && (
              <div className="landing-match-pop mt-4 flex items-center justify-between rounded-lg border border-bid/30 bg-bid/5 px-3 py-3 text-[9px]">
                <span className="font-medium text-bid">Settled fill · public</span>
                <span className="tnum text-text">$64,580 × 0.154</span>
              </div>
            )}

            <div className={`mt-4 flex min-h-12 items-center rounded-lg border px-3 text-[10px] leading-5 ${
              hidden && status === "resting"
                ? "border-phoenix-soft bg-phoenix/5 text-phoenix"
                : "border-line-soft bg-void/50 text-dim"
            }`}>
              {hidden && status === "resting"
                ? "The order is resting, but this public ladder receives no price or size update."
                : orderIsPublic
                  ? "Shown orders contribute their price and size to public depth."
                  : status === "matched"
                    ? "Fill price and size are public by design. Counterparty identity and portfolios are not."
                    : "Place the illustrative order to compare what the market can observe."}
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center border-b border-line-soft px-5 py-3.5">
            <span className="text-[10px] font-medium text-bright">Private execution view</span>
            <span className="ml-auto flex items-center gap-1.5 text-[8px] uppercase tracking-[0.12em] text-phoenix">
              <span className="h-1 w-1 rounded-full bg-phoenix" /> PER boundary
            </span>
          </div>

          <div className="flex min-h-[330px] flex-col p-5 sm:p-6">
            <div className="grid gap-2 sm:grid-cols-3">
              <DemoMetric label="Side" value="Long / Buy" />
              <DemoMetric label="Size" value="0.154 BTC" />
              <DemoMetric label="Limit" value="$64,580" />
            </div>

            <div className="relative mt-5 flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-line-soft bg-void/55 p-6 text-center">
              <div className="landing-demo-grid absolute inset-0 opacity-45" aria-hidden="true" />
              <div className="relative">
                {status === "idle" && (
                  <>
                    <div className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-line bg-surface text-phoenix">＋</div>
                    <p className="mt-4 text-[13px] font-medium text-bright">Ready to place</p>
                    <p className="mt-2 max-w-[300px] text-[10px] leading-5 text-muted">
                      Choose shown or hidden, then watch the same order move through the protocol.
                    </p>
                  </>
                )}

                {status === "resting" && (
                  <>
                    <div className="landing-countdown mx-auto grid h-16 w-16 place-items-center rounded-full border border-phoenix-soft bg-phoenix/5">
                      <span className="tnum text-xl font-medium text-phoenix">{remaining}s</span>
                    </div>
                    <p className="mt-4 text-[13px] font-medium text-bright">Order resting with full priority</p>
                    <p className="mt-2 text-[10px] leading-5 text-muted">
                      The devnet demo keeper submits an opposite order after the resting window.
                    </p>
                    <div className="mx-auto mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-phoenix transition-[width] duration-1000 ease-linear"
                        style={{ width: `${((10 - remaining) / 10) * 100}%` }}
                      />
                    </div>
                  </>
                )}

                {status === "matched" && (
                  <>
                    <div className="landing-match-pop mx-auto grid h-11 w-11 place-items-center rounded-full bg-bid/12 text-lg text-bid">✓</div>
                    <p className="mt-4 text-[13px] font-medium text-bright">Matched. Position opened.</p>
                    <p className="mt-2 text-[10px] leading-5 text-muted">
                      Fill price and size become public. The trader and resulting portfolio remain private.
                    </p>
                    <div className="mt-4 flex justify-center gap-2 text-[9px]">
                      <span className="rounded border border-line px-2 py-1 text-muted">LONG 0.154 BTC</span>
                      <span className="rounded border border-bid/30 bg-bid/5 px-2 py-1 text-bid">Position active</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {status === "idle" ? (
                <button type="button" onClick={startDemo} className="cta flex h-11 flex-1 items-center justify-center bg-phoenix text-void">
                  Place demo {hidden ? "hidden" : "shown"} order
                </button>
              ) : (
                <button type="button" onClick={resetDemo} className="flex h-11 flex-1 items-center justify-center rounded-lg border border-line bg-surface text-[11px] font-medium text-text hover:border-phoenix-soft hover:text-bright">
                  Reset lifecycle
                </button>
              )}
              <div className="flex h-11 items-center justify-center gap-2 rounded-lg border border-line-soft px-4 text-[9px] text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-bid" /> Session key ready
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DemoBookRow({ price, size, side }: { price: string; size: string; side: "bid" | "ask" }) {
  return (
    <div className="relative grid grid-cols-2 overflow-hidden rounded px-3 py-2 text-[10px]">
      <span className={`absolute inset-y-0 right-0 w-1/3 ${side === "bid" ? "bg-bid/5" : "bg-ask/5"}`} />
      <span className={`tnum relative ${side === "bid" ? "text-bid" : "text-ask"}`}>{price}</span>
      <span className="tnum relative text-right text-muted">{size}</span>
    </div>
  );
}

function DemoMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-void/45 px-3 py-3">
      <p className="text-[8px] uppercase tracking-[0.13em] text-dim">{label}</p>
      <p className="tnum mt-1.5 text-[11px] text-bright">{value}</p>
    </div>
  );
}
