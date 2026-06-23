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
  Loader2,
  ClipboardList,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  RefreshCw,
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

// Shape returned by the prediction history endpoint
interface PredictionRecord {
  symbol: string;
  snappedAt: string;
  targetTime: string;
  targetLabel: string;
  priceAtSnapshot: number;
  predictedPrice: number;
  predictedDirection: "up" | "down" | "flat";
  confidence: number;
  kalshiTarget: number | null;
  actualPrice: number | null;
  errorPct: number | null;
  correct: boolean | null;
  evaluatedAt: string | null;
  status: "pending" | "evaluated";
}

// Shape returned by the Kalshi BTC 15-min target endpoint
interface KalshiTarget {
  available: boolean;
  targetPrice: number | null;
  ticker?: string;
  eventTicker?: string;
  closeTime?: string;
  openTime?: string;
  isLive?: boolean;
  yesBid?: number;
  yesAsk?: number;
  url?: string;
}

// Shape returned by the on-demand AI endpoint
interface AIPredictionItem {
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
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
// Kalshi 15-min BTC Market card — shows live target price + Claude verdict
// ---------------------------------------------------------------------------

interface KalshiBtcCall {
  above: boolean;
  confidence: number;
  predictedPrice: number;
}

function KalshiBtcCard() {
  const targetQuery = useQuery({
    queryKey: ["kalshi-btc-target"],
    queryFn: () => fetchJson<KalshiTarget>("/crypto/kalshi-btc-target"),
    refetchInterval: 15_000,
  });

  const d = targetQuery.data;
  const eventTicker = d?.eventTicker;
  const target = d?.targetPrice ?? null;

  // Keyed by eventTicker — auto-fires a fresh Claude call whenever the window changes.
  const callQuery = useQuery({
    queryKey: ["kalshi-btc-call", eventTicker],
    queryFn: () =>
      fetchJson<KalshiBtcCall>(
        `/crypto/kalshi-btc-call?eventTicker=${encodeURIComponent(eventTicker!)}&target=${target}`,
      ),
    enabled: !!eventTicker && target !== null,
    staleTime: Infinity, // cached on server per eventTicker; no need to re-fetch
    retry: 2,
  });

  if (!d?.available) return null;

  const isLive = d.isLive === true;
  const call = callQuery.data;
  const isAnalyzing = callQuery.isFetching || callQuery.isLoading;

  const above = call?.above ?? null;
  const predictedPrice = call?.predictedPrice ?? null;
  const confidence = call?.confidence ?? null;
  const diff = target !== null && predictedPrice !== null ? predictedPrice - target : null;
  const diffPct = diff !== null && target ? (diff / target) * 100 : null;

  const toET = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
      hour12: true,
    });

  const closeLabel = d.closeTime ? toET(d.closeTime) : null;
  const openLabel  = d.openTime  ? toET(d.openTime)  : null;

  return (
    <Card className="border-border bg-card/60 overflow-hidden">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#00C805]/15 border border-[#00C805]/30">
            <span className="text-[11px] font-black text-[#00C805]">K</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">Kalshi 15-min BTC Market</span>
            {isLive ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LIVE
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                Next window
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {isLive
              ? <>closes <span className="font-medium text-foreground">{closeLabel} ET</span></>
              : <>opens <span className="font-medium text-foreground">{openLabel} ET</span></>
            }
          </span>
          <button
            onClick={() => { void targetQuery.refetch(); void callQuery.refetch(); }}
            disabled={targetQuery.isFetching || isAnalyzing}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 ${(targetQuery.isFetching || isAnalyzing) ? "animate-spin" : ""}`} />
          </button>
          {d.url && (
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              View on Kalshi <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Target price */}
        <div className="px-5 py-4">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">
            Target Price
          </div>
          {target !== null ? (
            <>
              <div className="text-xl font-bold tabular-nums">${formatPrice(target)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">BTC BRTI at window open</div>
            </>
          ) : (
            <>
              <div className="text-xl font-bold text-muted-foreground">TBD</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                set at {openLabel} ET when window opens
              </div>
            </>
          )}
        </div>

        {/* Claude's verdict */}
        <div className="px-5 py-4">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">
            Claude's Call
          </div>
          {target === null ? (
            <>
              <div className="text-sm text-muted-foreground font-medium">Awaiting target…</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Will analyze once window opens
              </div>
            </>
          ) : isAnalyzing ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Analyzing market…
            </div>
          ) : above === null ? (
            <div className="text-sm text-muted-foreground">Awaiting analysis…</div>
          ) : (
            <>
              <div className={`flex items-center gap-1.5 text-base font-bold ${above ? "text-emerald-400" : "text-red-400"}`}>
                {above ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                {above ? "ABOVE TARGET" : "BELOW TARGET"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                ${formatPrice(predictedPrice!)}
                {diffPct !== null && (
                  <span className={diffPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                    {" "}({diffPct >= 0 ? "+" : ""}{diffPct.toFixed(2)}%)
                  </span>
                )}
                {confidence !== null && (
                  <span className="ml-1 text-muted-foreground">· {confidence}% conf.</span>
                )}
              </div>
              {isLive && (
                <div className={`mt-1.5 text-[11px] font-bold ${above ? "text-emerald-400" : "text-red-400"}`}>
                  → Bet {above ? "YES" : "NO"} on Kalshi
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Prediction Accuracy Log — tracks 15-min boundary predictions vs actual
// ---------------------------------------------------------------------------

function PredictionHistory({ symbol, tz }: { symbol: string; tz: string }) {
  const ACCURACY_THRESHOLD = 1.0; // fallback for non-BTC / no Kalshi target

  const query = useQuery({
    queryKey: ["pred-history", symbol],
    queryFn: () =>
      fetchJson<{ symbol: string; history: PredictionRecord[]; accuracyThresholdPct: number }>(
        `/crypto/prediction-history?symbol=${symbol}`,
      ),
    refetchInterval: 30_000,
  });

  const history = query.data?.history ?? [];
  const evaluated = history.filter((r) => r.status === "evaluated");
  const hits = evaluated.filter((r) => r.correct === true).length;
  const accuracyPct = evaluated.length > 0 ? Math.round((hits / evaluated.length) * 100) : null;

  // Does any record in this history have a Kalshi target? (true for BTC during market hours)
  const hasKalshiData = history.some((r) => r.kalshiTarget !== null && r.kalshiTarget !== undefined);

  const accentClass = (rec: PredictionRecord) => {
    if (rec.status === "pending") return "border-l-amber-400/70";
    return rec.correct ? "border-l-emerald-500" : "border-l-red-500";
  };

  const dirLabel = (d: "up" | "down" | "flat") => {
    if (d === "up") return <TrendingUp className="w-3 h-3 text-emerald-400" />;
    if (d === "down") return <TrendingDown className="w-3 h-3 text-red-400" />;
    return <Minus className="w-3 h-3 text-muted-foreground" />;
  };

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4 text-primary" />
            Prediction Accuracy Log
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {hasKalshiData
              ? <>BTC hit = Claude called the correct Kalshi YES/NO (above/below target) &nbsp;·&nbsp; last 30 &nbsp;·&nbsp; 30 s refresh</>
              : <>Hit = direction correct &amp; price within {ACCURACY_THRESHOLD}% of actual &nbsp;·&nbsp; last 30 &nbsp;·&nbsp; 30 s refresh</>
            }
          </p>
        </div>

        {accuracyPct !== null && (
          <div className="text-right shrink-0 ml-4">
            <div
              className={`text-2xl font-bold leading-none ${
                accuracyPct >= 60
                  ? "text-emerald-400"
                  : accuracyPct >= 40
                    ? "text-amber-400"
                    : "text-red-400"
              }`}
            >
              {accuracyPct}%
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {hits}/{evaluated.length} hits
            </div>
          </div>
        )}
      </div>

      {/* ── Empty state ── */}
      {history.length === 0 ? (
        <Card className="p-6 bg-card/50 text-center">
          <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
          <p className="text-sm text-muted-foreground">
            Waiting for the next 15-minute mark…
          </p>
          <p className="text-xs text-muted-foreground mt-1 opacity-60">
            Records snap at :00, :15, :30, :45 each hour ({tz})
          </p>
        </Card>
      ) : (
        <>
          {/* ── Column labels ── */}
          <div className="grid grid-cols-[96px_1fr_64px_44px_32px] gap-x-3 pl-5 pr-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            <span>Target</span>
            <span>Predicted → Actual</span>
            <span className="text-right">Error</span>
            <span className="text-right">Conf</span>
            <span />
          </div>

          {/* ── Rows ── */}
          <div className="space-y-1">
            {history.map((rec) => {
              const isPending = rec.status === "pending";
              const hasTarget = rec.kalshiTarget !== null && rec.kalshiTarget !== undefined;

              // For Kalshi-evaluated rows: show which side of target the prediction landed
              const predictedAbove = hasTarget && rec.predictedPrice >= rec.kalshiTarget!;
              const actualAbove    = hasTarget && rec.actualPrice !== null && rec.actualPrice >= rec.kalshiTarget!;

              // Compact Kalshi target label e.g. "K $62,247"
              const kLabel = hasTarget
                ? `K $${rec.kalshiTarget!.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                : null;

              return (
                <div
                  key={rec.targetTime}
                  className={`grid grid-cols-[96px_1fr_64px_44px_32px] gap-x-3 items-center
                    border-l-4 ${accentClass(rec)} rounded-r-lg pl-3 pr-3 py-2.5
                    bg-card/40 hover:bg-card/70 transition-colors`}
                >
                  {/* Target time */}
                  <div className="tabular-nums">
                    <div className="text-xs font-semibold">{rec.targetLabel}</div>
                    <div className="text-[10px] text-muted-foreground">{tz}</div>
                  </div>

                  {/* Predicted → Actual (Kalshi context shown inline as sub-line) */}
                  <div className="tabular-nums text-xs min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-muted-foreground">${formatPrice(rec.predictedPrice)}</span>
                      {isPending ? (
                        <span className="inline-flex items-center gap-1 text-amber-400/80 text-[10px]">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                          pending
                        </span>
                      ) : (
                        <>
                          <span className="text-muted-foreground/40">→</span>
                          <span className="font-medium">${formatPrice(rec.actualPrice!)}</span>
                        </>
                      )}
                    </div>
                    {/* Kalshi sub-line: K $62,247 · pred ↑ · actual ↑ */}
                    {kLabel && !isPending && (
                      <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground/70">
                        <span>{kLabel}</span>
                        <span className="text-muted-foreground/30">·</span>
                        <span className={predictedAbove ? "text-emerald-400" : "text-red-400"}>
                          pred {predictedAbove ? "↑" : "↓"}
                        </span>
                        <span className="text-muted-foreground/30">·</span>
                        <span className={actualAbove ? "text-emerald-400" : "text-red-400"}>
                          actual {actualAbove ? "↑" : "↓"}
                        </span>
                      </div>
                    )}
                    {kLabel && isPending && (
                      <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                        {kLabel} · pred {predictedAbove ? "↑" : "↓"}
                      </div>
                    )}
                  </div>

                  {/* Error % — always shown */}
                  <div className="text-right tabular-nums text-xs">
                    {isPending ? (
                      <span className="text-muted-foreground/30">—</span>
                    ) : (
                      <span
                        className={
                          rec.errorPct! <= ACCURACY_THRESHOLD
                            ? "text-emerald-400"
                            : rec.errorPct! <= 2.0
                              ? "text-amber-400"
                              : "text-red-400"
                        }
                      >
                        {rec.errorPct!.toFixed(2)}%
                      </span>
                    )}
                  </div>

                  {/* Confidence */}
                  <div className="text-right text-xs text-muted-foreground tabular-nums">
                    {rec.confidence}%
                  </div>

                  {/* Hit / Miss */}
                  <div className="flex justify-center">
                    {isPending ? (
                      dirLabel(rec.predictedDirection)
                    ) : rec.correct ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
        Claude AI analyzes candle patterns at each :00/:15/:30/:45 snap.
        {hasKalshiData
          ? <> BTC hits are scored against the live Kalshi target — correct if Claude called the same YES/NO side as the outcome.</>
          : <> A hit requires the correct direction call <em>and</em> price within {ACCURACY_THRESHOLD}% of actual.</>
        }
        {" "}History resets on server restart.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Predictor() {
  const [selected, setSelected] = useState("BTC");
  const [now, setNow] = useState(new Date());
  const [aiData, setAiData] = useState<Record<string, { preds: AIPredictionItem[]; at: Date }>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

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
  const livePrice = priceMap.get(selected)?.price ?? active?.price ?? 0;
  const tz = etAbbrev(now);
  const hasError = predQuery.isError && pricesQuery.isError && coins.length === 0;

  async function handleEnhance() {
    if (aiLoading) return;
    setAiError(null);
    setAiLoading(true);
    const sym = selected;
    try {
      const res = await fetch(`${API_BASE}/crypto/ai-predict?symbol=${sym}`);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Server error ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { predictions: AIPredictionItem[]; generatedAt: string };
      if (!Array.isArray(data.predictions) || data.predictions.length === 0) {
        throw new Error("Unexpected response from AI endpoint");
      }
      setAiData((prev) => ({
        ...prev,
        [sym]: { preds: data.predictions, at: new Date(data.generatedAt) },
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI enhancement failed";
      setAiError(msg);
    } finally {
      setAiLoading(false);
    }
  }

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
          <CoinDetail
            key={selected}
            coin={active}
            livePrice={livePrice}
            tz={tz}
            aiEntry={aiData[selected]}
            aiLoading={aiLoading}
            aiError={aiError}
            onEnhance={handleEnhance}
          />
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            <Skeleton className="h-80 rounded-xl lg:col-span-2" />
            <Skeleton className="h-80 rounded-xl" />
          </div>
        )}

        {selected === "BTC" && <KalshiBtcCard />}

        <PredictionHistory symbol={selected} tz={tz} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detailed view for the selected coin
// ---------------------------------------------------------------------------

function CoinDetail({
  coin,
  livePrice,
  tz,
  aiEntry,
  aiLoading,
  aiError,
  onEnhance,
}: {
  coin: CoinPrediction;
  livePrice: number;
  tz: string;
  aiEntry?: { preds: AIPredictionItem[]; at: Date };
  aiLoading: boolean;
  aiError: string | null;
  onEnhance: () => void;
}) {
  const style = COIN_STYLE[coin.symbol] ?? COIN_STYLE.BTC;

  // Merge AI-enhanced predictions over the statistical baseline (by position).
  const displayPreds: Prediction[] = coin.predictions.map((p, i) => {
    const ai = aiEntry?.preds[i];
    if (!ai) return p;
    return {
      ...p,
      predictedPrice: ai.predictedPrice,
      low: ai.low,
      high: ai.high,
      direction: ai.direction,
      confidence: ai.confidence,
    };
  });

  // Build combined chart data: historical closes + forward projection w/ band.
  const chartData = useMemo(() => {
    const hist = coin.candles.map((c) => ({
      label: estCandleLabel(c.t),
      actual: c.c,
      predicted: undefined as number | undefined,
      range: undefined as [number, number] | undefined,
    }));
    if (hist.length > 0) {
      const last = hist[hist.length - 1];
      last.predicted = livePrice || last.actual;
      last.range = [livePrice || last.actual, livePrice || last.actual];
    }
    const future = displayPreds.map((p) => ({
      label: `${p.label}`,
      actual: undefined as number | undefined,
      predicted: p.predictedPrice,
      range: [p.low, p.high] as [number, number],
    }));
    return [...hist, ...future];
  }, [coin, livePrice, aiEntry]);

  const headlinePred = displayPreds[displayPreds.length - 1];
  const headlineVisual =
    headlinePred == null ? "flat"
    : headlinePred.predictedPrice > livePrice ? "up"
    : headlinePred.predictedPrice < livePrice ? "down"
    : "flat";
  const hd = DIR[headlineVisual];

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
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-primary" /> Quarter-Hour Forecasts
            <span className="text-xs font-normal text-muted-foreground">— predicted price at each {tz} mark</span>
          </h3>
          <div className="flex items-center gap-2">
            {aiError && (
              <span className="text-[11px] text-red-400 max-w-xs truncate" title={aiError}>
                ⚠ {aiError}
              </span>
            )}
            {!aiError && aiEntry && (
              <span className="text-[11px] text-primary/60 tabular-nums">
                AI · {aiEntry.at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} {tz}
              </span>
            )}
            <button
              onClick={onEnhance}
              disabled={aiLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {aiLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Analyzing…
                </>
              ) : aiEntry ? (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  Re-analyze
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  Enhance with AI
                </>
              )}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {displayPreds.map((p, i) => {
            const visual =
              p.predictedPrice > livePrice ? "up"
              : p.predictedPrice < livePrice ? "down"
              : "flat";
            const d = DIR[visual];
            const Icon = d.icon;
            const isAI = !!aiEntry?.preds[i];
            return (
              <Card
                key={p.target}
                data-testid={`prediction-${i}`}
                className={`p-4 border ${d.border} ${d.bg} relative overflow-hidden`}
              >
                {isAI && (
                  <div className="absolute top-2 right-2">
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-primary/70 bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5">
                      <Sparkles className="w-2.5 h-2.5" /> AI
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-lg font-bold tabular-nums leading-none">{p.label}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{tz} · in {p.minutesAhead} min</div>
                  </div>
                  <div className={`flex items-center gap-1 ${d.color} ${isAI ? "mr-8" : ""}`}>
                    <Icon className="w-4 h-4" />
                    <span className="text-xs font-semibold">{formatPct(p.changePct)}</span>
                  </div>
                </div>

                <div className={`text-2xl font-extrabold tracking-tight tabular-nums ${d.color}`}>
                  ${formatPrice(p.predictedPrice)}
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums mt-1">
                  range ${formatPrice(p.low)} – ${formatPrice(p.high)}
                </div>

                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-muted-foreground">Confidence</span>
                    <span className="font-semibold">{p.confidence}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        visual === "up" ? "bg-emerald-400" : visual === "down" ? "bg-red-400" : "bg-slate-400"
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
          Forecasts are powered by Claude AI — each refresh analyzes the latest 30 candles, RSI, MACD, trend strength,
          and key support/resistance levels to produce refined price targets. Click "Enhance with AI" to force a fresh
          Claude analysis on demand. Prices update every 3 s. Not financial advice · times shown in US Eastern ({tz}).
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
