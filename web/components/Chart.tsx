"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { lotFraction, ticksToUsd } from "@/lib/anqa";
import { useAllPositions } from "@/lib/useAllPositions";
import { TradingViewChart } from "./TradingViewChart";
import type { Anqa } from "@/lib/useAnqa";

const RESOLUTIONS = [
  { label: "1m", value: "1", span: 60 * 60 * 6 },
  { label: "5m", value: "5", span: 60 * 60 * 24 },
  { label: "15m", value: "15", span: 60 * 60 * 24 * 3 },
  { label: "1h", value: "60", span: 60 * 60 * 24 * 14 },
  { label: "4h", value: "240", span: 60 * 60 * 24 * 60 },
  { label: "1D", value: "1D", span: 60 * 60 * 24 * 365 },
] as const;

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * The price chart.
 *
 * History comes from Pyth Benchmarks — the same feed the venue marks
 * against — and the live candle is then driven by the venue's own mark as
 * the keeper cranks it, so the right edge is anqa's price rather than a
 * delayed copy of somebody else's.
 *
 * Fills from the tape are drawn as markers. On a dark market those are the
 * only trades anyone can point at, which makes them the most informative
 * thing on the chart.
 */
export function Chart({ anqa }: { anqa: Anqa }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // The markers plugin is generic over the series' time type; keeping the
  // handle loose avoids fighting that generic for no benefit.
  const markersRef = useRef<{ setMarkers: (m: any[]) => void } | null>(null);
  const liqLineRef = useRef<IPriceLine | null>(null);
  const lastBar = useRef<Candle | null>(null);
  const positions = useAllPositions();

  const [res, setRes] = useState<(typeof RESOLUTIONS)[number]>(RESOLUTIONS[1]);
  const [loading, setLoading] = useState(true);
  const [ohlc, setOhlc] = useState<Candle | null>(null);
  /**
   * Which chart. TradingView brings its own tooling; the native one is the
   * only place anqa's own fills can be drawn, because the free widget has no
   * way to accept an external datafeed. Neither is a strict upgrade, so both
   * stay.
   */
  const [source, setSource] = useState<"tradingview" | "venue">("tradingview");

  // ── build the chart once ────────────────────────────────────────────────
  useEffect(() => {
    if (source !== "venue") return;
    if (!box.current) return;
    const chart = createChart(box.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#646b78",
        fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(38,42,50,0.5)" },
        horzLines: { color: "rgba(38,42,50,0.5)" },
      },
      rightPriceScale: {
        borderColor: "#1e2127",
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: { borderColor: "#1e2127", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: 0,
        vertLine: { color: "#646b78", width: 1, style: 3, labelBackgroundColor: "#1b1e24" },
        horzLine: { color: "#646b78", width: 1, style: 3, labelBackgroundColor: "#1b1e24" },
      },
      autoSize: true,
    });

    const candles = chart.addSeries(CandlestickSeries, {
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      upColor: "#2ebd85",
      downColor: "#f6465d",
      borderUpColor: "#2ebd85",
      borderDownColor: "#f6465d",
      wickUpColor: "#2ebd85",
      wickDownColor: "#f6465d",
      priceLineColor: "#4c8dff",
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = volume;
    markersRef.current = createSeriesMarkers(candles, []);

    // The OHLC readout follows the crosshair, like a real terminal.
    chart.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(candles) as Candle | undefined;
      setOhlc(d ?? lastBar.current);
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      markersRef.current = null;
      liqLineRef.current = null; // died with its series
    };
  }, [source]);

  // ── the liquidation line: the price where this position dies ────────────
  useEffect(() => {
    const series = candleRef.current;
    if (source !== "venue" || !series) return;
    if (liqLineRef.current) {
      series.removePriceLine(liqLineRef.current);
      liqLineRef.current = null;
    }
    const row = positions.find((r) => r.market.id === anqa.marketInfo.id);
    if (!row || row.liq === null) return;
    liqLineRef.current = series.createPriceLine({
      price: row.liq,
      color: "#f6465d",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `LIQ ${row.isLong ? "long" : "short"} ${row.size.toLocaleString(undefined, { maximumFractionDigits: anqa.marketInfo.sizeDp })}`,
    });
  }, [positions, anqa.marketInfo.id, source, loading]);

  // ── load history whenever the timeframe changes ─────────────────────────
  useEffect(() => {
    if (source !== "venue") return;
    let cancelled = false;
    setLoading(true);
    const to = Math.floor(Date.now() / 1000);
    const from = to - res.span;
    fetch(
      `/api/candles?resolution=${res.value}&from=${from}&to=${to}&symbol=${encodeURIComponent(anqa.marketInfo.pythSymbol)}`
    )
      .then((r) => r.json())
      .then(({ candles }: { candles: Candle[] }) => {
        if (cancelled || !candleRef.current || !volRef.current) return;
        const bars = (candles ?? []).filter((c) => Number.isFinite(c.close));
        candleRef.current.setData(
          bars.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );
        volRef.current.setData(
          bars.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? "rgba(63,178,127,0.28)" : "rgba(224,87,79,0.28)",
          }))
        );
        lastBar.current = bars[bars.length - 1] ?? null;
        setOhlc(lastBar.current);
        chartRef.current?.timeScale().fitContent();
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [res, source]);

  // ── drive the right edge from the venue's own mark ──────────────────────
  useEffect(() => {
    if (source !== "venue") return;
    if (anqa.markPrice === null || !candleRef.current || !lastBar.current) return;
    // Per-lot mark → per-BTC, the unit the candles are drawn in.
    const price = anqa.markPrice / 1e6 / lotFraction(anqa.market);
    const secs = res.value === "1D" ? 86400 : Number(res.value) * 60;
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / secs) * secs;

    const prev = lastBar.current;
    const bar: Candle =
      bucket > prev.time
        ? { time: bucket, open: prev.close, high: price, low: price, close: price, volume: 0 }
        : {
            ...prev,
            high: Math.max(prev.high, price),
            low: Math.min(prev.low, price),
            close: price,
          };
    lastBar.current = bar;
    candleRef.current.update({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
    setOhlc((o) => (o && o.time !== bar.time ? o : bar));
  }, [anqa.markPrice, res, source]);

  // ── the venue's own fills, marked on the chart ──────────────────────────
  useEffect(() => {
    if (source !== "venue" || !markersRef.current) return;
    const tick = anqa.market?.tickSize ?? 1;
    const frac = lotFraction(anqa.market);
    const secs = res.value === "1D" ? 86400 : Number(res.value) * 60;
    markersRef.current.setMarkers(
      [...anqa.tape]
        .reverse()
        .slice(-40)
        .map((p) => ({
          time: (Math.floor(p.timestamp / secs) * secs) as UTCTimestamp,
          position: "belowBar" as const,
          color: "#4c8dff",
          shape: "arrowUp" as const,
          text: `${(p.baseLots * frac).toLocaleString(undefined, { maximumFractionDigits: 4 })} @ ${(ticksToUsd(p.priceInTicks, tick) / frac).toFixed(0)}`,
        }))
    );
  }, [anqa.tape, anqa.market, res, source]);

  const up = ohlc ? ohlc.close >= ohlc.open : true;
  const fmt = (n: number | undefined) =>
    n === undefined ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2 });

  const tv = source === "tradingview";

  return (
    <section className="flex flex-col h-full min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
      <header className="flex items-center gap-1 shrink-0 h-9 px-2 border-b border-line-soft">
        {RESOLUTIONS.map((r) => (
          <button
            key={r.value}
            onClick={() => setRes(r)}
            className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
              r.value === res.value ? "bg-raised text-phoenix" : "text-dim hover:text-text"
            }`}
          >
            {r.label}
          </button>
        ))}

        {/* Two charts, because neither is a strict upgrade on the other. */}
        <div className="ml-auto flex items-center gap-0.5 bg-void/60 rounded p-0.5">
          {(
            [
              ["tradingview", "TradingView"],
              ["venue", "Venue fills"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSource(key)}
              title={
                key === "tradingview"
                  ? "TradingView Advanced Chart on the PYTH feed the venue marks against"
                  : "anqa's own mark, with this venue's fills marked on it"
              }
              className={`h-5 px-2 rounded text-[10px] font-medium transition-colors ${
                source === key ? "bg-raised text-phoenix" : "text-dim hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="relative flex-1 min-h-[300px]">
        {tv ? (
          <TradingViewChart
            market={anqa.marketInfo.symbol}
            interval={res.value}
            // If their embed is blocked, fall back to the chart we draw
            // ourselves rather than leaving the trader looking at nothing.
            onUnavailable={() => setSource("venue")}
          />
        ) : (
          <>
            {/* OHLC readout, top-left, the way every terminal does it */}
            <div className="absolute z-10 top-2 left-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] pointer-events-none">
              <span className="text-muted font-medium">{anqa.marketInfo.symbol}</span>
              <span className="text-dim">
                O <span className={`tnum ${up ? "text-bid" : "text-ask"}`}>{fmt(ohlc?.open)}</span>
              </span>
              <span className="text-dim">
                H <span className={`tnum ${up ? "text-bid" : "text-ask"}`}>{fmt(ohlc?.high)}</span>
              </span>
              <span className="text-dim">
                L <span className={`tnum ${up ? "text-bid" : "text-ask"}`}>{fmt(ohlc?.low)}</span>
              </span>
              <span className="text-dim">
                C <span className={`tnum ${up ? "text-bid" : "text-ask"}`}>{fmt(ohlc?.close)}</span>
              </span>
              {anqa.tape.length > 0 && (
                <span className="text-phoenix/80">▲ {anqa.tape.length} fills</span>
              )}
            </div>

            {loading && (
              <div className="absolute inset-0 z-10 grid place-items-center">
                <span className="text-[12px] text-dim">loading history…</span>
              </div>
            )}
            <div ref={box} className="absolute inset-0" />
          </>
        )}
      </div>
    </section>
  );
}
