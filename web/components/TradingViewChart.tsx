"use client";

import { memo, useEffect, useRef, useState } from "react";

/** Our markets, mapped to TradingView's symbols. */
const SYMBOLS: Record<string, string> = {
  // Exchange listings rather than PYTH:* — the raw Pyth symbols render with
  // eight decimals on TradingView's axis, which reads like a bug. The venue
  // tab remains the Pyth-pure view; this one is for chart tooling.
  "BTC-PERP": "COINBASE:BTCUSD",
  "SOL-PERP": "COINBASE:SOLUSD",
  "ETH-PERP": "COINBASE:ETHUSD",
};

/**
 * TradingView's Advanced Chart, embedded.
 *
 * The symbol is a **PYTH** feed on purpose rather than an exchange ticker:
 * `sync_internal_oracle` relays a Pyth price on-chain and the crank marks
 * every position against it, so this is the venue's own reference price with
 * TradingView's tooling on top — not a lookalike borrowed from Binance.
 *
 * Two details the embed is fussy about, both learned the hard way: the script
 * must sit inside an element carrying `tradingview-widget-container` **next
 * to** a `__widget` child it renders into, and the container needs real
 * height rather than only absolute insets.
 *
 * It also fails silently when a privacy extension blocks s3.tradingview.com,
 * which looks identical to a broken app. So load is verified, and a blocked
 * widget says so instead of leaving a black rectangle.
 */
export const TradingViewChart = memo(function TradingViewChart({
  market = "BTC-PERP",
  interval = "240",
  onUnavailable,
}: {
  market?: string;
  interval?: string;
  onUnavailable?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);

  // Held in a ref, never a dependency. The venue polls every 1.5s, so a
  // callback prop re-created each render would tear this widget down and
  // rebuild it before it ever finished loading — which looks exactly like a
  // chart that does not work.
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setBlocked(false);
    el.innerHTML = "";

    // The structure TradingView's embed expects.
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    inner.style.width = "100%";
    el.appendChild(inner);

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: SYMBOLS[market] ?? "COINBASE:BTCUSD",
      interval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1", // candles
      locale: "en",
      // A real color, not transparent: the widget derives its legend/text
      // contrast from this, and "transparent" reads as light — black text
      // on our black panel.
      backgroundColor: "#0e0f12",
      gridColor: "rgba(35,40,51,0.35)",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      hide_volume: false,
      support_host: "https://www.tradingview.com",
    });
    script.onerror = () => {
      setBlocked(true);
      onUnavailableRef.current?.();
    };
    el.appendChild(script);

    // An iframe should appear within a few seconds. If none does, the request
    // was blocked or never resolved — say so rather than show nothing.
    const check = setTimeout(() => {
      if (!el.querySelector("iframe")) {
        setBlocked(true);
        onUnavailableRef.current?.();
      }
    }, 6000);

    return () => {
      clearTimeout(check);
      el.innerHTML = "";
    };
  }, [market, interval]);

  return (
    <div className="absolute inset-0">
      <div
        ref={host}
        className="tradingview-widget-container"
        style={{ height: "100%", width: "100%", minHeight: 320 }}
      />
      {blocked && (
        <div className="absolute inset-0 grid place-items-center bg-ink/95 px-6">
          <div className="max-w-sm text-center">
            <p className="text-[13px] text-text mb-1.5">
              TradingView did not load.
            </p>
            <p className="text-[11px] text-dim leading-relaxed">
              Their embed is served from <span className="text-muted">s3.tradingview.com</span>,
              which ad and privacy blockers routinely stop. Allow that host, or
              switch to <span className="text-phoenix">Venue fills</span> above —
              that chart is drawn locally and also carries this venue&apos;s own
              trades.
            </p>
          </div>
        </div>
      )}
    </div>
  );
});
