// TradingView Lightweight Charts wrapper for the stock detail page.
// Renders candlesticks + volume + 21D/50D/180D MA overlays in the main pane
// and an RSI(14) pane below with a 50-line threshold marker.

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { Loader2 } from "lucide-react";
import { CHART_RANGES, type ChartData, type ChartRange } from "@/lib/stocks-api";

const MA_COLORS = {
  sma21: "#e5e7eb",  // white-ish
  sma50: "#3b82f6",  // blue
  sma180: "#f59e0b", // orange
} as const;

interface HoverInfo {
  o: number; h: number; l: number; c: number; v: number;
  sma21: number | null; sma50: number | null; sma180: number | null;
  rsi: number | null;
}

function lastHover(chart: ChartData): HoverInfo | null {
  const n = chart.candles.length;
  if (n === 0) return null;
  const c = chart.candles[n - 1];
  return {
    o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
    sma21: chart.sma21[n - 1] ?? null,
    sma50: chart.sma50[n - 1] ?? null,
    sma180: chart.sma180[n - 1] ?? null,
    rsi: chart.rsi14[n - 1] ?? null,
  };
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v == null || isNaN(v) ? "–" : v.toFixed(digits);
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function StockChart({ chart, range, onRangeChange, loading }: {
  chart: ChartData | null | undefined;
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !chart || chart.candles.length < 2) return;

    const api = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        fontSize: 10,
        panes: { separatorColor: "#1e293b", enableResize: false },
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.07)" },
        horzLines: { color: "rgba(148,163,184,0.07)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.15)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.15)",
        timeVisible: chart.resolution !== "1Day",
        secondsVisible: false,
      },
    });
    chartRef.current = api;

    const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;

    // Main pane: candles.
    const candleSeries = api.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f87171",
      borderUpColor: "#34d399",
      borderDownColor: "#f87171",
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
    });
    candleSeries.setData(chart.candles.map((c) => ({
      time: toTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c,
    })));

    // Volume histogram at the bottom of the main pane.
    const volumeSeries = api.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeSeries.setData(chart.candles.map((c) => ({
      time: toTime(c.t),
      value: c.v,
      color: c.c >= c.o ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)",
    })));

    // MA overlays.
    const maSeries: Partial<Record<keyof typeof MA_COLORS, ISeriesApi<"Line">>> = {};
    (Object.keys(MA_COLORS) as (keyof typeof MA_COLORS)[]).forEach((key) => {
      const values = chart[key];
      const data = chart.candles
        .map((c, i) => (values[i] != null ? { time: toTime(c.t), value: values[i] as number } : null))
        .filter((d): d is { time: UTCTimestamp; value: number } => d !== null);
      if (data.length === 0) return;
      const s = api.addSeries(LineSeries, {
        color: MA_COLORS[key],
        lineWidth: key === "sma21" ? 2 : 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(data);
      maSeries[key] = s;
    });

    // RSI pane below, with per-point green/red coloring around the 50-line.
    const rsiSeries = api.addSeries(LineSeries, {
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),
    }, 1);
    rsiSeries.setData(chart.candles
      .map((c, i) => (chart.rsi14[i] != null ? {
        time: toTime(c.t),
        value: chart.rsi14[i] as number,
        color: (chart.rsi14[i] as number) >= 50 ? "#34d399" : "#f87171",
      } : null))
      .filter((d): d is { time: UTCTimestamp; value: number; color: string } => d !== null));
    rsiSeries.createPriceLine({
      price: 50,
      color: "#94a3b8",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "50",
    });

    const panes = api.panes();
    if (panes.length > 1) panes[1].setHeight(90);

    api.timeScale().fitContent();

    // Crosshair → legend values.
    const byTime = new Map<number, number>();
    chart.candles.forEach((c, i) => byTime.set(c.t / 1000, i));
    const onCrosshair = (param: { time?: unknown }) => {
      const idx = typeof param.time === "number" ? byTime.get(param.time) : undefined;
      if (idx == null) { setHover(lastHover(chart)); return; }
      const c = chart.candles[idx];
      setHover({
        o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
        sma21: chart.sma21[idx] ?? null,
        sma50: chart.sma50[idx] ?? null,
        sma180: chart.sma180[idx] ?? null,
        rsi: chart.rsi14[idx] ?? null,
      });
    };
    api.subscribeCrosshairMove(onCrosshair);
    setHover(lastHover(chart));

    return () => {
      api.unsubscribeCrosshairMove(onCrosshair);
      api.remove();
      chartRef.current = null;
    };
  }, [chart]);

  const bullishAlignment =
    hover?.sma21 != null && hover?.sma50 != null && hover.sma21 > hover.sma50;

  return (
    <div>
      {/* Timeframe tabs */}
      <div className="flex items-center gap-1 mb-2">
        {CHART_RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            data-testid={`chart-range-${r}`}
            className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${
              range === r
                ? "bg-emerald-500/15 text-emerald-400"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r}
          </button>
        ))}
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground ml-1" />}
      </div>

      {/* Legend */}
      {hover && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono text-muted-foreground mb-1.5">
          <span>O <span className="text-foreground">{fmt(hover.o)}</span></span>
          <span>H <span className="text-foreground">{fmt(hover.h)}</span></span>
          <span>L <span className="text-foreground">{fmt(hover.l)}</span></span>
          <span>C <span className={hover.c >= hover.o ? "text-emerald-400" : "text-red-400"}>{fmt(hover.c)}</span></span>
          <span>Vol <span className="text-foreground">{fmtVol(hover.v)}</span></span>
          <span style={{ color: MA_COLORS.sma21 }}>MA21 {fmt(hover.sma21)}</span>
          <span style={{ color: MA_COLORS.sma50 }}>MA50 {fmt(hover.sma50)}</span>
          <span style={{ color: MA_COLORS.sma180 }}>MA180 {fmt(hover.sma180)}</span>
          <span className={hover.rsi != null && hover.rsi >= 50 ? "text-emerald-400" : "text-red-400"}>
            RSI {fmt(hover.rsi, 0)}
          </span>
          {bullishAlignment && (
            <span className="px-1.5 py-px rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 font-sans font-semibold">
              21D &gt; 50D bullish
            </span>
          )}
        </div>
      )}

      {/* Chart container */}
      {!chart || chart.candles.length < 2 ? (
        <div className="h-[340px] flex items-center justify-center text-sm text-muted-foreground">
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "No chart data for this range"}
        </div>
      ) : (
        <div ref={containerRef} className="h-[340px] w-full" data-testid="stock-chart" />
      )}
    </div>
  );
}
