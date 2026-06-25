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
  minutesElapsed?: number;
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

// Context stored alongside each Claude AI run
interface AiEntry {
  preds: AIPredictionItem[];
  at: Date;
  priceAtRun: number;
  eventTickerAtRun: string | undefined;
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
    bbUpper?: number;
    bbLower?: number;
    bbWidth?: number;
    bbPctB?: number;
    atr14?: number;
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

// Coins that have Kalshi 15-min markets (must match KALSHI_SERIES in the API).
const KALSHI_COINS = ["BTC", "ETH", "XRP"];

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

  const fmtPrice = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4 text-primary" />
            Prediction Accuracy Log
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {hasKalshiData ? "Above/below Kalshi target" : "Direction + within 1% of actual"} · last 30 · 30 s refresh
          </p>
        </div>

        {accuracyPct !== null && (
          <div className="text-right shrink-0 ml-4">
            <div
              className={`text-3xl font-black leading-none tabular-nums ${
                accuracyPct >= 60 ? "text-emerald-400" : accuracyPct >= 40 ? "text-amber-400" : "text-red-400"
              }`}
            >
              {accuracyPct}%
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              {hits} / {evaluated.length} correct
            </div>
          </div>
        )}
      </div>

      {/* ── Empty state ── */}
      {history.length === 0 ? (
        <Card className="p-8 bg-card/50 text-center">
          <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">Waiting for the next 15-minute mark…</p>
          <p className="text-xs text-muted-foreground mt-1 opacity-60">
            Records snap at :00, :15, :30, :45 each hour ({tz})
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((rec) => {
            const isPending = rec.status === "pending";
            const hasTarget = rec.kalshiTarget !== null && rec.kalshiTarget !== undefined;
            const predictedAbove = hasTarget && rec.predictedPrice >= rec.kalshiTarget!;
            const actualAbove    = hasTarget && rec.actualPrice !== null && rec.actualPrice >= rec.kalshiTarget!;

            const borderColor = isPending
              ? "border-l-amber-400/70"
              : rec.correct
              ? "border-l-emerald-500"
              : "border-l-red-500";

            const statusBadge = isPending ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded-full px-2.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Pending
              </span>
            ) : rec.correct ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-500/25 rounded-full px-2.5 py-0.5">
                <CheckCircle2 className="w-3 h-3" /> Hit
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-400 bg-red-400/10 border border-red-500/25 rounded-full px-2.5 py-0.5">
                <XCircle className="w-3 h-3" /> Miss
              </span>
            );

            const sideLabel = (above: boolean) => (
              <span className={`font-bold ${above ? "text-emerald-400" : "text-red-400"}`}>
                {above ? "↑ Above" : "↓ Below"} target
              </span>
            );

            return (
              <div
                key={rec.targetTime}
                className={`border-l-4 ${borderColor} rounded-r-xl bg-card/50 hover:bg-card/80 transition-colors overflow-hidden`}
              >
                {/* Card header — time + status badge */}
                <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border/40">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold tabular-nums">{rec.targetLabel}</span>
                    <span className="text-[11px] text-muted-foreground">{tz}</span>
                  </div>
                  {statusBadge}
                </div>

                {/* Card body */}
                <div className="px-4 py-3 space-y-3">

                  {/* Kalshi layout: side-by-side predicted vs actual */}
                  {hasTarget ? (
                    <div className="grid grid-cols-2 gap-3">
                      {/* Predicted */}
                      <div className="bg-background/30 rounded-lg px-3 py-2.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
                          Predicted
                        </div>
                        <div className="text-sm">{sideLabel(predictedAbove)}</div>
                        <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
                          ${fmtPrice(rec.predictedPrice)}
                        </div>
                      </div>

                      {/* Actual */}
                      <div className="bg-background/30 rounded-lg px-3 py-2.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
                          Actual
                        </div>
                        {isPending ? (
                          <div className="text-sm text-muted-foreground/50 italic">TBD</div>
                        ) : (
                          <>
                            <div className="text-sm">{sideLabel(actualAbove)}</div>
                            <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
                              ${fmtPrice(rec.actualPrice!)}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Non-Kalshi layout: predicted price + direction → actual */
                    <div className="flex items-center gap-3 text-sm tabular-nums">
                      <div>
                        {dirLabel(rec.predictedDirection)}
                      </div>
                      <span className="text-muted-foreground">${fmtPrice(rec.predictedPrice)}</span>
                      {!isPending && (
                        <>
                          <span className="text-muted-foreground/40">→</span>
                          <span className="font-medium">${fmtPrice(rec.actualPrice!)}</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Footer stats row */}
                  <div className="flex items-center gap-4 flex-wrap text-[11px]">
                    {hasTarget && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <span className="text-[#00C805] font-semibold">K</span>
                        <span>${rec.kalshiTarget!.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="opacity-60">Error</span>
                      {isPending ? (
                        <span className="opacity-40">—</span>
                      ) : (
                        <span
                          className={
                            rec.errorPct! <= ACCURACY_THRESHOLD
                              ? "text-emerald-400 font-medium"
                              : rec.errorPct! <= 2.0
                              ? "text-amber-400 font-medium"
                              : "text-red-400 font-medium"
                          }
                        >
                          {rec.errorPct!.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="opacity-60">Conf</span>
                      <span className="font-medium">{rec.confidence}%</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-4 leading-relaxed">
        Predictions snap at each :00/:15/:30/:45 mark.{" "}
        {hasKalshiData
          ? "BTC hits scored against live Kalshi target — correct if the above/below call matches the outcome."
          : `A hit requires the correct direction call and price within ${ACCURACY_THRESHOLD}% of actual.`
        }{" "}
        History resets on server restart.
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
  const [aiData, setAiData] = useState<Record<string, AiEntry>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [autoTriggerReason, setAutoTriggerReason] = useState<string | null>(null);
  const lastAutoTriggerRef = useRef<number>(0);
  const prevStatAboveRef = useRef<boolean | null>(null);

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

  // Full analysis + predictions — 5s for near-real-time stat model updates
  const predQuery = useQuery({
    queryKey: ["crypto-predictions"],
    queryFn: () => fetchJson<{ generatedAt: string; coins: CoinPrediction[] }>("/crypto/predictions"),
    refetchInterval: 5000,
  });

  // Kalshi 15-min target — supported for BTC, ETH, and XRP
  const kalshiTargetQuery = useQuery({
    queryKey: ["kalshi-target", selected],
    queryFn: () => fetchJson<KalshiTarget>(`/crypto/kalshi-target?symbol=${selected}`),
    refetchInterval: 10_000,
    enabled: KALSHI_COINS.includes(selected),
  });
  const ktd = kalshiTargetQuery.data;
  const kalshiAvailableTop = KALSHI_COINS.includes(selected) && ktd?.available === true;
  const kalshiTarget = kalshiAvailableTop ? (ktd?.targetPrice ?? null) : null;
  const kalshiIsLive = ktd?.isLive === true;
  const kalshiEventTicker = ktd?.eventTicker;

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

  // Stat model's current verdict vs Kalshi target (recomputed every 5s)
  const statPred0 = active?.predictions[0];
  const statAboveNow: boolean | null =
    kalshiTarget !== null && statPred0 != null
      ? statPred0.predictedPrice >= kalshiTarget
      : null;

  async function handleEnhance() {
    if (aiLoading) return;
    setAiError(null);
    setAiLoading(true);
    const sym = selected;
    const priceSnapshot = livePrice;
    const tickerSnapshot = kalshiEventTicker;
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
        [sym]: {
          preds: data.predictions,
          at: new Date(data.generatedAt),
          priceAtRun: priceSnapshot,
          eventTickerAtRun: tickerSnapshot,
        },
      }));
      setAutoTriggerReason(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI enhancement failed";
      setAiError(msg);
      setAutoTriggerReason(null);
    } finally {
      setAiLoading(false);
    }
  }

  // ── Auto-trigger logic ────────────────────────────────────────────────────
  // Two triggers: new Kalshi window opens, or stat model flips Above/Below.
  // Guarded by a 90-second cooldown so we don't burn API calls on noise.
  const COOLDOWN_MS = 90_000;

  useEffect(() => {
    if (!KALSHI_COINS.includes(selected)) return;
    if (!kalshiIsLive || kalshiTarget === null) return;

    const entry = aiData[selected] ?? null;

    // ── Trigger 1: New Kalshi window ──────────────────────────────────────
    if (entry && kalshiEventTicker && kalshiEventTicker !== entry.eventTickerAtRun) {
      const now = Date.now();
      if (now - lastAutoTriggerRef.current >= COOLDOWN_MS) {
        lastAutoTriggerRef.current = now;
        setAutoTriggerReason("New Kalshi window");
        void handleEnhance();
        return;
      }
    }

    // ── Trigger 2: Stat model direction flip ──────────────────────────────
    // Hysteresis: only count as a real flip if predicted price is >= 0.15%
    // away from the Kalshi strike. Closer than that is noise — don't fire.
    if (statAboveNow !== null && statPred0 != null && kalshiTarget !== null) {
      const gapPct = Math.abs(statPred0.predictedPrice - kalshiTarget) / kalshiTarget;
      const convincingFlip = gapPct >= 0.0015;
      const prev = prevStatAboveRef.current;
      if (prev !== null && prev !== statAboveNow && convincingFlip) {
        const now = Date.now();
        if (now - lastAutoTriggerRef.current >= COOLDOWN_MS) {
          lastAutoTriggerRef.current = now;
          setAutoTriggerReason(`Direction flip: stat → ${statAboveNow ? "Above" : "Below"} target`);
          void handleEnhance();
          prevStatAboveRef.current = statAboveNow;
          return;
        }
      }
      if (convincingFlip) {
        prevStatAboveRef.current = statAboveNow;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statAboveNow, kalshiEventTicker, kalshiIsLive, kalshiTarget]);

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
            now={now}
            aiEntry={aiData[selected]}
            aiLoading={aiLoading}
            aiError={aiError}
            autoTriggerReason={autoTriggerReason}
            onEnhance={handleEnhance}
            kalshiTarget={kalshiTarget}
            kalshiIsLive={kalshiIsLive}
            ktd={ktd}
          />
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            <Skeleton className="h-80 rounded-xl lg:col-span-2" />
            <Skeleton className="h-80 rounded-xl" />
          </div>
        )}

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
  now,
  aiEntry,
  aiLoading,
  aiError,
  autoTriggerReason,
  onEnhance,
  kalshiTarget,
  kalshiIsLive,
  ktd,
}: {
  coin: CoinPrediction;
  livePrice: number;
  tz: string;
  now: Date;
  aiEntry?: AiEntry;
  aiLoading: boolean;
  aiError: string | null;
  autoTriggerReason: string | null;
  onEnhance: () => void;
  kalshiTarget: number | null;
  kalshiIsLive: boolean;
  ktd: KalshiTarget | undefined;
}) {
  const style = COIN_STYLE[coin.symbol] ?? COIN_STYLE.BTC;
  const kalshiAvailable = KALSHI_COINS.includes(coin.symbol) && ktd?.available === true;

  // Derive Claude's call from the AI forecast — same data as the cards, never contradicts.
  const claudeAiPred0 = aiEntry?.preds[0] ?? null;
  const claudeAbove: boolean | null =
    kalshiTarget !== null && claudeAiPred0 !== null
      ? claudeAiPred0.predictedPrice >= kalshiTarget
      : null;
  const claudePredPrice: number | null = claudeAiPred0?.predictedPrice ?? null;
  const claudeConfidence: number | null = claudeAiPred0?.confidence ?? null;

  // Staleness: how many minutes since Claude last ran
  const staleMins = aiEntry ? Math.floor((now.getTime() - aiEntry.at.getTime()) / 60_000) : null;
  const staleClass =
    staleMins === null ? "" :
    staleMins >= 7 ? "text-red-400" :
    staleMins >= 3 ? "text-amber-400" :
    "text-emerald-400/70";

  const toET = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", hour12: true,
    });

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

      {/* ── Kalshi Target Banner (BTC, ETH, XRP) ── */}
      {kalshiAvailable && (
        <div className="rounded-xl border-2 border-[#00C805]/40 bg-[#00C805]/6 overflow-hidden">
          {/* Banner header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-[#00C805]/20 bg-[#00C805]/8">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#00C805]/20 border border-[#00C805]/40">
                <span className="text-[11px] font-black text-[#00C805]">K</span>
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-[#00C805]/80">Kalshi 15-min Target</span>
              {kalshiIsLive ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> LIVE
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">Next window</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {ktd?.closeTime && kalshiIsLive && (
                <span className="text-[11px] text-muted-foreground">closes <span className="font-medium text-foreground">{toET(ktd.closeTime)} ET</span></span>
              )}
              {ktd?.url && (
                <a href={ktd.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[#00C805]/80 hover:text-[#00C805] transition-colors">
                  View on Kalshi <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
          {/* Banner body */}
          <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-[#00C805]/15 px-0">
            {/* Target price — hero */}
            <div className="px-5 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">Strike Price</div>
              {kalshiTarget !== null ? (
                <>
                  <div className="text-3xl font-black tabular-nums text-[#00C805]">${formatPrice(kalshiTarget)}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{coin.symbol} RTI at window open</div>
                </>
              ) : (
                <>
                  <div className="text-3xl font-black text-muted-foreground">TBD</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{ktd?.openTime ? `set at ${toET(ktd.openTime)} ET` : "set when window opens"}</div>
                </>
              )}
            </div>
            {/* Current price vs target */}
            {kalshiTarget !== null && (
              <div className="px-5 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">Current Price</div>
                <div className="text-3xl font-black tabular-nums">${formatPrice(livePrice)}</div>
                <div className={`text-sm font-bold mt-0.5 flex items-center gap-1 ${livePrice >= kalshiTarget ? "text-emerald-400" : "text-red-400"}`}>
                  {livePrice >= kalshiTarget ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                  {livePrice >= kalshiTarget ? "Above" : "Below"} target
                  <span className="font-normal text-[11px] text-muted-foreground ml-1">
                    ({livePrice >= kalshiTarget ? "+" : ""}{(((livePrice - kalshiTarget) / kalshiTarget) * 100).toFixed(2)}%)
                  </span>
                </div>
              </div>
            )}
            {/* Claude's call — derived from the same AI forecast shown in the cards */}
            <div className="px-5 py-4 col-span-2 sm:col-span-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1 flex items-center gap-2">
                Claude's Call
                {staleMins !== null && !aiLoading && (
                  <span className={`font-normal normal-case tracking-normal ${staleClass}`}>
                    {staleMins === 0 ? "just now" : `${staleMins}m ago`}
                  </span>
                )}
              </div>
              {kalshiTarget === null ? (
                <div className="text-sm text-muted-foreground">Awaiting target price…</div>
              ) : aiLoading ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing…
                  </div>
                  {autoTriggerReason && (
                    <div className="text-[10px] text-amber-400/80 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> {autoTriggerReason}
                    </div>
                  )}
                </div>
              ) : claudeAbove !== null ? (
                <>
                  <div className={`flex items-center gap-1.5 text-xl font-black ${claudeAbove ? "text-emerald-400" : "text-red-400"}`}>
                    {claudeAbove ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />}
                    {claudeAbove ? "ABOVE" : "BELOW"}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    ${formatPrice(claudePredPrice!)} · {claudeConfidence}% conf.
                  </div>
                  {kalshiIsLive && (
                    <div className={`mt-1.5 text-xs font-bold ${claudeAbove ? "text-emerald-400" : "text-red-400"}`}>
                      → Bet {claudeAbove ? "YES" : "NO"} on Kalshi
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[11px] text-muted-foreground/70 leading-snug">
                  Click "Enhance with AI"<br />to see Claude's call
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Quarter-Hour Forecasts — side-by-side model comparison ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-primary" /> Quarter-Hour Forecasts
            <span className="text-xs font-normal text-muted-foreground">— Statistical vs Claude AI at each {tz} mark</span>
          </h3>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {aiError && (
              <span className="text-[11px] text-red-400 max-w-xs truncate" title={aiError}>
                ⚠ {aiError}
              </span>
            )}
            {!aiError && aiLoading && autoTriggerReason && (
              <span className="text-[11px] text-amber-400 flex items-center gap-1">
                <Zap className="w-3 h-3" /> {autoTriggerReason}
              </span>
            )}
            {!aiError && !aiLoading && aiEntry && (
              <span className={`text-[11px] tabular-nums ${staleClass}`}>
                AI run · {aiEntry.at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} {tz}
                {staleMins !== null && staleMins >= 3 && (
                  <span className="ml-1 opacity-70">({staleMins}m ago)</span>
                )}
              </span>
            )}
            <button
              onClick={onEnhance}
              disabled={aiLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {aiLoading ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {autoTriggerReason ? "Auto-analyzing…" : "Analyzing…"}</>
              ) : aiEntry ? (
                <><Sparkles className="w-3.5 h-3.5" /> Re-analyze</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5" /> Enhance with AI</>
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {coin.predictions.map((statPred, i) => {
            const aiPred = aiEntry?.preds[i] ?? null;
            const statChangePct = livePrice > 0 ? ((statPred.predictedPrice - livePrice) / livePrice) * 100 : statPred.changePct;
            const aiChangePct = aiPred && livePrice > 0 ? ((aiPred.predictedPrice - livePrice) / livePrice) * 100 : 0;
            const statDir: "up" | "down" | "flat" = statChangePct > 0.05 ? "up" : statChangePct < -0.05 ? "down" : "flat";
            const aiDir: "up" | "down" | "flat" = aiPred ? (aiChangePct > 0.05 ? "up" : aiChangePct < -0.05 ? "down" : "flat") : "flat";
            return (
              <Card key={statPred.target} data-testid={`prediction-${i}`} className="overflow-hidden border-border bg-card/60">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20">
                  <span className="text-sm font-bold tabular-nums">{statPred.label}</span>
                  <span className="text-[11px] text-muted-foreground">{tz} · in {statPred.minutesAhead} min</span>
                </div>
                <div className="grid grid-cols-2 divide-x divide-border">
                  {/* Statistical Model column */}
                  <div className="px-4 py-3 space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                      Statistical Model
                    </div>
                    <ModelColumn
                      price={statPred.predictedPrice}
                      changePct={statChangePct}
                      direction={statDir}
                      confidence={statPred.confidence}
                      low={statPred.low}
                      high={statPred.high}
                      kalshiTarget={kalshiTarget}
                    />
                  </div>
                  {/* Claude AI column */}
                  <div className="px-4 py-3 space-y-2">
                    <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                      <Sparkles className="w-3 h-3 text-primary/50" /> Claude AI
                    </div>
                    {aiPred ? (
                      <ModelColumn
                        price={aiPred.predictedPrice}
                        changePct={aiChangePct}
                        direction={aiDir}
                        confidence={aiPred.confidence}
                        low={aiPred.low}
                        high={aiPred.high}
                        kalshiTarget={kalshiTarget}
                      />
                    ) : (
                      <div className="pt-1">
                        {aiLoading ? (
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="w-3 h-3 animate-spin" /> Analyzing…
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground/50 italic leading-snug">
                            Click "Enhance with AI"<br />to run Claude analysis
                          </div>
                        )}
                      </div>
                    )}
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
          Statistical Model: drift + regression on 60 min of 1-min candles, RSI, MACD, Bollinger Bands, ATR.
          Claude AI: extended-thinking analysis of the same chart data — click "Enhance with AI" to run it on demand.
          Prices update every 3 s · Not financial advice · {tz}.
        </p>
      </div>
    </div>
  );
}

function ModelColumn({
  price,
  changePct,
  direction,
  confidence,
  low,
  high,
  kalshiTarget,
}: {
  price: number;
  changePct: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  low: number;
  high: number;
  kalshiTarget: number | null;
}) {
  const d = DIR[direction];
  const Icon = d.icon;
  const vsTarget = kalshiTarget !== null ? price >= kalshiTarget : null;
  return (
    <div className="space-y-1.5">
      <div className={`text-xl font-extrabold tabular-nums leading-none ${d.color}`}>
        ${formatPrice(price)}
      </div>
      <div className={`flex items-center gap-1 text-xs ${d.color}`}>
        <Icon className="w-3 h-3" />
        <span>{formatPct(changePct)}</span>
      </div>
      {vsTarget !== null && (
        <div className={`text-[11px] font-bold flex items-center gap-0.5 ${vsTarget ? "text-emerald-400" : "text-red-400"}`}>
          {vsTarget ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
          {vsTarget ? "Above" : "Below"} target
        </div>
      )}
      <div className="pt-0.5">
        <div className="flex items-center justify-between text-[10px] mb-1">
          <span className="text-muted-foreground">Conf</span>
          <span className="font-semibold">{confidence}%</span>
        </div>
        <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
          <div
            className={`h-full rounded-full ${direction === "up" ? "bg-emerald-400" : direction === "down" ? "bg-red-400" : "bg-slate-400"}`}
            style={{ width: `${confidence}%` }}
          />
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground/50 tabular-nums">
        {formatPrice(low)} – {formatPrice(high)}
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
