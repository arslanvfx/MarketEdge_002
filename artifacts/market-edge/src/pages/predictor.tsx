import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RTooltip,
  ReferenceLine,
} from "recharts";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  Radio,
  Gauge,
  Waves,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Types (mirror the api-server crypto endpoints)
// ---------------------------------------------------------------------------

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Prediction {
  target: string;
  label: string;
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  changePct: number;
}

interface CoinPrediction {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
  change1hPct: number;
  high24h: number;
  low24h: number;
  indicators: {
    rsi: number;
    sma20: number;
    ema12: number;
    ema26: number;
    macd: number;
    trend: "up" | "down" | "flat";
    trendStrength: number;
    volatilityPct: number;
  };
  sparkline: number[];
  candles: Candle[];
  predictions: Prediction[];
}

interface CoinPrice {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COIN_STYLE: Record<string, { glyph: string; accent: string; ring: string; glow: string }> = {
  BTC:  { glyph: "₿", accent: "text-amber-400",  ring: "ring-amber-500/40 border-amber-500/40",  glow: "shadow-amber-500/20" },
  ETH:  { glyph: "Ξ", accent: "text-indigo-400", ring: "ring-indigo-500/40 border-indigo-500/40", glow: "shadow-indigo-500/20" },
  SOL:  { glyph: "◎", accent: "text-fuchsia-400",ring: "ring-fuchsia-500/40 border-fuchsia-500/40",glow: "shadow-fuchsia-500/20" },
  XRP:  { glyph: "✕", accent: "text-sky-400",    ring: "ring-sky-500/40 border-sky-500/40",       glow: "shadow-sky-500/20" },
  LINK: { glyph: "⬡", accent: "text-blue-400",   ring: "ring-blue-500/40 border-blue-500/40",     glow: "shadow-blue-500/20" },
  DOGE: { glyph: "Ð", accent: "text-yellow-400", ring: "ring-yellow-500/40 border-yellow-500/40", glow: "shadow-yellow-500/20" },
};

function formatPrice(p: number): string {
  if (!isFinite(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return p.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function formatPct(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

function estClock(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
}

// True Eastern abbreviation for the given moment ("EST" in winter, "EDT" in summer).
function etAbbrev(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).formatToParts(d);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "ET";
}

function estCandleLabel(t: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(t * 1000));
}

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

const DIR = {
  up:   { icon: TrendingUp,   color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", stroke: "#34d399" },
  down: { icon: TrendingDown, color: "text-red-400",     bg: "bg-red-500/10",     border: "border-red-500/30",     stroke: "#f87171" },
  flat: { icon: Minus,        color: "text-slate-400",   bg: "bg-slate-500/10",   border: "border-slate-500/30",   stroke: "#94a3b8" },
};

// ---------------------------------------------------------------------------
// Mini sparkline (SVG, no axes) for the coin selector
// ---------------------------------------------------------------------------

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return <div className="h-8" />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 100;
  const h = 32;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Live price number with green/red flash on change
// ---------------------------------------------------------------------------

function LivePrice({ price, className }: { price: number; className?: string }) {
  const prev = useRef(price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (price > prev.current) setFlash("up");
    else if (price < prev.current) setFlash("down");
    prev.current = price;
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [price]);

  return (
    <span
      className={`tabular-nums transition-colors duration-500 ${
        flash === "up" ? "text-emerald-400" : flash === "down" ? "text-red-400" : ""
      } ${className ?? ""}`}
    >
      ${formatPrice(price)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Predictor() {
  const [selected, setSelected] = useState("BTC");
  const [now, setNow] = useState(new Date());

  // 1-second EST clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Fast price polling (3s) for the live headline & grid prices
  const pricesQuery = useQuery({
    queryKey: ["crypto-prices"],
    queryFn: () => fetchJson<{ generatedAt: string; prices: CoinPrice[] }>("/crypto/prices"),
    refetchInterval: 3000,
  });

  // Full analysis + predictions (15s)
  const predQuery = useQuery({
    queryKey: ["crypto-predictions"],
    queryFn: () => fetchJson<{ generatedAt: string; coins: CoinPrediction[] }>("/crypto/predictions"),
    refetchInterval: 15000,
  });

  const coins = predQuery.data?.coins ?? [];
  const priceMap = useMemo(() => {
    const m = new Map<string, CoinPrice>();
    for (const p of pricesQuery.data?.prices ?? []) m.set(p.symbol, p);
    return m;
  }, [pricesQuery.data]);

  const active = coins.find((c) => c.symbol === selected);
  // Prefer the fast price feed for the live number, fall back to analysis price.
  const livePrice = priceMap.get(selected)?.price ?? active?.price ?? 0;
  const tz = etAbbrev(now);
  const hasError = predQuery.isError && pricesQuery.isError && coins.length === 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <header className="px-5 py-4 border-b border-border bg-card/40 backdrop-blur flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Activity className="w-6 h-6 text-primary" />
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none flex items-center gap-2">
              Crypto Predictor
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">
                <Radio className="w-3 h-3" /> Live
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              15-minute price forecasts from live chart analysis
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold tabular-nums tracking-tight">{estClock(now)}</div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Eastern Time ({tz})</div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {hasError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <Radio className="w-4 h-4" />
            Live price data is temporarily unavailable. Retrying automatically…
          </div>
        )}

        {/* Coin selector grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {predQuery.isLoading
            ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
            : coins.map((coin) => {
                const style = COIN_STYLE[coin.symbol] ?? COIN_STYLE.BTC;
                const isSel = coin.symbol === selected;
                // For the selected coin, always mirror livePrice so the tile and big display stay in sync.
                const price = isSel ? livePrice : (priceMap.get(coin.symbol)?.price ?? coin.price);
                const chg = priceMap.get(coin.symbol)?.change24hPct ?? coin.change24hPct;
                const next = coin.predictions[0];
                const nd = DIR[next?.direction ?? "flat"];
                return (
                  <button
                    key={coin.symbol}
                    onClick={() => setSelected(coin.symbol)}
                    data-testid={`coin-${coin.symbol}`}
                    className={`text-left rounded-xl border p-3 transition-all ${
                      isSel
                        ? `bg-card ring-2 ${style.ring} shadow-lg ${style.glow}`
                        : "bg-card/50 border-border hover:bg-card hover:border-border/80"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-lg font-bold ${style.accent}`}>{style.glyph}</span>
                        <span className="font-semibold text-sm">{coin.symbol}</span>
                      </div>
                      <span className={`text-[11px] font-medium ${chg >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {formatPct(chg)}
                      </span>
                    </div>
                    <div className="text-sm font-bold tabular-nums mb-1">
                      <LivePrice price={price} />
                    </div>
                    <Sparkline data={coin.sparkline} color={chg >= 0 ? "#34d399" : "#f87171"} />
                    {next && (
                      <div className={`mt-1.5 flex items-center gap-1 text-[10px] font-medium ${nd.color}`}>
                        <nd.icon className="w-3 h-3" />
                        <span>{next.label} {tz}</span>
                      </div>
                    )}
                  </button>
                );
              })}
        </div>

        {active ? (
          <CoinDetail key={selected} coin={active} livePrice={livePrice} tz={tz} />
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            <Skeleton className="h-80 rounded-xl lg:col-span-2" />
            <Skeleton className="h-80 rounded-xl" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detailed view for the selected coin
// ---------------------------------------------------------------------------

function CoinDetail({ coin, livePrice, tz }: { coin: CoinPrediction; livePrice: number; tz: string }) {
  const style = COIN_STYLE[coin.symbol] ?? COIN_STYLE.BTC;

  // Build combined chart data: historical closes + forward projection w/ band.
  const chartData = useMemo(() => {
    const hist = coin.candles.map((c) => ({
      label: estCandleLabel(c.t),
      actual: c.c,
      predicted: undefined as number | undefined,
      range: undefined as [number, number] | undefined,
    }));
    // Bridge: anchor the projection to the latest actual price.
    if (hist.length > 0) {
      const last = hist[hist.length - 1];
      last.predicted = livePrice || last.actual;
      last.range = [livePrice || last.actual, livePrice || last.actual];
    }
    const future = coin.predictions.map((p) => ({
      label: `${p.label}`,
      actual: undefined as number | undefined,
      predicted: p.predictedPrice,
      range: [p.low, p.high] as [number, number],
    }));
    return [...hist, ...future];
  }, [coin, livePrice]);

  const headlinePred = coin.predictions[coin.predictions.length - 1];
  const hd = DIR[headlinePred?.direction ?? "flat"];

  return (
    <div className="space-y-5">
      {/* Price + chart */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Live price panel */}
        <Card className="p-5 flex flex-col justify-between bg-card/60">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-2xl font-bold ${style.accent}`}>{style.glyph}</span>
              <div>
                <div className="font-bold leading-none">{coin.name}</div>
                <div className="text-xs text-muted-foreground">{coin.product}</div>
              </div>
            </div>
            <div className="text-4xl font-bold tracking-tight">
              <LivePrice price={livePrice} />
            </div>
            <div className="flex items-center gap-3 mt-2 text-sm">
              <span className={coin.change24hPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                {formatPct(coin.change24hPct)} <span className="text-muted-foreground text-xs">24h</span>
              </span>
              <span className={coin.change1hPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                {formatPct(coin.change1hPct)} <span className="text-muted-foreground text-xs">1h</span>
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">24h High</div>
              <div className="font-semibold tabular-nums">${formatPrice(coin.high24h)}</div>
            </div>
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-muted-foreground">24h Low</div>
              <div className="font-semibold tabular-nums">${formatPrice(coin.low24h)}</div>
            </div>
          </div>
        </Card>

        {/* Chart */}
        <Card className="p-4 lg:col-span-2 bg-card/60">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" /> Price &amp; Forecast
            </h3>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5 bg-sky-400" /> Actual
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5 border-t border-dashed" style={{ borderColor: hd.stroke }} /> Forecast
              </span>
            </div>
          </div>
          <div className="h-64 -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="bandFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={hd.stroke} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={hd.stroke} stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "hsl(215 20% 55%)" }}
                  interval="preserveStartEnd"
                  minTickGap={40}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 10, fill: "hsl(215 20% 55%)" }}
                  tickFormatter={(v: number) => formatPrice(v)}
                  width={64}
                  axisLine={false}
                  tickLine={false}
                  orientation="right"
                />
                <RTooltip
                  contentStyle={{
                    background: "hsl(222 47% 11%)",
                    border: "1px solid hsl(216 34% 17%)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: unknown, name: string) => {
                    if (value == null) return ["—", name];
                    if (Array.isArray(value)) {
                      const [lo, hi] = value as [number, number];
                      return [`$${formatPrice(lo)} – $${formatPrice(hi)}`, "Range"];
                    }
                    return [`$${formatPrice(value as number)}`, name === "actual" ? "Actual" : "Forecast"];
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="range"
                  stroke="none"
                  fill="url(#bandFill)"
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  stroke={hd.stroke}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 2.5, fill: hd.stroke }}
                  isAnimationActive={false}
                  connectNulls
                />
                <ReferenceLine y={livePrice} stroke="hsl(215 20% 45%)" strokeDasharray="2 4" strokeWidth={1} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Prediction showcase */}
      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Zap className="w-4 h-4 text-primary" /> Quarter-Hour Forecasts
          <span className="text-xs font-normal text-muted-foreground">— predicted price at each {tz} mark</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {coin.predictions.map((p, i) => {
            const d = DIR[p.direction];
            const Icon = d.icon;
            return (
              <Card
                key={p.target}
                data-testid={`prediction-${i}`}
                className={`p-4 border ${d.border} ${d.bg} relative overflow-hidden`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-lg font-bold tabular-nums leading-none">{p.label}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{tz} · in {p.minutesAhead} min</div>
                  </div>
                  <div className={`flex items-center gap-1 ${d.color}`}>
                    <Icon className="w-4 h-4" />
                    <span className="text-xs font-semibold">{formatPct(p.changePct)}</span>
                  </div>
                </div>

                {/* Showcased predicted price */}
                <div className={`text-2xl font-extrabold tracking-tight tabular-nums ${d.color}`}>
                  ${formatPrice(p.predictedPrice)}
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums mt-1">
                  range ${formatPrice(p.low)} – ${formatPrice(p.high)}
                </div>

                {/* Confidence bar */}
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-muted-foreground">Confidence</span>
                    <span className="font-semibold">{p.confidence}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        p.direction === "up" ? "bg-emerald-400" : p.direction === "down" ? "bg-red-400" : "bg-slate-400"
                      }`}
                      style={{ width: `${p.confidence}%` }}
                    />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Indicators */}
      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Gauge className="w-4 h-4 text-primary" /> Chart Signals
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Indicator label="RSI (14)" value={coin.indicators.rsi.toFixed(1)} hint={rsiHint(coin.indicators.rsi)} />
          <Indicator
            label="Trend"
            value={coin.indicators.trend.toUpperCase()}
            valueClass={DIR[coin.indicators.trend].color}
            icon={DIR[coin.indicators.trend].icon}
          />
          <Indicator label="Trend strength" value={`${Math.round(coin.indicators.trendStrength * 100)}%`} />
          <Indicator label="Volatility / min" value={`${coin.indicators.volatilityPct.toFixed(2)}%`} icon={Waves} />
          <Indicator
            label="MACD"
            value={coin.indicators.macd >= 0 ? "Bullish" : "Bearish"}
            valueClass={coin.indicators.macd >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <Indicator label="SMA (20)" value={`$${formatPrice(coin.indicators.sma20)}`} />
        </div>
        <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
          Forecasts are model-based estimates derived from recent 1-minute price action (momentum, trend regression,
          RSI mean-reversion and volatility) and are not financial advice. Updated every few seconds · times shown in
          US Eastern ({tz}).
        </p>
      </div>
    </div>
  );
}

function rsiHint(rsi: number): string {
  if (rsi >= 70) return "Overbought";
  if (rsi <= 30) return "Oversold";
  return "Neutral";
}

function Indicator({
  label,
  value,
  hint,
  valueClass,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
  icon?: React.ElementType;
}) {
  return (
    <Card className="p-3 bg-card/50">
      <div className="text-[11px] text-muted-foreground mb-1">{label}</div>
      <div className={`text-base font-bold flex items-center gap-1.5 ${valueClass ?? ""}`}>
        {Icon && <Icon className="w-4 h-4" />}
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </Card>
  );
}
