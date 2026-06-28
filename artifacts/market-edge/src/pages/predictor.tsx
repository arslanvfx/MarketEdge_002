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
  Check,
  Trash2,
  AlertTriangle,
  Bot,
  BarChart3,
  Power,
  Lock,
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

// Response from GET /crypto/ml-prediction/:symbol
interface MLPredResponse {
  symbol:      string;
  above:       boolean | null;
  confidence:  number | null;
  prob:        number | null;
  ready:       boolean;
  windows:     number;
  samples:     number;
  minWindows:  number;
  valAccuracy: number | null;
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
  source?: "stat" | "claude" | "ensemble" | "ml";
  id?: string;
  abstained?: boolean | null;
}

// Regime-aware blend weights returned alongside an AI run so the client can
// reproduce the exact combined call shown in the two model columns.
interface EnsembleWeights {
  stat: number;
  claude: number;
}

// Auto-pilot's per-coin decision: whether Claude is auto-enabled and why.
interface AutoPilotDecision {
  symbol: string;
  active: boolean;
  reason: string;
  exploring: boolean;
  claudeAccuracyPct: number | null;
  statAccuracyPct: number | null;
  claudeN: number;
  statN: number;
  marginPct: number | null;
}

// Shape returned by /crypto/ai-settings
interface AiSettings {
  mode: "stat" | "claude";
  claudeCoins: string[];
  trainingCoins: string[];
  selfConsistencySamples?: number;
  autoPilot: {
    enabled: boolean;
    maxActive: number;
    decisions: AutoPilotDecision[];
  };
}

// Self-learning analytics shape from /crypto/prediction-analytics
type PromptRegime = "trending" | "drifting" | "choppy";
interface SourceMetrics {
  n: number;
  hits: number;
  accuracyPct: number | null;
  avgErrorPct: number | null;
}
interface CoinAnalytics {
  symbol: string;
  bySource: { stat: SourceMetrics; claude: SourceMetrics; ensemble: SourceMetrics };
  byRegime: {
    stat: Record<PromptRegime, SourceMetrics>;
    claude: Record<PromptRegime, SourceMetrics>;
    ensemble: Record<PromptRegime, SourceMetrics>;
  };
  abstention: {
    evaluated: number;
    avoidedLoss: number;
    missedWin: number;
    avoidedLossPct: number | null;
  };
  calibration: Array<{
    band: string;
    n: number;
    avgConfidencePct: number | null;
    hitRatePct: number | null;
  }>;
  ensembleWeights: {
    overall: EnsembleWeights;
    byRegime: Record<PromptRegime, EnsembleWeights>;
  };
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
  windowOpenPrice?: number | null;
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
  ensembleWeights?: EnsembleWeights;
  abstainMinConf?: number;
}

interface DriftAlert {
  lockedAbove: boolean | null;
  claudeAbove: boolean | null;
  lockedDirection: "up" | "down" | "flat";
  claudeDirection: "up" | "down" | "flat";
  detectedAt: Date;
  windowTarget: string;
}

interface TrackerWindowCall {
  direction: "up" | "down" | "flat";
  aboveKalshi: boolean | null;
  predictedPrice: number;
  confidence: number;
  snappedAt: string;
}

interface LiveDirectionResult {
  aboveKalshi: boolean | null;
  direction: "up" | "down" | "flat";
  confidence: number;
  at: string;
  cached: boolean;
}

// Shape returned by the /crypto/trading-windows endpoint
interface TradingWindowBucket {
  count: number;
  evaluatedCount: number;
  accuracyPct: number | null;
  avgEfficiencyRatio: number | null;
  trendingPct: number | null;
  sparse: boolean;
}
interface RecommendedWindow {
  hour: number;
  label: string;
  score: number;
  avgEfficiencyRatio: number;
  accuracyPct: number | null;
  rank: "best" | "worst";
}
interface TradingWindowsData {
  hourly: Array<TradingWindowBucket & { hour: number; label: string }>;
  daily: Array<TradingWindowBucket & { dayIndex: number; label: string }>;
  byDayHour: Array<Array<TradingWindowBucket & { hour: number; label: string }>>;
  recommendedWindows: RecommendedWindow[];
  totalSamples: number;
  lastUpdatedAt: string;
  recommendation: string;
  hasEnoughData: boolean;
}

// ---------------------------------------------------------------------------
// Bet signal — intra-window momentum read on whether the last 15 minutes are
// trending cleanly, just drifting, choppy, or showing an abnormal spike.
// ---------------------------------------------------------------------------

interface BetSignal {
  level: "trending" | "drifting" | "choppy" | "spike";
  er: number;              // efficiency ratio 0–1 (clean trend vs chop)
  oscCount: number;        // direction reversals in the last 15 candles
  netDriftPct: number;     // net signed move over the window, %
  totalPathPct: number;    // total path traveled over the window, %
  spikeFlag: boolean;      // abnormal spike candle detected
  spikeMultiple: number;   // largest candle range ÷ median range
  driftUp: boolean;        // window net direction is up
  driftTowardTarget: boolean | null; // is the window drift heading toward the strike? null when no target
}

// Build a bet signal from the coin's intra-window momentum metrics.
// kalshiTarget is optional — coins without a market still get an ER/spike read.
function computeBetSignal(
  ind: {
    efficiencyRatio?: number;
    oscillationCount?: number;
    netDriftPct?: number;
    totalPathPct?: number;
    spikeFlag?: boolean;
    spikeMultiple?: number;
  },
  kalshiTarget: number | null,
  livePrice: number,
): BetSignal {
  const er = ind.efficiencyRatio ?? 0;
  const oscCount = ind.oscillationCount ?? 0;
  const netDriftPct = ind.netDriftPct ?? 0;
  const totalPathPct = ind.totalPathPct ?? 0;
  const spikeFlag = ind.spikeFlag ?? false;
  const spikeMultiple = ind.spikeMultiple ?? 0;

  // Spike overrides the ER-based classification.
  const level: BetSignal["level"] =
    spikeFlag ? "spike"
    : er >= 0.55 ? "trending"
    : er >= 0.25 ? "drifting"
    : "choppy";

  const driftUp = netDriftPct >= 0;
  // Trend-gap alignment: is the dominant direction heading toward the strike?
  // Above target + drifting down = closing the gap (toward strike → flip risk).
  // Below target + drifting up = closing the gap (toward strike → flip risk).
  // Drift that widens the gap moves away from the strike (safer).
  let driftTowardTarget: boolean | null = null;
  if (kalshiTarget !== null && livePrice > 0 && Math.abs(netDriftPct) > 0.0001) {
    const aboveTarget = livePrice >= kalshiTarget;
    driftTowardTarget = aboveTarget ? !driftUp : driftUp;
  }

  return {
    level,
    er,
    oscCount,
    netDriftPct,
    totalPathPct,
    spikeFlag,
    spikeMultiple,
    driftUp,
    driftTowardTarget,
  };
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
    efficiencyRatio?: number;
    oscillationCount?: number;
    netDriftPct?: number;
    totalPathPct?: number;
    spikeFlag?: boolean;
    spikeMultiple?: number;
  };
  sparkline: number[];
  candles: Candle[];
  predictions: Prediction[];
  kalshiTarget?: number | null; // Kalshi RTI strike for current 15-min window
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
const KALSHI_COINS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "BNB"];

const COIN_STYLE: Record<string, { glyph: string; accent: string; ring: string; glow: string }> = {
  BTC:  { glyph: "₿", accent: "text-amber-400",   ring: "ring-amber-500/40 border-amber-500/40",   glow: "shadow-amber-500/20" },
  ETH:  { glyph: "Ξ", accent: "text-indigo-400",  ring: "ring-indigo-500/40 border-indigo-500/40",  glow: "shadow-indigo-500/20" },
  SOL:  { glyph: "◎", accent: "text-fuchsia-400", ring: "ring-fuchsia-500/40 border-fuchsia-500/40", glow: "shadow-fuchsia-500/20" },
  XRP:  { glyph: "✕", accent: "text-sky-400",     ring: "ring-sky-500/40 border-sky-500/40",        glow: "shadow-sky-500/20" },
  HYPE: { glyph: "H", accent: "text-emerald-400", ring: "ring-emerald-500/40 border-emerald-500/40", glow: "shadow-emerald-500/20" },
  BNB:  { glyph: "B", accent: "text-yellow-300",  ring: "ring-yellow-400/40 border-yellow-400/40",  glow: "shadow-yellow-400/20" },
  LINK: { glyph: "⬡", accent: "text-blue-400",    ring: "ring-blue-500/40 border-blue-500/40",      glow: "shadow-blue-500/20" },
  DOGE: { glyph: "Ð", accent: "text-yellow-400",  ring: "ring-yellow-500/40 border-yellow-500/40",  glow: "shadow-yellow-500/20" },
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
// Self-Learning Dashboard — makes the whole adaptive loop visible: per-coin
// stat/Claude/combined accuracy, accuracy by regime, calibration quality,
// blend weights, and auto-pilot status.
// ---------------------------------------------------------------------------

// Calibration quality: sample-weighted average gap between Claude's reported
// confidence and its actual hit rate across confidence bands. Lower = better
// calibrated. Returns null until any band has evaluated samples.
function calibrationGap(
  cal: CoinAnalytics["calibration"],
): { gap: number; n: number } | null {
  let wsum = 0;
  let n = 0;
  for (const b of cal) {
    if (b.n > 0 && b.avgConfidencePct != null && b.hitRatePct != null) {
      wsum += Math.abs(b.avgConfidencePct - b.hitRatePct) * b.n;
      n += b.n;
    }
  }
  if (n === 0) return null;
  return { gap: Math.round(wsum / n), n };
}

function AccCell({ m, color }: { m: SourceMetrics; color: string }) {
  return (
    <div className="text-center">
      {m.accuracyPct !== null ? (
        <>
          <div className={`text-base font-black tabular-nums ${color}`}>{m.accuracyPct}%</div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            {m.hits}/{m.n}
          </div>
        </>
      ) : (
        <>
          <div className="text-base font-black text-muted-foreground/40">—</div>
          <div className="text-[10px] text-muted-foreground/50 tabular-nums">{m.n} bets</div>
        </>
      )}
    </div>
  );
}

const REGIME_META: Record<PromptRegime, { label: string; color: string }> = {
  trending: { label: "Trend", color: "text-emerald-400" },
  drifting: { label: "Drift", color: "text-amber-400" },
  choppy: { label: "Chop", color: "text-red-400" },
};

function SelfLearningDashboard({
  analytics,
  autoPilot,
  autoPilotMap,
  trainingCoins,
  loading,
  onToggleAutoPilot,
}: {
  analytics: CoinAnalytics[];
  autoPilot: AiSettings["autoPilot"];
  autoPilotMap: Map<string, AutoPilotDecision>;
  trainingCoins: Set<string>;
  loading: boolean;
  onToggleAutoPilot: (enabled: boolean) => void;
}) {
  const accColor = (pct: number | null) =>
    pct === null
      ? "text-muted-foreground/40"
      : pct >= 60
        ? "text-emerald-400"
        : pct >= 45
          ? "text-amber-400"
          : "text-red-400";

  const activeCount = autoPilot.decisions.filter((d) => d.active).length;

  return (
    <div>
      {/* ── Header + auto-pilot master control ── */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-primary" />
            Self-Learning Dashboard
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Where each model is winning · 30 s refresh
          </p>
        </div>
        <div className="flex items-center gap-3">
          {autoPilot.enabled && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {activeCount}/{autoPilot.maxActive} non-training coins
            </span>
          )}
          <button
            onClick={() => onToggleAutoPilot(!autoPilot.enabled)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              autoPilot.enabled
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
            }`}
            title={
              autoPilot.enabled
                ? "Auto-pilot is ON — Claude is enabled automatically where it beats the stat model. Applies to non-training coins only. Click to turn off."
                : "Turn on auto-pilot — let the system enable Claude only where it's earning its keep. Applies to non-training coins (SOL, LINK, DOGE) only."
            }
          >
            {autoPilot.enabled ? <Bot className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
            Auto-pilot {autoPilot.enabled ? "ON" : "OFF"}
          </button>
        </div>
      </div>
      {/* Training coins explanation */}
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2.5">
        <Bot className="w-3.5 h-3.5 text-violet-400 shrink-0 mt-0.5" />
        <div className="text-[11px] text-muted-foreground leading-snug">
          <span className="text-violet-300 font-semibold">BTC · ETH · XRP · HYPE · BNB</span> always run Claude — every window, automatically, building their accuracy records below.
          {" "}Auto-pilot controls the remaining coins (SOL, LINK, DOGE).
        </div>
      </div>

      {loading && analytics.length === 0 ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <Card className="bg-card/50 overflow-hidden">
          {/* Column header */}
          <div className="hidden sm:grid grid-cols-[3.5rem_1fr_1fr_1fr_1.4fr_1.2fr_1.6fr] gap-2 px-4 py-2 border-b border-border text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            <div>Coin</div>
            <div className="text-center">Stat</div>
            <div className="text-center text-violet-300/70">Claude</div>
            <div className="text-center text-primary/70">Combined</div>
            <div className="text-center">By regime (Claude)</div>
            <div className="text-center">Blend · Calib</div>
            <div>Auto-pilot</div>
          </div>

          <div className="divide-y divide-border">
            {analytics.map((a) => {
              const style = COIN_STYLE[a.symbol] ?? COIN_STYLE.BTC;
              const w = a.ensembleWeights.overall;
              const wr = a.ensembleWeights.byRegime;
              const regimeTip = (["trending", "drifting", "choppy"] as PromptRegime[])
                .map(
                  (reg) =>
                    `${REGIME_META[reg].label}: stat ${Math.round(wr[reg].stat * 100)}% / Claude ${Math.round(wr[reg].claude * 100)}%`,
                )
                .join("\n");
              const cal = calibrationGap(a.calibration);
              const decision = autoPilotMap.get(a.symbol);
              const statusBadge = trainingCoins.has(a.symbol) ? (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30" title="Always running Claude to build its accuracy track record">
                  <Bot className="w-3 h-3" /> Training
                </span>
              ) : !autoPilot.enabled ? (
                <span className="text-[10px] text-muted-foreground/50">Off</span>
              ) : decision?.active ? (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${decision.exploring ? "bg-sky-500/15 text-sky-300 ring-sky-500/30" : "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"}`} title={decision.reason}>
                  <Bot className="w-3 h-3" />{decision.exploring ? "Exploring" : "Claude on"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted/30 ring-1 ring-border" title={decision?.reason ?? "Stat only"}>
                  <Minus className="w-3 h-3" /> Stat only
                </span>
              );

              return (
                <div key={a.symbol}>

                  {/* ── Mobile card layout ── */}
                  <div className="sm:hidden px-4 py-3 space-y-3">

                    {/* Header: coin + status */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-lg font-bold ${style.accent}`}>{style.glyph}</span>
                        <span className="font-bold text-sm">{a.symbol}</span>
                      </div>
                      {statusBadge}
                    </div>

                    {/* Accuracy: Stat | Claude | Combined — with explicit labels */}
                    <div className="grid grid-cols-3 divide-x divide-border/50 border border-border/40 rounded-lg overflow-hidden">
                      {(
                        [
                          { label: "Stat",     m: a.bySource.stat,     labelCls: "text-muted-foreground/60" },
                          { label: "Claude",   m: a.bySource.claude,   labelCls: "text-violet-300/80" },
                          { label: "Combined", m: a.bySource.ensemble, labelCls: "text-primary/80" },
                        ] as const
                      ).map(({ label, m, labelCls }) => (
                        <div key={label} className="text-center py-2 px-1 bg-background/20">
                          <div className={`text-[9px] font-semibold uppercase tracking-wider mb-1 ${labelCls}`}>{label}</div>
                          {m.accuracyPct !== null ? (
                            <>
                              <div className={`text-base font-black tabular-nums ${accColor(m.accuracyPct)}`}>{m.accuracyPct}%</div>
                              <div className="text-[10px] text-muted-foreground">{m.hits}/{m.n}</div>
                            </>
                          ) : (
                            <>
                              <div className="text-base font-black text-muted-foreground/40">—</div>
                              <div className="text-[10px] text-muted-foreground/50">{m.n} bets</div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* By regime */}
                    <div className="border border-border/40 rounded-lg overflow-hidden">
                      <div className="px-3 py-1.5 bg-background/20 border-b border-border/40">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">By Regime · Claude accuracy</span>
                      </div>
                      <div className="grid grid-cols-3 divide-x divide-border/50">
                        {(["trending", "drifting", "choppy"] as PromptRegime[]).map((reg) => {
                          const m = a.byRegime.claude[reg];
                          const meta = REGIME_META[reg];
                          return (
                            <div key={reg} className="text-center py-2 bg-background/10" title={`${meta.label}: ${m.hits}/${m.n}`}>
                              <div className={`text-[9px] font-semibold uppercase ${meta.color}/80`}>{meta.label}</div>
                              <div className="text-sm font-bold tabular-nums mt-0.5">
                                {m.accuracyPct !== null ? `${m.accuracyPct}%` : "—"}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Blend bar + calibration */}
                    <div className="space-y-1.5">
                      <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-muted/40" title={`Stat ${Math.round(w.stat * 100)}% / Claude ${Math.round(w.claude * 100)}%\n${regimeTip}`}>
                        <div className="h-full bg-sky-400 transition-all" style={{ width: `${w.stat * 100}%` }} />
                        <div className="h-full bg-violet-400 transition-all" style={{ width: `${w.claude * 100}%` }} />
                      </div>
                      <div className="flex items-center justify-between text-[10px] tabular-nums">
                        <span className="text-sky-300/80 font-medium">Stat {Math.round(w.stat * 100)}%</span>
                        <span
                          className={cal === null ? "text-muted-foreground/50" : cal.gap <= 8 ? "text-emerald-400 font-medium" : cal.gap <= 15 ? "text-amber-400 font-medium" : "text-red-400 font-medium"}
                          title={cal ? `Calibration gap ±${cal.gap}% over ${cal.n} bets` : "Not enough Claude history for calibration"}
                        >
                          {cal ? `±${cal.gap}% cal` : "cal —"}
                        </span>
                        <span className="text-violet-300/80 font-medium">Claude {Math.round(w.claude * 100)}%</span>
                      </div>
                    </div>

                    {autoPilot.enabled && !trainingCoins.has(a.symbol) && decision?.reason && (
                      <div className="text-[10px] text-muted-foreground/60 leading-snug">{decision.reason}</div>
                    )}
                  </div>

                  {/* ── Desktop row layout (unchanged) ── */}
                  <div className="hidden sm:grid sm:grid-cols-[3.5rem_1fr_1fr_1fr_1.4fr_1.2fr_1.6fr] gap-2 px-4 py-3 items-center">
                    {/* Coin */}
                    <div className="flex items-center gap-1.5">
                      <span className={`text-base font-bold ${style.accent}`}>{style.glyph}</span>
                      <span className="font-semibold text-xs">{a.symbol}</span>
                    </div>

                    {/* Accuracy: stat / claude / combined */}
                    <AccCell m={a.bySource.stat} color={accColor(a.bySource.stat.accuracyPct)} />
                    <AccCell m={a.bySource.claude} color={accColor(a.bySource.claude.accuracyPct)} />
                    <AccCell m={a.bySource.ensemble} color={accColor(a.bySource.ensemble.accuracyPct)} />

                    {/* By regime (Claude) */}
                    <div className="flex items-center justify-center gap-2.5">
                      {(["trending", "drifting", "choppy"] as PromptRegime[]).map((reg) => {
                        const m = a.byRegime.claude[reg];
                        const meta = REGIME_META[reg];
                        return (
                          <div key={reg} className="text-center" title={`${meta.label}: ${m.hits}/${m.n}`}>
                            <div className={`text-[9px] font-semibold uppercase ${meta.color}/80`}>{meta.label}</div>
                            <div className="text-xs font-bold tabular-nums">
                              {m.accuracyPct !== null ? `${m.accuracyPct}%` : "—"}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Blend weights + calibration */}
                    <div className="space-y-1">
                      <div className="flex h-2 w-full rounded-full overflow-hidden bg-muted/40" title={`Blend weights the ensemble actually uses.\nOverall baseline — stat ${Math.round(w.stat * 100)}% / Claude ${Math.round(w.claude * 100)}%.\nPer regime (applied live when the market is in that regime):\n${regimeTip}`}>
                        <div className="h-full bg-sky-400" style={{ width: `${w.stat * 100}%` }} />
                        <div className="h-full bg-violet-400" style={{ width: `${w.claude * 100}%` }} />
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-muted-foreground tabular-nums">
                        <span className="text-sky-300/80">S {Math.round(w.stat * 100)}%</span>
                        <span
                          title={cal ? `Calibration gap: reported vs actual confidence differ by ±${cal.gap}% (over ${cal.n} bets). Lower is better.` : "Not enough Claude history to measure calibration yet"}
                          className={cal === null ? "text-muted-foreground/50" : cal.gap <= 8 ? "text-emerald-400" : cal.gap <= 15 ? "text-amber-400" : "text-red-400"}
                        >
                          ±{cal ? cal.gap : "—"}%
                        </span>
                        <span className="text-violet-300/80">C {Math.round(w.claude * 100)}%</span>
                      </div>
                    </div>

                    {/* Auto-pilot / training status */}
                    <div>
                      {statusBadge}
                      {autoPilot.enabled && !trainingCoins.has(a.symbol) && decision?.reason && (
                        <div className="text-[9px] text-muted-foreground/70 mt-0.5 leading-tight line-clamp-2">{decision.reason}</div>
                      )}
                    </div>
                  </div>

                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Best Windows to Trade panel
// ---------------------------------------------------------------------------

const TRAINING_COIN_FILTERS = ["ALL", "BTC", "ETH", "XRP", "HYPE", "BNB"] as const;

type BarViewMode = "er" | "accuracy";

function bucketBarColor(b: TradingWindowBucket, mode: BarViewMode = "er"): string {
  if (mode === "accuracy") {
    const sparse = b.evaluatedCount < 5 || b.accuracyPct === null;
    if (sparse) return "bg-slate-600/40";
    const acc = b.accuracyPct!;
    if (acc >= 65) return "bg-emerald-500";
    if (acc >= 55) return "bg-emerald-400/60";
    if (acc >= 45) return "bg-amber-400";
    if (acc >= 35) return "bg-orange-500";
    return "bg-red-500";
  }
  if (b.sparse || b.avgEfficiencyRatio === null) return "bg-slate-600/40";
  const er = b.avgEfficiencyRatio;
  if (er >= 0.55) return "bg-emerald-500";
  if (er >= 0.40) return "bg-emerald-400/60";
  if (er >= 0.25) return "bg-amber-400";
  if (er >= 0.15) return "bg-orange-500";
  return "bg-red-500";
}

function bucketBarHeight(b: TradingWindowBucket, maxPx = 56, mode: BarViewMode = "er"): number {
  if (mode === "accuracy") {
    const sparse = b.evaluatedCount < 5 || b.accuracyPct === null;
    if (sparse) return 4;
    return Math.max(4, Math.round((b.accuracyPct! / 100) * maxPx));
  }
  if (b.sparse || b.avgEfficiencyRatio === null) return 4;
  return Math.max(4, Math.round(b.avgEfficiencyRatio * maxPx));
}

function HourlyBars({
  hourly,
  currentHour,
  showLabels,
  mode = "er",
}: {
  hourly: TradingWindowsData["hourly"];
  currentHour: number;
  showLabels: Set<number>;
  mode?: BarViewMode;
}) {
  return (
    <div className="flex gap-px items-end" style={{ height: "72px" }}>
      {hourly.map((b) => {
        const isCurrent = b.hour === currentHour;
        const accSparse = b.evaluatedCount < 5 || b.accuracyPct === null;
        const h = bucketBarHeight(b, 56, mode);
        const col = bucketBarColor(b, mode);
        const isSparse = accSparse || b.sparse;
        const tip = mode === "accuracy"
          ? (accSparse
              ? `${b.label} ET: ${b.evaluatedCount} evaluated (sparse — need 5+)`
              : `${b.label} ET: ${b.evaluatedCount} evaluated · accuracy ${b.accuracyPct}% · ER ${b.avgEfficiencyRatio?.toFixed(2) ?? "—"}`)
          : (b.sparse
              ? `${b.label} ET: ${b.count} samples (sparse — need 10+)`
              : `${b.label} ET: ${b.count} windows · ER ${b.avgEfficiencyRatio?.toFixed(2)} · ${b.trendingPct ?? "—"}% trending · accuracy ${b.accuracyPct !== null ? `${b.accuracyPct}%` : "—"}`);
        return (
          <div
            key={b.hour}
            className="flex-1 flex flex-col items-center justify-end gap-0.5"
            style={{ height: "72px" }}
          >
            <div
              className={`w-full rounded-t transition-all ${col} ${
                isCurrent ? "ring-2 ring-white/50 ring-offset-0" : ""
              } ${isSparse ? "border border-dashed border-slate-500/50" : ""}`}
              style={{ height: `${h}px` }}
              title={tip}
            />
            {showLabels.has(b.hour) && (
              <span
                className={`text-[7px] leading-none ${
                  isCurrent ? "text-white/80 font-bold" : "text-muted-foreground/40"
                }`}
              >
                {b.hour === 0 ? "12A" : b.hour === 12 ? "12P" : b.hour < 12 ? `${b.hour}A` : `${b.hour - 12}P`}
              </span>
            )}
            {!showLabels.has(b.hour) && isCurrent && (
              <span className="text-[7px] leading-none text-white/80 font-bold">
                {b.hour === 0 ? "12A" : b.hour === 12 ? "12P" : b.hour < 12 ? `${b.hour}A` : `${b.hour - 12}P`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const ET_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const DOW_FILTER_LABELS = ["All", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Sun=0…Sat=6 in JS Date, matching our DOW_LABELS on the server.
const DOW_FILTER_INDEX: Record<string, number | null> = {
  All: null, Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Re-score an hourly bucket array and return top-N best + worst. */
function scoreHourly(
  hourly: Array<TradingWindowBucket & { hour: number; label: string }>,
  n = 3,
): { best: typeof hourly; worst: typeof hourly } {
  const scored = hourly
    .filter((h) => !h.sparse && h.avgEfficiencyRatio !== null)
    .map((h) => ({
      ...h,
      score: ((h.accuracyPct ?? 50) / 100) * 0.4 + (h.avgEfficiencyRatio ?? 0) * 0.6,
    }))
    .sort((a, b) => b.score - a.score);
  return {
    best:  scored.slice(0, Math.min(n, scored.length)),
    worst: scored.slice(-Math.min(n, scored.length)).reverse(),
  };
}

function TradingWindowsPanel({ currentEtHour }: { currentEtHour: number }) {
  const [coinFilter, setCoinFilter] = useState<string>("ALL");
  const [dayFilter, setDayFilter]   = useState<string>("All");
  const [open, setOpen]             = useState(true);
  const [barMode, setBarMode]       = useState<BarViewMode>("er");
  const SHOW_LABELS = new Set([0, 6, 12, 18]);

  const query = useQuery({
    queryKey: ["trading-windows", coinFilter],
    queryFn: () =>
      fetchJson<TradingWindowsData>(
        coinFilter === "ALL"
          ? "/crypto/trading-windows"
          : `/crypto/trading-windows?symbol=${coinFilter}`,
      ),
    refetchInterval: 15 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data ?? null;
  const updatedLabel = data?.lastUpdatedAt
    ? `Updated ${ET_TIME_FMT.format(new Date(data.lastUpdatedAt))} ET`
    : null;

  // Which hourly array to show — all-days or a specific day-of-week.
  const selectedDayIdx = DOW_FILTER_INDEX[dayFilter] ?? null;
  const activeHourly   = selectedDayIdx !== null
    ? (data?.byDayHour?.[selectedDayIdx] ?? data?.hourly ?? [])
    : (data?.hourly ?? []);

  // Best/worst for the currently visible hourly slice.
  const { best: bestHours, worst: worstHours } = data
    ? scoreHourly(activeHourly)
    : { best: [], worst: [] };

  const dayLabel = selectedDayIdx !== null ? `on ${dayFilter}s` : "across all days";

  return (
    <div className="mt-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-start gap-2 text-left group"
        >
          <Clock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1">
              Best Windows to Trade
              <span className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors text-xs ml-1">
                {open ? "▾" : "▸"}
              </span>
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              When training-coin markets are most predictable ·{" "}
              {data ? `${data.totalSamples} windows recorded` : "loading…"}
            </p>
          </div>
        </button>
        {/* Filters — only shown when expanded */}
        {open && (
          <div className="flex flex-col gap-1.5 items-end">
            {/* Coin filter */}
            <div className="flex gap-1 flex-wrap justify-end">
              {TRAINING_COIN_FILTERS.map((c) => (
                <button
                  key={c}
                  onClick={() => setCoinFilter(c)}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                    coinFilter === c
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-border bg-muted/20 text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            {/* Day-of-week filter */}
            <div className="flex gap-1 flex-wrap justify-end">
              {DOW_FILTER_LABELS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDayFilter(d)}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                    dayFilter === d
                      ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                      : "border-border bg-muted/20 text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {open && (
        <>
          {query.isLoading && !data ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : !data?.hasEnoughData ? (
            /* ── Collecting data state ── */
            <Card className="bg-card/50 px-4 py-3 space-y-3">
              <div className="flex items-start gap-2">
                <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                <div className="text-[11px] leading-snug">
                  <span className="text-amber-300 font-semibold">Collecting data </span>
                  <span className="text-muted-foreground">
                    — needs at least 50 recorded windows to identify patterns.{" "}
                    {data ? `${data.totalSamples} recorded so far.` : ""}
                  </span>
                </div>
              </div>
              {data && data.totalSamples > 0 && (
                <div className="opacity-40 pointer-events-none">
                  <HourlyBars hourly={activeHourly} currentHour={currentEtHour} showLabels={SHOW_LABELS} />
                </div>
              )}
            </Card>
          ) : (
            /* ── Full panel ── */
            <Card className="bg-card/50 px-4 py-4 space-y-4">

              {/* Best / Worst chips */}
              {(bestHours.length > 0 || worstHours.length > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {bestHours.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider shrink-0">
                        ✓ Best {dayLabel}
                      </span>
                      {bestHours.map((h) => (
                        <span
                          key={h.hour}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                          title={`ER ${h.avgEfficiencyRatio?.toFixed(2)} · accuracy ${h.accuracyPct ?? "—"}% · ${h.count} windows`}
                        >
                          {h.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {worstHours.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-semibold text-red-400 uppercase tracking-wider shrink-0">
                        ✗ Avoid {dayLabel}
                      </span>
                      {worstHours.map((h) => (
                        <span
                          key={h.hour}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
                          title={`ER ${h.avgEfficiencyRatio?.toFixed(2)} · accuracy ${h.accuracyPct ?? "—"}% · ${h.count} windows`}
                        >
                          {h.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 24-hour bar chart */}
              <div>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-semibold">
                    {selectedDayIdx !== null
                      ? `${dayFilter}s only — `
                      : "All days — "}
                    {barMode === "er"
                      ? "bar height = avg efficiency ratio · white outline = now"
                      : "bar height = prediction accuracy % · white outline = now"}
                  </div>
                  {/* Mode toggle */}
                  <div className="flex shrink-0 rounded overflow-hidden border border-border text-[9px] font-semibold">
                    <button
                      onClick={() => setBarMode("er")}
                      className={`px-2 py-0.5 transition-colors ${
                        barMode === "er"
                          ? "bg-primary/20 text-primary"
                          : "bg-muted/20 text-muted-foreground hover:bg-muted/40"
                      }`}
                    >
                      Efficiency ratio
                    </button>
                    <button
                      onClick={() => setBarMode("accuracy")}
                      className={`px-2 py-0.5 transition-colors ${
                        barMode === "accuracy"
                          ? "bg-primary/20 text-primary"
                          : "bg-muted/20 text-muted-foreground hover:bg-muted/40"
                      }`}
                    >
                      Accuracy %
                    </button>
                  </div>
                </div>
                <HourlyBars hourly={activeHourly} currentHour={currentEtHour} showLabels={SHOW_LABELS} mode={barMode} />
              </div>

              {/* Day-of-week chart — hide when a specific day is already selected */}
              {selectedDayIdx === null && (
                <div>
                  <div className="text-[10px] text-muted-foreground/60 mb-2 uppercase tracking-wider font-semibold">
                    Day of week — click a day above to drill in
                  </div>
                  <div className="flex gap-2 items-end" style={{ height: "52px" }}>
                    {data.daily.map((b) => (
                      <button
                        key={b.dayIndex}
                        onClick={() => setDayFilter(DOW_FILTER_LABELS[b.dayIndex + 1])}
                        className="flex-1 flex flex-col items-center gap-1 group"
                        title={
                          b.sparse
                            ? `${b.label}: ${b.count} samples (sparse)`
                            : `${b.label}: ER ${b.avgEfficiencyRatio?.toFixed(2)} · ${b.trendingPct ?? "—"}% trending · accuracy ${b.accuracyPct ?? "—"}%`
                        }
                      >
                        <div
                          className={`w-full rounded-t transition-all group-hover:opacity-80 ${bucketBarColor(b)}`}
                          style={{ height: `${bucketBarHeight(b, 36)}px` }}
                        />
                        <span className="text-[9px] text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">{b.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Legend */}
              <div className="flex items-center gap-3 flex-wrap text-[9px] text-muted-foreground/60">
                {barMode === "er" ? (
                  <>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />Trending (ER≥0.55)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />Drifting (0.25–0.55)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />Choppy (&lt;0.25)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-600/40 border border-dashed border-slate-500/60 inline-block" />Sparse (&lt;10 samples)</span>
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />Strong (≥65%)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-400/60 inline-block" />Good (55–65%)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />Coin-flip (45–55%)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-orange-500 inline-block" />Weak (35–45%)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />Poor (&lt;35%)</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-600/40 border border-dashed border-slate-500/60 inline-block" />Sparse (&lt;5 evaluated)</span>
                  </>
                )}
              </div>

              <div className="text-[9px] text-muted-foreground/40 flex items-center gap-2 flex-wrap">
                <span>{updatedLabel ?? "Updated every 15 min"}</span>
                <span>·</span>
                <span>hover a bar for details</span>
                <span>·</span>
                <span>{data.totalSamples} recorded windows</span>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prediction Accuracy Log — tracks 15-min boundary predictions vs actual
// ---------------------------------------------------------------------------

function PredictionHistory({ symbol, tz }: { symbol: string; tz: string }) {
  const ACCURACY_THRESHOLD = 1.0; // fallback for non-BTC / no Kalshi target
  const [clearing, setClearing] = useState(false);

  type SourceSummary = { hits: number; total: number; pct: number | null };
  const query = useQuery({
    queryKey: ["pred-history", symbol],
    queryFn: () =>
      fetchJson<{
        symbol: string;
        history: PredictionRecord[];
        sourceSummary?: { stat: SourceSummary; claude: SourceSummary; ensemble: SourceSummary; ml: SourceSummary };
        windowGroups?: { targetTime: string; records: PredictionRecord[] }[];
        abstention?: { evaluated: number; avoidedLoss: number; missedWin: number; avoidedLossPct: number | null };
        accuracyThresholdPct: number;
      }>(`/crypto/prediction-history?symbol=${symbol}`),
    refetchInterval: 30_000,
  });

  async function handleClear() {
    if (!confirm("Clear all prediction history? This cannot be undone.")) return;
    setClearing(true);
    try {
      await fetch(`${API_BASE}/crypto/prediction-history`, { method: "DELETE" });
      await query.refetch();
    } finally {
      setClearing(false);
    }
  }

  const history = query.data?.history ?? [];
  const evaluated = history.filter((r) => r.status === "evaluated");
  // Headline accuracy counts BET windows only — abstentions ("no bet") are not
  // wins or losses, so they're excluded from the hit-rate denominator.
  const headlineBets = evaluated.filter((r) => r.abstained !== true);
  const hits = headlineBets.filter((r) => r.correct === true).length;
  const accuracyPct = headlineBets.length > 0 ? Math.round((hits / headlineBets.length) * 100) : null;

  // Per-source hit rates come from the server rollup (over ALL records, not just
  // the one-per-window headlines shown below) so each model's rate is accurate.
  const empty: SourceSummary = { hits: 0, total: 0, pct: null };
  const claudeStats = query.data?.sourceSummary?.claude ?? empty;
  const statStats = query.data?.sourceSummary?.stat ?? empty;
  const ensembleStats = query.data?.sourceSummary?.ensemble ?? empty;
  const mlStats = query.data?.sourceSummary?.ml ?? empty;
  const abstention = query.data?.abstention;

  // Build a lookup from targetTime → all model records for the per-model strip on each card
  const windowGroupMap = new Map<string, PredictionRecord[]>();
  for (const wg of query.data?.windowGroups ?? []) {
    windowGroupMap.set(wg.targetTime, wg.records);
  }

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

  // Accuracy log needs fixed-width full precision so $1.07 and $1.0698 are distinguishable.
  const fmtPrice = (n: number): string => {
    if (!isFinite(n)) return "—";
    const dp = n >= 1000 ? 2 : n >= 100 ? 2 : n >= 10 ? 2 : n >= 1 ? 4 : 5;
    return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };

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

        <div className="flex items-center gap-3 shrink-0 ml-4">
          {(claudeStats.pct !== null || statStats.pct !== null || ensembleStats.pct !== null || mlStats.pct !== null) && (
            <div className="text-right text-[11px] leading-tight">
              {ensembleStats.pct !== null && (
                <div className="text-primary">
                  Combined{" "}
                  <span className="font-semibold tabular-nums">{ensembleStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({ensembleStats.hits}/{ensembleStats.total})</span>
                </div>
              )}
              {claudeStats.pct !== null && (
                <div className="text-violet-300">
                  Claude{" "}
                  <span className="font-semibold tabular-nums">{claudeStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({claudeStats.hits}/{claudeStats.total})</span>
                </div>
              )}
              {statStats.pct !== null && (
                <div className="text-sky-300">
                  Stat{" "}
                  <span className="font-semibold tabular-nums">{statStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({statStats.hits}/{statStats.total})</span>
                </div>
              )}
              {mlStats.pct !== null && (
                <div className="text-teal-300">
                  ML{" "}
                  <span className="font-semibold tabular-nums">{mlStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({mlStats.hits}/{mlStats.total})</span>
                </div>
              )}
              {abstention && abstention.evaluated > 0 && (
                <div className="text-amber-300/80">
                  No-bet{" "}
                  <span className="font-semibold tabular-nums">{abstention.avoidedLossPct ?? 0}%</span>{" "}
                  <span className="text-muted-foreground">avoided ({abstention.avoidedLoss}/{abstention.evaluated})</span>
                </div>
              )}
            </div>
          )}
          {accuracyPct !== null && (
            <div className="text-right">
              <div
                className={`text-3xl font-black leading-none tabular-nums ${
                  accuracyPct >= 60 ? "text-emerald-400" : accuracyPct >= 40 ? "text-amber-400" : "text-red-400"
                }`}
              >
                {accuracyPct}%
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">
                {hits} / {headlineBets.length} correct
              </div>
            </div>
          )}
          <button
            onClick={handleClear}
            disabled={clearing}
            title="Clear all history"
            className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
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
            const isAbstained = rec.abstained === true;
            const hasTarget = rec.kalshiTarget !== null && rec.kalshiTarget !== undefined;
            const predictedAbove = hasTarget && rec.predictedPrice >= rec.kalshiTarget!;
            const actualAbove    = hasTarget && rec.actualPrice !== null && rec.actualPrice >= rec.kalshiTarget!;

            const borderColor = isPending
              ? "border-l-amber-400/70"
              : isAbstained
              ? "border-l-muted-foreground/40"
              : rec.correct
              ? "border-l-emerald-500"
              : "border-l-red-500";

            const statusBadge = isPending ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded-full px-2.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Pending
              </span>
            ) : isAbstained ? (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground bg-muted/30 border border-border rounded-full px-2.5 py-0.5"
                title={
                  rec.status === "evaluated"
                    ? rec.correct
                      ? "Skipped — the would-be bet would have won (missed)"
                      : "Skipped — the would-be bet would have lost (good skip)"
                    : "No bet — models disagreed or confidence too low"
                }
              >
                <Minus className="w-3 h-3" /> No bet
              </span>
            ) : rec.correct ? (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-500/25 rounded-full px-2.5 py-0.5"
                title="Model accuracy: our above/below call matched the Coinbase price captured at window close. Kalshi settles on its own data source at the exact :00/:15/:30/:45 mark — your bet outcome may differ slightly."
              >
                <CheckCircle2 className="w-3 h-3" /> Hit
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-400 bg-red-400/10 border border-red-500/25 rounded-full px-2.5 py-0.5"
                title="Model accuracy: our above/below call did not match the Coinbase price captured at window close. Kalshi settles on its own data source at the exact :00/:15/:30/:45 mark — your bet outcome may differ slightly."
              >
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
                key={rec.id ?? rec.targetTime}
                className={`border-l-4 ${borderColor} rounded-r-xl bg-card/50 hover:bg-card/80 transition-colors overflow-hidden`}
              >
                {/* Card header — time + status badge */}
                <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border/40">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold tabular-nums">
                      {new Intl.DateTimeFormat("en-US", {
                        timeZone: "America/New_York",
                        hour: "numeric",
                        minute: "2-digit",
                        hour12: true,
                      }).format(new Date(new Date(rec.targetTime).getTime() - 15 * 60_000))}
                      {" – "}
                      {rec.targetLabel}
                    </span>
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
                        <span>${formatPrice(rec.kalshiTarget!)}</span>
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

                  {/* Per-model verdict strip — shows all 4 sources for this window */}
                  {(() => {
                    const wgRecs = windowGroupMap.get(rec.targetTime) ?? [];
                    if (wgRecs.length <= 1) return null;
                    const srcColor: Record<string, string> = {
                      ensemble: "text-primary",
                      claude: "text-violet-300",
                      stat: "text-sky-300",
                      ml: "text-teal-300",
                    };
                    const srcLabel: Record<string, string> = {
                      ensemble: "Combined",
                      claude: "Claude",
                      stat: "Stat",
                      ml: "ML",
                    };
                    return (
                      <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-border/30">
                        {wgRecs.map((r, i) => {
                          const rAbove = r.kalshiTarget != null
                            ? r.predictedPrice >= r.kalshiTarget
                            : r.predictedDirection === "up";
                          // Detect "locked at open": snapped within 2 min of window open
                          const windowOpenMs = new Date(r.targetTime).getTime() - 15 * 60_000;
                          const snappedMs = new Date(r.snappedAt).getTime();
                          const isLockedAtOpen = Math.abs(snappedMs - windowOpenMs) <= 2 * 60_000;
                          const badge = r.status === "pending" ? (
                            <span className="text-[9px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded px-1 py-0.5 leading-none">
                              Pending
                            </span>
                          ) : r.abstained ? (
                            <span className="text-[9px] font-semibold text-muted-foreground/70 bg-muted/30 border border-border/60 rounded px-1 py-0.5 leading-none">
                              Abstain
                            </span>
                          ) : r.correct ? (
                            <span className="text-[9px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-500/30 rounded px-1 py-0.5 leading-none">
                              Hit ✓
                            </span>
                          ) : (
                            <span className="text-[9px] font-semibold text-red-400 bg-red-400/10 border border-red-500/30 rounded px-1 py-0.5 leading-none">
                              Miss ✗
                            </span>
                          );
                          return (
                            <div
                              key={(r.source ?? "unknown") + "-" + i}
                              className="group flex items-center gap-1 text-[10px] cursor-default"
                              title={`${srcLabel[r.source ?? "stat"] ?? r.source}: ${r.confidence}% confidence${isLockedAtOpen ? " · locked at window open" : " · mid-window call"}`}
                            >
                              <span className={`font-semibold ${srcColor[r.source ?? "stat"] ?? "text-muted-foreground"}`}>
                                {srcLabel[r.source ?? "stat"] ?? r.source}
                              </span>
                              <span className={rAbove ? "text-emerald-400" : "text-red-400"}>{rAbove ? "↑" : "↓"}</span>
                              {isLockedAtOpen && (
                                <Lock className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0" />
                              )}
                              {/* Confidence — always visible, highlighted on hover */}
                              <span className="tabular-nums text-muted-foreground/50 group-hover:text-muted-foreground/90 transition-colors">
                                {r.confidence}%
                              </span>
                              {badge}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
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
  const [driftAlerts, setDriftAlerts] = useState<Record<string, DriftAlert>>({});
  const lastAutoTriggerRef = useRef<number>(0);
  const prevStatAboveRef = useRef<boolean | null>(null);
  // Tracks the locked prediction call at window-open for each coin
  const windowOpenCallRef = useRef<Record<string, { windowTarget: string; aboveKalshi: boolean | null; direction: "up" | "down" | "flat" }>>({});
  const enhanceAbortRef = useRef<AbortController | null>(null);

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

  // ML model prediction — poll every 5 s so direction flips surface immediately.
  // The route is cheap (in-memory inference) so aggressive polling is fine.
  const mlPredQuery = useQuery({
    queryKey: ["ml-prediction", selected],
    queryFn: () => fetchJson<MLPredResponse>(`/crypto/ml-prediction/${selected}`),
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  // AI settings — controls whether Claude tracker runs per-coin (server-persisted)
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: () => fetchJson<AiSettings>("/crypto/ai-settings"),
    refetchInterval: 10_000,
  });
  const aiSettings: AiSettings = aiSettingsQuery.data ?? {
    mode: "stat",
    claudeCoins: [],
    trainingCoins: ["BTC", "ETH", "XRP", "HYPE", "BNB"],
    autoPilot: { enabled: false, maxActive: 0, decisions: [] },
  };
  const claudeEnabledSet = useMemo(() => new Set(aiSettings.claudeCoins), [aiSettings.claudeCoins]);
  const trainingCoinsSet = useMemo(() => new Set(aiSettings.trainingCoins ?? []), [aiSettings.trainingCoins]);
  const autoPilot = aiSettings.autoPilot;
  const autoPilotMap = useMemo(() => {
    const m = new Map<string, AutoPilotDecision>();
    for (const d of autoPilot.decisions) m.set(d.symbol, d);
    return m;
  }, [autoPilot.decisions]);

  async function handleSetMode(mode: "stat" | "claude") {
    await fetch(`${API_BASE}/crypto/ai-settings/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    void aiSettingsQuery.refetch();
  }

  async function handleToggleCoinClaude(symbol: string, enabled: boolean) {
    await fetch(`${API_BASE}/crypto/ai-settings/coin/${symbol}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    void aiSettingsQuery.refetch();
  }

  async function handleToggleAutoPilot(enabled: boolean) {
    await fetch(`${API_BASE}/crypto/ai-settings/auto-pilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    void aiSettingsQuery.refetch();
  }

  // Self-learning analytics — per-coin model accuracy, regime, calibration, weights
  const analyticsQuery = useQuery({
    queryKey: ["prediction-analytics"],
    queryFn: () => fetchJson<{ analytics: CoinAnalytics[] }>("/crypto/prediction-analytics"),
    refetchInterval: 30_000,
  });

  // Per-coin accuracy summary — single request, refreshes every 60s
  const accuracySummaryQuery = useQuery({
    queryKey: ["accuracy-summary"],
    queryFn: () =>
      fetchJson<{ summary: { symbol: string; hits: number; total: number; pct: number | null }[] }>(
        "/crypto/prediction-history/summary",
      ),
    refetchInterval: 60_000,
  });
  const accuracyMap = useMemo(() => {
    const m = new Map<string, { pct: number | null; total: number }>();
    for (const s of accuracySummaryQuery.data?.summary ?? []) {
      m.set(s.symbol, { pct: s.pct, total: s.total });
    }
    return m;
  }, [accuracySummaryQuery.data]);

  // Kalshi 15-min target — supported for BTC, ETH, and XRP
  const kalshiTargetQuery = useQuery({
    queryKey: ["kalshi-target", selected],
    queryFn: () => fetchJson<KalshiTarget>(`/crypto/kalshi-target?symbol=${selected}`),
    // Refetch faster when the cached market has already expired so the new
    // window's target arrives within 3 s rather than waiting a full 10 s.
    refetchInterval: (query) => {
      const ct = query.state.data?.closeTime;
      return ct && new Date(ct).getTime() < Date.now() ? 3_000 : 10_000;
    },
    enabled: KALSHI_COINS.includes(selected),
  });
  const ktd = kalshiTargetQuery.data;
  const kalshiAvailableTop = KALSHI_COINS.includes(selected) && ktd?.available === true;
  // Belt-and-suspenders frontend guard: if the fetched market's close_time has
  // already passed, the target is from the just-expired window — treat it as
  // null so no ABOVE/BELOW verdict is rendered against the wrong strike price.
  // The server-side cache already bypasses on this condition, but the frontend
  // may still hold stale ktd for up to one refetch cycle.
  const kalshiWindowExpired = Boolean(
    ktd?.closeTime && new Date(ktd.closeTime).getTime() < Date.now(),
  );
  const kalshiTarget = kalshiAvailableTop && !kalshiWindowExpired
    ? (ktd?.targetPrice ?? null)
    : null;
  const kalshiIsLive = ktd?.isLive === true && !kalshiWindowExpired;
  const kalshiEventTicker = ktd?.eventTicker;

  // Tracker window snapshot — Claude's and stat model's opening calls for the current window.
  // Free (in-memory lookup on the server), safe to poll every 30s.
  const trackerSnapshotQuery = useQuery({
    queryKey: ["tracker-snapshot", selected],
    queryFn: () => fetchJson<{ snapshot: TrackerWindowCall | null; statSnapshot: TrackerWindowCall | null }>(`/crypto/tracker-snapshot/${selected}`),
    refetchInterval: 30_000,
    enabled: trainingCoinsSet.has(selected) || claudeEnabledSet.has(selected),
  });
  const trackerSnapshot = trackerSnapshotQuery.data?.snapshot ?? null;
  const statSnapshot = trackerSnapshotQuery.data?.statSnapshot ?? null;

  // Live direction — lightweight mid-window Claude re-check.
  // liveForceRef: when true the next fetch bypasses the server-side 2-min cache (?force=1).
  // Set to true before any manual refresh or auto-trigger (model flip).
  const liveForceRef = useRef(false);
  const liveDirectionQuery = useQuery({
    queryKey: ["live-direction", selected],
    queryFn: () => {
      const force = liveForceRef.current;
      liveForceRef.current = false;
      return fetchJson<LiveDirectionResult>(
        `/crypto/live-direction/${selected}${force ? "?force=1" : ""}`
      );
    },
    refetchInterval: 30_000, // poll every 30 s; cache handles dedup on the server
    enabled: trainingCoinsSet.has(selected) || claudeEnabledSet.has(selected),
  });
  const liveDirection = liveDirectionQuery.data ?? null;

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

  function handleCancelEnhance() {
    if (enhanceAbortRef.current) {
      enhanceAbortRef.current.abort();
      enhanceAbortRef.current = null;
    }
    setAiLoading(false);
    setAiError("Cancelled");
    setAutoTriggerReason(null);
  }

  async function handleEnhance() {
    if (aiLoading) return;
    setAiError(null);
    setAiLoading(true);
    // Only persist Claude tracking for training coins — non-training coins
    // are stat-only (no API cost). Training coins are always-on server-side.
    if (trainingCoinsSet.has(selected) && !claudeEnabledSet.has(selected)) {
      void handleToggleCoinClaude(selected, true);
    }
    const sym = selected;
    const priceSnapshot = livePrice;
    const tickerSnapshot = kalshiEventTicker;
    // 60-second hard timeout — Claude extended thinking can be slow
    const abort = new AbortController();
    enhanceAbortRef.current = abort;
    const timer = setTimeout(() => abort.abort(), 60_000);
    try {
      const res = await fetch(`${API_BASE}/crypto/ai-predict?symbol=${sym}`, { signal: abort.signal });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Server error ${res.status}: ${body}`);
      }
      const data = (await res.json()) as {
        predictions: AIPredictionItem[];
        generatedAt: string;
        ensembleWeights?: EnsembleWeights;
        abstainMinConf?: number;
      };
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
          ensembleWeights: data.ensembleWeights,
          abstainMinConf: data.abstainMinConf,
        },
      }));
      // ── Drift detection ──────────────────────────────────────────────────
      // Compare Claude's fresh call against the locked window-open prediction.
      // If they disagree on ABOVE/BELOW (or direction for non-Kalshi), alert.
      const locked = windowOpenCallRef.current[sym];
      const aiPred0 = data.predictions[0] ?? null;
      if (locked && aiPred0) {
        const currentKalshi = kalshiTarget; // closure capture
        const aiAbove = currentKalshi !== null ? aiPred0.predictedPrice >= currentKalshi : null;
        const drifted =
          currentKalshi !== null
            ? aiAbove !== locked.aboveKalshi
            : aiPred0.direction !== locked.direction && locked.direction !== "flat";
        if (drifted) {
          setDriftAlerts((prev) => ({
            ...prev,
            [sym]: {
              lockedAbove: locked.aboveKalshi,
              claudeAbove: aiAbove,
              lockedDirection: locked.direction,
              claudeDirection: aiPred0.direction,
              detectedAt: new Date(data.generatedAt),
              windowTarget: locked.windowTarget,
            },
          }));
        } else {
          setDriftAlerts((prev) => {
            if (!prev[sym]) return prev;
            const n = { ...prev };
            delete n[sym];
            return n;
          });
        }
      }
      setAutoTriggerReason(null);
      // Sync Claude Pulse "Live now" immediately — the Enhance call just ran Claude,
      // so force a fresh live-direction check rather than waiting up to 30 s.
      void liveDirectionQuery.refetch();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setAiError("Request timed out — try again");
      } else {
        const msg = err instanceof Error ? err.message : "AI enhancement failed";
        setAiError(msg);
      }
      setAutoTriggerReason(null);
    } finally {
      clearTimeout(timer);
      enhanceAbortRef.current = null;
      setAiLoading(false);
    }
  }

  // ── Window-open call tracker ──────────────────────────────────────────────
  // Record the locked prediction at the moment a new 15-min window opens.
  // Used to detect drift when Claude re-analyzes mid-window.
  useEffect(() => {
    if (!active) return;
    const target = active.predictions[0]?.target;
    if (!target) return;
    const current = windowOpenCallRef.current[selected];
    if (current?.windowTarget !== target) {
      const aboveKalshi =
        kalshiTarget !== null && active.predictions[0]
          ? active.predictions[0].predictedPrice >= kalshiTarget
          : null;
      windowOpenCallRef.current = {
        ...windowOpenCallRef.current,
        [selected]: {
          windowTarget: target,
          aboveKalshi,
          direction: active.predictions[0]?.direction ?? "flat",
        },
      };
      // Clear drift when window changes
      setDriftAlerts((prev) => {
        if (!prev[selected]) return prev;
        const n = { ...prev };
        delete n[selected];
        return n;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.predictions[0]?.target, selected, kalshiTarget]);

  // ── Auto-trigger logic ────────────────────────────────────────────────────
  // Two triggers: new Kalshi window opens, or stat model flips Above/Below.
  // Guarded by a 90-second cooldown so we don't burn API calls on noise.
  const COOLDOWN_MS = 90_000;

  useEffect(() => {
    if (!KALSHI_COINS.includes(selected)) return;
    if (!kalshiIsLive || kalshiTarget === null) return;
    // Auto-trigger only fires when the user has enabled Claude for this coin
    if (!claudeEnabledSet.has(selected)) return;

    const entry = aiData[selected] ?? null;

    // ── Trigger 1: New Kalshi window ──────────────────────────────────────
    // Also guard with hysteresis: if price is within 0.15% of the strike at
    // window open, the binary is too close to call — skip the auto-trigger.
    if (entry && kalshiEventTicker && kalshiEventTicker !== entry.eventTickerAtRun) {
      const now = Date.now();
      if (now - lastAutoTriggerRef.current >= COOLDOWN_MS) {
        const newWindowGapPct =
          statPred0 != null && kalshiTarget !== null
            ? Math.abs(statPred0.predictedPrice - kalshiTarget) / kalshiTarget
            : 1; // unknown gap → allow trigger
        if (newWindowGapPct >= 0.0015) {
          lastAutoTriggerRef.current = now;
          setAutoTriggerReason("New Kalshi window");
          void handleEnhance();
          return;
        }
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
  // statPred0?.predictedPrice included so the effect reruns as price drifts —
  // a noisy cross that later becomes convincing (>=0.15% gap) without another
  // side change would otherwise be missed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statAboveNow, statPred0?.predictedPrice, kalshiEventTicker, kalshiIsLive, kalshiTarget]);

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
                    {/* Row 1: symbol + 24h change */}
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`text-base font-bold shrink-0 ${style.accent}`}>{style.glyph}</span>
                        <span className="font-semibold text-sm truncate">{coin.symbol}</span>
                      </div>
                      <span className={`text-[11px] font-medium shrink-0 ml-1 ${chg >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {formatPct(chg)}
                      </span>
                    </div>
                    {/* Row 2: badges */}
                    {(() => {
                      const acc = accuracyMap.get(coin.symbol);
                      const training = trainingCoinsSet.has(coin.symbol);
                      const auto = autoPilotMap.get(coin.symbol)?.active ?? false;
                      const hasAcc = acc && acc.pct !== null && acc.total >= 1;
                      const hasMode = training || claudeEnabledSet.has(coin.symbol) || auto;
                      if (!hasAcc && !hasMode) return <div className="mb-1.5" />;
                      const accColor = !hasAcc ? "" :
                        acc!.pct! >= 65 ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/30"
                        : acc!.pct! >= 45 ? "bg-amber-500/20 text-amber-400 ring-amber-500/30"
                        : "bg-red-500/20 text-red-400 ring-red-500/30";
                      return (
                        <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                          {hasAcc && (
                            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none ${accColor}`}>
                              {acc!.pct}%
                            </span>
                          )}
                          {training && (
                            <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-violet-500/25 text-violet-300 ring-violet-500/40" title="Training coin">
                              <Bot className="w-2.5 h-2.5" /> Training
                            </span>
                          )}
                          {!training && claudeEnabledSet.has(coin.symbol) && (
                            <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-violet-500/20 text-violet-300 ring-violet-500/30" title="Claude AI tracking active">
                              <Sparkles className="w-2.5 h-2.5" /> Claude
                            </span>
                          )}
                          {!training && !claudeEnabledSet.has(coin.symbol) && auto && (
                            <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-emerald-500/20 text-emerald-300 ring-emerald-500/30" title={autoPilotMap.get(coin.symbol)?.reason ?? "Auto-pilot"}>
                              <Bot className="w-2.5 h-2.5" /> Auto
                            </span>
                          )}
                        </div>
                      );
                    })()}
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
                    {(() => {
                      if (coin.indicators.efficiencyRatio == null) return null;
                      const sig = computeBetSignal(coin.indicators, coin.kalshiTarget ?? null, price);
                      const meta = {
                        trending: { color: "text-emerald-400", label: "Trending" },
                        drifting: { color: "text-amber-400", label: "Drifting" },
                        choppy: { color: "text-red-400", label: "Choppy" },
                        spike: { color: "text-orange-400", label: "⚠ Spike" },
                      }[sig.level];
                      return (
                        <div className={`mt-0.5 flex items-center gap-1 text-[9px] font-bold ${meta.color}`}>
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "currentColor" }} />
                          {meta.label}
                          <span className="font-normal opacity-70">({sig.er.toFixed(2)}×)</span>
                        </div>
                      );
                    })()}
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
            onCancelEnhance={handleCancelEnhance}
            claudeActive={claudeEnabledSet.has(selected)}
            onToggleClaude={(enabled) => void handleToggleCoinClaude(selected, enabled)}
            autoPilotDecision={autoPilot.enabled ? (autoPilotMap.get(selected) ?? null) : null}
            kalshiTarget={kalshiTarget}
            kalshiIsLive={kalshiIsLive}
            kalshiLoading={kalshiTargetQuery.isFetching}
            onRefreshKalshi={() => void kalshiTargetQuery.refetch()}
            ktd={ktd}
            driftAlert={driftAlerts[selected] ?? null}
            trackerSnapshot={trackerSnapshot}
            liveDirection={liveDirection}
            liveDirectionLoading={liveDirectionQuery.isFetching}
            onRefreshLiveDirection={() => {
              liveForceRef.current = true;
              void liveDirectionQuery.refetch();
            }}
            isTrainingCoin={trainingCoinsSet.has(selected)}
            statSnapshot={statSnapshot}
            mlPred={mlPredQuery.data ?? null}
            onRefreshStat={() => void predQuery.refetch()}
            statLoading={predQuery.isFetching}
          />
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            <Skeleton className="h-80 rounded-xl lg:col-span-2" />
            <Skeleton className="h-80 rounded-xl" />
          </div>
        )}

        <SelfLearningDashboard
          analytics={analyticsQuery.data?.analytics ?? []}
          autoPilot={autoPilot}
          autoPilotMap={autoPilotMap}
          trainingCoins={trainingCoinsSet}
          loading={analyticsQuery.isLoading}
          onToggleAutoPilot={(enabled) => void handleToggleAutoPilot(enabled)}
        />

        <TradingWindowsPanel
          currentEtHour={(() => {
            const parts = new Intl.DateTimeFormat("en-US", {
              timeZone: "America/New_York",
              hour: "numeric",
              hour12: false,
            }).formatToParts(now);
            const raw = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
            return raw === 24 ? 0 : raw;
          })()}
        />

        <PredictionHistory symbol={selected} tz={tz} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adaptive ensemble — client mirror of the server's computeEnsemble so the
// headline combined call is derived from the exact stat/Claude values shown in
// the two model columns (keeping the headline consistent with what's on screen).
// ---------------------------------------------------------------------------

interface CombinedCall {
  predictedPrice: number;
  confidence: number;
  direction: "up" | "down" | "flat";
  changePct: number;
  above: boolean | null;
  abstained: boolean;
  conflict: boolean;   // stat and Claude are on opposite sides of the target
  reason: string;
}

function computeCombinedCall(args: {
  statPrice: number;
  statConf: number;
  statDir: "up" | "down" | "flat";
  aiPrice: number;
  aiConf: number;
  aiDir: "up" | "down" | "flat";
  weights: EnsembleWeights;
  abstainMinConf: number;
  livePrice: number;
  kalshiTarget: number | null;
}): CombinedCall {
  const { statPrice, statConf, statDir, aiPrice, aiConf, aiDir, weights, abstainMinConf, livePrice, kalshiTarget } = args;
  const predictedPrice = weights.stat * statPrice + weights.claude * aiPrice;
  const confidence = Math.round(weights.stat * statConf + weights.claude * aiConf);
  const changePct = livePrice > 0 ? ((predictedPrice - livePrice) / livePrice) * 100 : 0;
  const direction: "up" | "down" | "flat" =
    changePct > 0.05 ? "up" : changePct < -0.05 ? "down" : "flat";
  const above = kalshiTarget !== null ? predictedPrice >= kalshiTarget : null;

  // Use target as the reference for conflict detection when available.
  // Comparing predicted prices vs current live price creates false conflicts
  // when price has moved away from the strike mid-window.
  const statAboveKt = kalshiTarget !== null ? statPrice >= kalshiTarget : null;
  const aiAboveKt   = kalshiTarget !== null ? aiPrice  >= kalshiTarget : null;
  const conflict = statAboveKt !== null && aiAboveKt !== null
    ? statAboveKt !== aiAboveKt
    : (statDir === "up" && aiDir === "down") || (statDir === "down" && aiDir === "up");

  const lowConf  = confidence < abstainMinConf;
  // Only suppress Kalshi bet on genuine model conflict or very low confidence.
  const abstained = conflict || lowConf;
  const reason = conflict
    ? "Stat and Claude are on opposite sides of the target"
    : lowConf
      ? `Combined confidence ${confidence}% below ${abstainMinConf}% threshold`
      : "Models agree — regime-weighted blend";
  return { predictedPrice, confidence, direction, changePct, above, abstained, conflict, reason };
}

// Small helper used by the Claude Pulse panel — extracted to module level so
// React doesn't see a "new" component type on every render.
function AboveLabel({ above, conf }: { above: boolean | null | undefined; conf?: number }) {
  if (above === null || above === undefined)
    return <span className="text-muted-foreground/60 text-sm">—</span>;
  return (
    <span className={`flex items-center gap-1 font-black text-lg ${above ? "text-emerald-400" : "text-red-400"}`}>
      {above ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
      {above ? "ABOVE" : "BELOW"}
      {conf !== undefined && (
        <span className="text-[11px] font-normal text-muted-foreground ml-1">{conf}%</span>
      )}
    </span>
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
  onCancelEnhance,
  claudeActive,
  onToggleClaude,
  autoPilotDecision,
  kalshiTarget,
  kalshiIsLive,
  kalshiLoading,
  onRefreshKalshi,
  ktd,
  driftAlert,
  trackerSnapshot,
  statSnapshot,
  liveDirection,
  liveDirectionLoading,
  onRefreshLiveDirection,
  isTrainingCoin,
  mlPred,
  onRefreshStat,
  statLoading,
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
  onCancelEnhance: () => void;
  claudeActive: boolean;
  onToggleClaude: (enabled: boolean) => void;
  autoPilotDecision: AutoPilotDecision | null;
  kalshiTarget: number | null;
  kalshiIsLive: boolean;
  kalshiLoading: boolean;
  onRefreshKalshi: () => void;
  ktd: KalshiTarget | undefined;
  driftAlert: DriftAlert | null;
  trackerSnapshot: TrackerWindowCall | null;
  statSnapshot?: TrackerWindowCall | null;
  liveDirection: LiveDirectionResult | null;
  liveDirectionLoading: boolean;
  onRefreshLiveDirection: () => void;
  isTrainingCoin: boolean;
  mlPred?: MLPredResponse | null;
  onRefreshStat: () => void;
  statLoading: boolean;
}) {
  const style = COIN_STYLE[coin.symbol] ?? COIN_STYLE.BTC;
  const kalshiAvailable = KALSHI_COINS.includes(coin.symbol) && ktd?.available === true;
  // Computed locally from available props so CoinCard doesn't need an extra prop.
  const windowExpiredLocal = Boolean(ktd?.closeTime && new Date(ktd.closeTime).getTime() < Date.now());
  const kalshiTargetRefreshing = KALSHI_COINS.includes(coin.symbol) && (
    windowExpiredLocal || (kalshiLoading && !kalshiAvailable)
  );
  // Near-close: when < 2 minutes remain, suppress the opening-call lock and show
  // the live stat prediction instead. The live price is a far better predictor of
  // the closing price at that horizon than a model call made 10+ minutes ago.
  const windowRemainingMs = ktd?.closeTime
    ? Math.max(0, new Date(ktd.closeTime).getTime() - Date.now())
    : Infinity;
  const nearWindowClose = windowRemainingMs < 120_000 && windowRemainingMs > 0;

  // Derive Claude's call from the AI forecast — same data as the cards, never contradicts.
  const claudeAiPred0 = aiEntry?.preds[0] ?? null;
  const claudeAbove: boolean | null =
    kalshiTarget !== null && claudeAiPred0 !== null
      ? claudeAiPred0.predictedPrice >= kalshiTarget
      : null;
  const claudePredPrice: number | null = claudeAiPred0?.predictedPrice ?? null;
  const claudeConfidence: number | null = claudeAiPred0?.confidence ?? null;

  // Headline combined call (first window) — regime-weighted blend of the stat
  // baseline and Claude, with explicit no-bet abstention. Only when an AI run
  // with weights is present; otherwise the banner falls back to Claude's call.
  const statHead = coin.predictions[0] ?? null;

  // ── Opening-stat snapshot ────────────────────────────────────────────────
  // Capture the stat model's ABOVE/BELOW call at window open (when the tracker
  // fires and sets a new trackerSnapshot.snappedAt). This lets us show "At open"
  // vs "Live now" so the user can see if the stat model has flipped mid-window.
  const prevSnappedAtRef = useRef<string | null>(null);
  const [openingStatAbove, setOpeningStatAbove] = useState<boolean | null>(null);

  // ── Force-refresh confirmation ────────────────────────────────────────────
  const [statJustRefreshed, setStatJustRefreshed] = useState(false);
  const statRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleRefreshStat() {
    onRefreshStat();
    setStatJustRefreshed(true);
    if (statRefreshTimerRef.current) clearTimeout(statRefreshTimerRef.current);
    statRefreshTimerRef.current = setTimeout(() => setStatJustRefreshed(false), 2000);
  }
  useEffect(() => {
    if (!trackerSnapshot || kalshiTarget === null || !statHead) return;
    if (trackerSnapshot.snappedAt !== prevSnappedAtRef.current) {
      prevSnappedAtRef.current = trackerSnapshot.snappedAt;
      setOpeningStatAbove(statHead.predictedPrice >= kalshiTarget);
    }
  }, [trackerSnapshot, kalshiTarget, statHead]);

  const combinedHead: CombinedCall | null =
    aiEntry?.ensembleWeights && claudeAiPred0 && statHead && livePrice > 0
      ? computeCombinedCall({
          statPrice: statHead.predictedPrice,
          statConf: statHead.confidence,
          // Use target as the direction reference when available — "up" = ABOVE
          // the Kalshi strike, not above the current live price (which may have
          // moved significantly from the strike since window open).
          statDir: kalshiTarget !== null
            ? (statHead.predictedPrice >= kalshiTarget ? "up" : "down")
            : ((statHead.predictedPrice - livePrice) / livePrice) * 100 > 0.05 ? "up"
              : ((statHead.predictedPrice - livePrice) / livePrice) * 100 < -0.05 ? "down" : "flat",
          aiPrice: claudeAiPred0.predictedPrice,
          aiConf: claudeAiPred0.confidence,
          aiDir: kalshiTarget !== null
            ? (claudeAiPred0.predictedPrice >= kalshiTarget ? "up" : "down")
            : ((claudeAiPred0.predictedPrice - livePrice) / livePrice) * 100 > 0.05 ? "up"
              : ((claudeAiPred0.predictedPrice - livePrice) / livePrice) * 100 < -0.05 ? "down" : "flat",
          weights: aiEntry.ensembleWeights,
          abstainMinConf: aiEntry.abstainMinConf ?? 55,
          livePrice,
          kalshiTarget,
        })
      : null;

  // Auto-Pilot direction: uses whichever model has the proven accuracy edge.
  // When active (Claude wins historically) → uses Claude's direction.
  // When inactive (stat wins or insufficient data) → uses stat direction.
  // The confidence weight is the winning model's historical accuracy %.
  const autoPilotAbove: boolean | null = (() => {
    if (!autoPilotDecision || kalshiTarget === null) return null;
    if (autoPilotDecision.active) {
      return claudeAbove ?? (trackerSnapshot?.aboveKalshi ?? null);
    }
    return statHead ? statHead.predictedPrice >= kalshiTarget : null;
  })();
  const autoPilotConf: number | null = autoPilotDecision
    ? (autoPilotDecision.active
        ? (autoPilotDecision.claudeAccuracyPct ?? 55)
        : (autoPilotDecision.statAccuracyPct ?? 55))
    : null;

  // Multi-signal consensus — weighted vote across stat model, Claude AI (window
  // open or tracker snapshot), Auto-Pilot, and ML Model.
  interface ConsensusSignal { name: string; above: boolean; conf: number; modelUsed?: "claude" | "stat" | "ml" }
  const consensusSignals: ConsensusSignal[] = (() => {
    if (kalshiTarget === null) return [];
    const sigs: ConsensusSignal[] = [];
    if (statHead != null)
      sigs.push({ name: "Stat", above: statHead.predictedPrice >= kalshiTarget, conf: statHead.confidence });
    const claudeSig = claudeAbove !== null
      ? { name: "Claude AI", above: claudeAbove, conf: claudeConfidence ?? 55 }
      : trackerSnapshot?.aboveKalshi != null
      ? { name: "Claude AI", above: trackerSnapshot.aboveKalshi, conf: trackerSnapshot.confidence }
      : null;
    if (claudeSig) sigs.push(claudeSig);
    if (autoPilotAbove !== null && autoPilotConf !== null)
      sigs.push({
        name: "Auto-Pilot",
        above: autoPilotAbove,
        conf: autoPilotConf,
        modelUsed: autoPilotDecision?.active ? "claude" : "stat",
      });
    if (mlPred?.ready && mlPred.above !== null && mlPred.confidence !== null)
      sigs.push({ name: "ML Model", above: mlPred.above, conf: mlPred.confidence, modelUsed: "ml" });
    return sigs;
  })();
  const consAboveW   = consensusSignals.filter(s => s.above).reduce((sum, s) => sum + s.conf, 0);
  const consBelowW   = consensusSignals.filter(s => !s.above).reduce((sum, s) => sum + s.conf, 0);
  const consTotalW   = consAboveW + consBelowW;
  const consensusAbove = consTotalW > 0 ? consAboveW >= consBelowW : null;
  const consensusConf  = consTotalW > 0 && consensusAbove !== null
    ? Math.round((consensusAbove ? consAboveW : consBelowW) / consTotalW * 100)
    : null;
  const consensusAgreement = consensusSignals.filter(s => s.above === consensusAbove).length;
  const allConsensusAgree  = consensusAgreement === consensusSignals.length && consensusSignals.length > 1;

  // Margin signal — how safely the stat prediction sits from the Kalshi strike.
  const betSig: BetSignal | null =
    coin.indicators.efficiencyRatio != null
      ? computeBetSignal(coin.indicators, kalshiTarget, livePrice)
      : null;

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

      {/* ── Prediction Hub — Kalshi target + all model calls (unified card) ── */}
      {kalshiAvailable && (
        <div className="rounded-xl border-2 border-[#00C805]/40 bg-[#00C805]/6 overflow-hidden">

          {/* ── HEADER ── */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-[#00C805]/20 bg-[#00C805]/8 gap-2 flex-wrap">
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
              {ktd?.closeTime && kalshiIsLive && (
                <span className="text-[11px] text-muted-foreground hidden sm:inline">closes <span className="font-medium text-foreground">{toET(ktd.closeTime)} ET</span></span>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={onRefreshKalshi}
                disabled={kalshiLoading}
                title="Refresh Kalshi target"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${kalshiLoading ? "animate-spin" : ""}`} />
              </button>
              {ktd?.url && (
                <a href={ktd.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[#00C805]/80 hover:text-[#00C805] transition-colors">
                  View on Kalshi <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="w-px h-4 bg-border/40 mx-0.5" />
              {aiError && (
                <span className="text-[10px] text-red-400 max-w-[160px] truncate" title={aiError}>⚠ {aiError}</span>
              )}
              {!aiError && !aiLoading && aiEntry && (
                <span className={`text-[10px] tabular-nums ${staleClass}`}>
                  {aiEntry.at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} {tz}
                  {staleMins !== null && staleMins >= 3 && <span className="ml-1 opacity-70">({staleMins}m)</span>}
                </span>
              )}
              {!aiError && aiLoading && autoTriggerReason && (
                <span className="text-[10px] text-amber-400 flex items-center gap-1">
                  <Zap className="w-3 h-3" /> {autoTriggerReason}
                </span>
              )}
              {claudeActive && (
                <button
                  onClick={() => onToggleClaude(false)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                  title="Claude auto-tracking — click to disable"
                >
                  <Sparkles className="w-2.5 h-2.5" /> Claude active
                </button>
              )}
              {!claudeActive && autoPilotDecision?.active && (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border ${
                    autoPilotDecision.exploring
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  }`}
                  title={autoPilotDecision.reason}
                >
                  <Bot className="w-2.5 h-2.5" />
                  Auto-pilot{autoPilotDecision.exploring ? " · exploring" : ""}
                </span>
              )}
              {isTrainingCoin && aiLoading && (
                <button
                  onClick={onCancelEnhance}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-semibold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  ✕ Cancel
                </button>
              )}
              {isTrainingCoin && (
                <button
                  onClick={onEnhance}
                  disabled={aiLoading}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[10px] font-semibold border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {aiLoading ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> {autoTriggerReason ? "Auto-analyzing…" : "Analyzing…"}</>
                  ) : aiEntry ? (
                    <><Sparkles className="w-3 h-3" /> Re-analyze</>
                  ) : (
                    <><Sparkles className="w-3 h-3" /> Enhance</>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* ── STATS ROW: Strike | Current + Price Action | Claude's Call ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#00C805]/15">

            {/* Strike price + Combined call */}
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
              {combinedHead && (
                <div className="mt-3 pt-3 border-t border-[#00C805]/15">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1 flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-primary/60" /> Combined
                    {aiEntry?.ensembleWeights && (
                      <span className="font-normal normal-case tracking-normal text-muted-foreground/50">
                        · s{Math.round(aiEntry.ensembleWeights.stat * 100)}% c{Math.round(aiEntry.ensembleWeights.claude * 100)}%
                      </span>
                    )}
                  </div>
                  {combinedHead.conflict ? (
                    <div className="inline-flex items-center gap-1 text-sm font-black text-amber-400">
                      <Minus className="w-4 h-4" /> SPLIT SIGNAL
                    </div>
                  ) : combinedHead.above !== null ? (
                    <>
                      <div className={`flex items-center gap-1 text-lg font-black ${combinedHead.above ? "text-emerald-400" : "text-red-400"}`}>
                        {combinedHead.above ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                        {combinedHead.above ? "ABOVE" : "BELOW"}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        ${formatPrice(combinedHead.predictedPrice)} · {combinedHead.confidence}%
                        {combinedHead.abstained && <span className="text-amber-400/80 ml-1">· skip bet</span>}
                      </div>
                      {kalshiIsLive && !combinedHead.abstained && (
                        <div className={`mt-1 text-xs font-bold ${combinedHead.above ? "text-emerald-400" : "text-red-400"}`}>
                          → Bet {combinedHead.above ? "YES" : "NO"} on Kalshi
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </div>

            {/* Current price vs target + Price Action */}
            <div className="px-5 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">Current Price</div>
              {kalshiTarget !== null ? (
                <>
                  <div className="text-3xl font-black tabular-nums">${formatPrice(livePrice)}</div>
                  <div className={`text-sm font-bold mt-0.5 flex items-center gap-1 ${livePrice >= kalshiTarget ? "text-emerald-400" : "text-red-400"}`}>
                    {livePrice >= kalshiTarget ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                    {livePrice >= kalshiTarget ? "Above" : "Below"} target
                    <span className="font-normal text-[11px] text-muted-foreground ml-1">
                      ({livePrice >= kalshiTarget ? "+" : ""}{(((livePrice - kalshiTarget) / kalshiTarget) * 100).toFixed(2)}%)
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-3xl font-black tabular-nums">${formatPrice(livePrice)}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">strike not yet set</div>
                </>
              )}
              {betSig && (() => {
                const erPct = Math.min(100, Math.max(0, betSig.er * 100));
                const cfgColor: Record<string, string> = { choppy: "text-red-400", drifting: "text-amber-400", trending: "text-emerald-400", spike: "text-orange-400" };
                const cfgBar: Record<string, string> = { choppy: "bg-red-400", drifting: "bg-amber-400", trending: "bg-emerald-400", spike: "bg-orange-400" };
                const cfgLabel: Record<string, string> = { choppy: "Choppy", drifting: "Drifting", trending: "Trending", spike: "Spike ⚠" };
                return (
                  <div className="mt-3 pt-3 border-t border-[#00C805]/15">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1.5">Price Action</div>
                    <div className={`text-sm font-bold ${cfgColor[betSig.level]}`}>{cfgLabel[betSig.level]}</div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden">
                        <div className={`h-full rounded-full ${cfgBar[betSig.level]}`} style={{ width: `${erPct}%` }} />
                      </div>
                      <span className={`text-[10px] font-bold tabular-nums shrink-0 ${cfgColor[betSig.level]}`}>{betSig.er.toFixed(2)}× ER</span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {betSig.oscCount} reversals · {betSig.driftUp ? "▲" : "▼"} {betSig.netDriftPct.toFixed(3)}%{betSig.spikeFlag ? " · ⚠ spike" : ""}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Claude's call */}
            <div className="px-5 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1 flex items-center gap-2">
                Claude's Call
                {staleMins !== null && !aiLoading && (
                  <span className={`font-normal normal-case tracking-normal text-[10px] ${staleClass}`}>
                    {staleMins === 0 ? "just now" : `${staleMins}m ago`}
                  </span>
                )}
              </div>
              {kalshiTarget === null ? (
                <div className="text-sm text-muted-foreground flex items-center gap-1.5">
                  {kalshiTargetRefreshing ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Calculating…</>
                  ) : "Awaiting target price…"}
                </div>
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
              ) : isTrainingCoin && trackerSnapshot !== null ? (
                <>
                  <div className={`flex items-center gap-1.5 text-xl font-black ${trackerSnapshot.aboveKalshi ? "text-emerald-400" : "text-red-400"}`}>
                    {trackerSnapshot.aboveKalshi ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />}
                    {trackerSnapshot.aboveKalshi ? "ABOVE" : "BELOW"}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    ${formatPrice(trackerSnapshot.predictedPrice)} · {trackerSnapshot.confidence}% conf.
                  </div>
                  <div className="text-[10px] text-violet-400/80 mt-1 flex items-center gap-1">
                    <Bot className="w-3 h-3" /> Auto-ran at window open
                  </div>
                  {kalshiIsLive && (
                    <div className={`mt-1.5 text-xs font-bold ${trackerSnapshot.aboveKalshi ? "text-emerald-400" : "text-red-400"}`}>
                      → Bet {trackerSnapshot.aboveKalshi ? "YES" : "NO"} on Kalshi
                    </div>
                  )}
                </>
              ) : isTrainingCoin ? (
                <div className="text-[11px] text-muted-foreground/70 leading-snug flex items-start gap-1.5">
                  <Bot className="w-3.5 h-3.5 text-violet-400/60 shrink-0 mt-0.5" />
                  <span>Claude runs automatically at window open — or click Enhance for a call now</span>
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground/70 leading-snug">
                  Click Enhance to see Claude's call
                </div>
              )}
            </div>
          </div>

          {/* ── MODEL DETAIL — shown when AI consensus is available ── */}
          {(isTrainingCoin || claudeActive) && kalshiTarget !== null && (() => {
            const showPanel = consensusSignals.length > 0 || liveDirectionLoading;
            if (!showPanel) return null;
            const dp = (p: number) => p >= 100 ? 2 : p >= 1 ? 4 : 6;
            const pctVsStrike = (p: number) => kalshiTarget ? ((p - kalshiTarget) / kalshiTarget * 100) : null;
            return (
              <>
                {/* 4 Model cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-[#00C805]/15 border-t border-[#00C805]/20">

                  {/* Stat Model */}
                  <div className="px-4 py-4 text-center">
                    <div className="text-[11px] font-bold text-muted-foreground/80 mb-2 flex items-center justify-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-400/70" />Stat Model
                    </div>
                    {statHead && kalshiTarget !== null ? (() => {
                      const liveAbove = statHead.predictedPrice >= kalshiTarget;
                      const pct = pctVsStrike(statHead.predictedPrice)!;
                      const snapAbove = statSnapshot && kalshiTarget !== null ? statSnapshot.predictedPrice >= kalshiTarget : null;
                      const snapFlipped = snapAbove !== null && snapAbove !== liveAbove;
                      return (
                        <>
                          <div className={`text-lg font-black leading-none mb-1 ${liveAbove ? "text-emerald-400" : "text-red-400"}`}>
                            {liveAbove ? "↑ ABOVE" : "↓ BELOW"}
                          </div>
                          <div className={`text-[11px] font-semibold ${pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(3)}%
                          </div>
                          {nearWindowClose && (
                            <div className="text-[10px] text-amber-400/70 mt-0.5">
                              {Math.round(windowRemainingMs / 1_000)}s left
                            </div>
                          )}
                          {statSnapshot && snapAbove !== null && (
                            <div className={`flex items-center justify-center gap-0.5 mt-1.5 text-[9px] ${snapFlipped ? "text-amber-400/80" : "text-muted-foreground/50"}`}>
                              <Lock className="w-2 h-2 shrink-0" />
                              <span>open: {snapAbove ? "↑" : "↓"} {statSnapshot.confidence}%</span>
                              {snapFlipped && <span className="font-semibold">· flipped</span>}
                            </div>
                          )}
                        </>
                      );
                    })() : statHead ? (
                      <div className="text-lg font-black text-foreground leading-none mb-1">
                        ${statHead.predictedPrice.toFixed(dp(statHead.predictedPrice))}
                      </div>
                    ) : statSnapshot && kalshiTarget !== null ? (() => {
                      const snapAbove = statSnapshot.predictedPrice >= kalshiTarget;
                      const pct = pctVsStrike(statSnapshot.predictedPrice)!;
                      return (
                        <>
                          <div className={`text-lg font-black leading-none mb-1 ${snapAbove ? "text-emerald-400" : "text-red-400"}`}>
                            {snapAbove ? "↑ ABOVE" : "↓ BELOW"}
                          </div>
                          <div className={`text-[11px] font-semibold ${pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(3)}%
                          </div>
                          <div className="flex items-center justify-center gap-0.5 mt-1 text-[9px] text-muted-foreground/60">
                            <Lock className="w-2 h-2 shrink-0" />
                            <span>locked at open · {statSnapshot.confidence}%</span>
                          </div>
                        </>
                      );
                    })() : (
                      <div className="text-[11px] text-muted-foreground/60 italic">—</div>
                    )}
                  </div>

                  {/* Claude AI */}
                  <div className="px-4 py-4 text-center">
                    <div className="text-[11px] font-bold text-muted-foreground/80 mb-2 flex items-center justify-center gap-1">
                      <Sparkles className="w-2.5 h-2.5 text-violet-400/80" />Claude AI
                    </div>
                    {(() => {
                      const effectiveClaudePrice = claudePredPrice ?? trackerSnapshot?.predictedPrice ?? null;
                      return effectiveClaudePrice != null ? (
                        kalshiTarget !== null ? (() => {
                          const above = effectiveClaudePrice >= kalshiTarget;
                          const pct = pctVsStrike(effectiveClaudePrice)!;
                          return (
                            <>
                              <div className={`text-lg font-black leading-none mb-1 ${above ? "text-emerald-400" : "text-red-400"}`}>
                                {above ? "↑ ABOVE" : "↓ BELOW"}
                              </div>
                              <div className={`text-[11px] font-semibold ${pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {pct >= 0 ? "+" : ""}{pct.toFixed(3)}%
                              </div>
                            </>
                          );
                        })() : (
                          <div className="text-lg font-black leading-none">${effectiveClaudePrice.toFixed(dp(effectiveClaudePrice))}</div>
                        )
                      ) : (
                        <div className="text-[11px] text-muted-foreground/60 italic">run Enhance</div>
                      );
                    })()}
                  </div>

                  {/* Auto-Pilot */}
                  <div className="px-4 py-4 text-center bg-violet-500/[0.03]">
                    <div className="text-[11px] font-bold text-violet-400/80 mb-2 flex items-center justify-center gap-1">
                      <Bot className="w-2.5 h-2.5" />Auto-Pilot
                    </div>
                    {autoPilotDecision && kalshiTarget !== null ? (() => {
                      const apPrice = autoPilotDecision.active
                        ? (claudePredPrice ?? trackerSnapshot?.predictedPrice ?? null)
                        : (statHead?.predictedPrice ?? null);
                      const apPct = apPrice != null ? ((apPrice - kalshiTarget) / kalshiTarget * 100) : null;
                      const modelLabel = autoPilotDecision.active ? "Claude" : "Stat";
                      const claudeAcc = autoPilotDecision.claudeAccuracyPct;
                      const statAcc = autoPilotDecision.statAccuracyPct;
                      const bothHaveAcc = claudeAcc != null && statAcc != null;
                      return (
                        <>
                          {autoPilotDecision.exploring && (
                            <div className="text-[9px] font-bold uppercase tracking-wider text-amber-400/80 mb-1">Exploring</div>
                          )}
                          {apPrice != null ? (
                            <>
                              <div className={`text-lg font-black leading-none mb-1 ${apPct !== null && apPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {apPct !== null ? (apPct >= 0 ? "↑ ABOVE" : "↓ BELOW") : `$${apPrice.toFixed(dp(apPrice))}`}
                              </div>
                              {apPct != null && (
                                <div className={`text-[11px] font-semibold ${apPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                  {apPct >= 0 ? "+" : ""}{apPct.toFixed(3)}%
                                </div>
                              )}
                            </>
                          ) : autoPilotAbove !== null ? (
                            <div className={`text-lg font-black leading-none mb-1 ${autoPilotAbove ? "text-emerald-400" : "text-red-400"}`}>
                              {autoPilotAbove ? "↑ ABOVE" : "↓ BELOW"}
                            </div>
                          ) : null}
                          <div className="mt-1.5 text-[9px] text-violet-300/70 font-medium leading-tight">
                            {bothHaveAcc
                              ? `via ${modelLabel} · ${(autoPilotDecision.active ? claudeAcc : statAcc)!.toFixed(0)}% vs ${(autoPilotDecision.active ? statAcc : claudeAcc)!.toFixed(0)}%`
                              : autoPilotDecision.reason}
                          </div>
                        </>
                      );
                    })() : (
                      <div className="text-[11px] text-muted-foreground/60 italic mt-2">collecting data…</div>
                    )}
                  </div>

                  {/* ML Model */}
                  <div className="px-4 py-4 text-center bg-sky-500/[0.03]">
                    <div className="text-[11px] font-bold text-sky-400/80 mb-2 flex items-center justify-center gap-1">
                      <Activity className="w-2.5 h-2.5" />ML Model
                    </div>
                    {mlPred ? (
                      mlPred.ready && mlPred.above !== null && !windowExpiredLocal ? (
                        <>
                          <div className={`text-lg font-black leading-none mb-1 ${mlPred.above ? "text-emerald-400" : "text-red-400"}`}>
                            {mlPred.above ? "↑ ABOVE" : "↓ BELOW"}
                          </div>
                          <div className={`text-[11px] font-semibold tabular-nums ${mlPred.above ? "text-emerald-400/80" : "text-red-400/80"}`}>
                            {mlPred.confidence}% conf
                          </div>
                          <div className="mt-2 text-[10px] text-sky-300/60 font-medium">
                            {mlPred.valAccuracy != null ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5">
                                {mlPred.valAccuracy}% val · {mlPred.windows}w
                              </span>
                            ) : `${mlPred.windows}w · learning`}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-[11px] text-muted-foreground/60 mb-2">Training…</div>
                          <div className="w-full bg-muted/30 rounded-full h-1.5 mx-auto max-w-[80px]">
                            <div
                              className="bg-sky-500/70 h-1.5 rounded-full transition-all duration-500"
                              style={{ width: `${Math.min(100, ((mlPred.windows ?? 0) / (mlPred.minWindows ?? 30)) * 100)}%` }}
                            />
                          </div>
                          <div className="text-[10px] text-sky-400/60 mt-1.5 tabular-nums">
                            {mlPred.windows}/{mlPred.minWindows} windows
                          </div>
                        </>
                      )
                    ) : (
                      <div className="text-[11px] text-muted-foreground/60 italic mt-2">initializing…</div>
                    )}
                  </div>

                </div>

                {/* ── Signals + At-open footer ── */}
                {(consensusSignals.length > 0 || (trackerSnapshot && kalshiTarget !== null && (openingStatAbove !== null || trackerSnapshot.aboveKalshi !== null))) && (
                  <div className="px-5 py-3 border-t border-[#00C805]/20 bg-background/10 space-y-2">

                    {/* Signal chips + agree count + refresh */}
                    {consensusSignals.length > 0 && (
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground/50 font-semibold uppercase tracking-wider shrink-0">Now:</span>
                        {consensusSignals.map((sig) => {
                          const isAP = sig.name === "Auto-Pilot";
                          const isML = sig.name === "ML Model";
                          return (
                            <div
                              key={sig.name}
                              className={`flex items-center gap-0.5 text-[11px] font-semibold ${sig.above ? "text-emerald-400" : "text-red-400"}`}
                              title={isAP
                                ? `Auto-Pilot · via ${sig.modelUsed === "claude" ? "Claude" : "Stat"} · ${sig.conf.toFixed(0)}% historical acc`
                                : isML
                                ? `ML Model · logistic regression · ${sig.conf}% confidence`
                                : sig.name === "Stat"
                                ? `Stat model · ${sig.conf}% conf`
                                : `Claude AI · ${sig.conf}% conf`}
                            >
                              {sig.above ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                              <span className={isAP ? "text-violet-300" : isML ? "text-sky-300" : ""}>{sig.name}</span>
                              {isAP && sig.modelUsed && (
                                <span className="font-normal text-violet-300/60 text-[10px] ml-0.5">({sig.modelUsed === "claude" ? "C" : "S"})</span>
                              )}
                              {isML && mlPred?.valAccuracy != null && (
                                <span className="font-normal text-sky-300/60 text-[10px] ml-0.5">({mlPred.valAccuracy}%)</span>
                              )}
                            </div>
                          );
                        })}
                        {consensusSignals.length > 1 && (
                          <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ring-1 ${
                            allConsensusAgree
                              ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
                              : "bg-amber-500/15 text-amber-400 ring-amber-500/30"
                          }`}>
                            {consensusAgreement}/{consensusSignals.length} agree
                          </span>
                        )}
                        <button
                          onClick={handleRefreshStat}
                          disabled={statLoading}
                          title="Force-refresh all models"
                          className={`inline-flex items-center gap-1.5 text-[10px] font-medium ml-auto px-2 py-1 rounded transition-all ${
                            statJustRefreshed
                              ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/30"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/30 border border-transparent"
                          } disabled:opacity-40`}
                        >
                          {statJustRefreshed ? (
                            <><Check className="w-3 h-3" /> Refreshed</>
                          ) : (
                            <><RefreshCw className={`w-3 h-3 ${statLoading ? "animate-spin" : ""}`} /> Refresh</>
                          )}
                        </button>
                      </div>
                    )}

                    {/* At-open row */}
                    {trackerSnapshot && kalshiTarget !== null &&
                      (openingStatAbove !== null || trackerSnapshot.aboveKalshi !== null) && (() => {
                      const statAboveNow = statHead ? statHead.predictedPrice >= kalshiTarget : null;
                      const statFlippedMid = openingStatAbove !== null && statAboveNow !== null && openingStatAbove !== statAboveNow;
                      const claudeAboveOpen = trackerSnapshot.aboveKalshi;
                      const claudeFlippedMid = claudeAboveOpen !== null && claudeAbove !== null && claudeAboveOpen !== claudeAbove;
                      const mlAboveAtOpen = (mlPred?.ready && mlPred.above !== null && !windowExpiredLocal) ? mlPred.above : null;
                      const openingSplit = openingStatAbove !== null && claudeAboveOpen !== null && openingStatAbove !== claudeAboveOpen;
                      const openingEnsembleAbove = openingStatAbove !== null && claudeAboveOpen !== null && !openingSplit ? openingStatAbove : null;
                      const ensembleFlippedMid = openingEnsembleAbove !== null && combinedHead?.above != null
                        ? openingEnsembleAbove !== combinedHead.above : false;
                      const anyFlipped = statFlippedMid || claudeFlippedMid || ensembleFlippedMid;
                      return (
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/55 shrink-0">
                            <Clock className="w-3 h-3" />
                            At open ·{" "}
                            {new Date(trackerSnapshot.snappedAt).toLocaleTimeString("en-US", {
                              hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
                            })} ET
                          </div>
                          <div className="w-px h-3 bg-border/30 shrink-0" />
                          {openingStatAbove !== null && (
                            <div className={`flex items-center gap-0.5 text-[10px] font-semibold ${openingStatAbove ? "text-emerald-400/70" : "text-red-400/70"}`}>
                              {openingStatAbove ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span>Stat</span>
                              {statFlippedMid && <span className="text-[9px] text-amber-400/90 bg-amber-500/10 rounded px-1 ml-0.5">→ {statAboveNow ? "↑" : "↓"} now</span>}
                            </div>
                          )}
                          {trackerSnapshot.aboveKalshi !== null && (
                            <div className={`flex items-center gap-0.5 text-[10px] font-semibold ${trackerSnapshot.aboveKalshi ? "text-emerald-400/70" : "text-red-400/70"}`}>
                              {trackerSnapshot.aboveKalshi ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span className="text-violet-300/80">Claude</span>
                              {claudeFlippedMid && <span className="text-[9px] text-amber-400/90 bg-amber-500/10 rounded px-1 ml-0.5">→ {claudeAbove ? "↑" : "↓"} now</span>}
                            </div>
                          )}
                          {mlAboveAtOpen !== null && (
                            <div className={`flex items-center gap-0.5 text-[10px] font-semibold ${mlAboveAtOpen ? "text-emerald-400/70" : "text-red-400/70"}`}>
                              {mlAboveAtOpen ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span className="text-sky-300/80">ML</span>
                            </div>
                          )}
                          {(openingEnsembleAbove !== null || openingSplit) && (
                            <div className={`flex items-center gap-0.5 text-[10px] font-semibold ${openingSplit ? "text-amber-400/70" : openingEnsembleAbove ? "text-emerald-400/70" : "text-red-400/70"}`}>
                              {!openingSplit && (openingEnsembleAbove ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />)}
                              <span className="text-primary/70">Combined</span>
                              {openingSplit && <span className="text-[9px] text-amber-400/80 bg-amber-500/10 rounded px-1 ml-0.5">split</span>}
                              {ensembleFlippedMid && <span className="text-[9px] text-amber-400/90 bg-amber-500/10 rounded px-1 ml-0.5">→ {combinedHead!.above ? "↑" : "↓"} now</span>}
                            </div>
                          )}
                          {!anyFlipped && <span className="text-[10px] text-muted-foreground/50 italic">no change since open</span>}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </>
            );
          })()}

        </div>
      )}

      {/* Non-Kalshi coins with Claude — compact consensus strip */}
      {!kalshiAvailable && (isTrainingCoin || claudeActive) && (() => {
        const showPanel = consensusSignals.length > 0 || liveDirectionLoading;
        if (!showPanel) return null;
        const borderCls = allConsensusAgree && consensusSignals.length > 1
          ? "border-emerald-500/30" : consensusAgreement < consensusSignals.length && consensusSignals.length > 1
          ? "border-amber-500/30" : "border-border/30";
        const bgCls = allConsensusAgree && consensusSignals.length > 1
          ? "bg-emerald-500/5" : consensusAgreement < consensusSignals.length && consensusSignals.length > 1
          ? "bg-amber-500/5" : "bg-card/60";
        return (
          <div className={`rounded-xl border ${borderCls} ${bgCls} px-5 py-4`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-violet-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">AI Consensus</span>
                {consensusSignals.length > 1 && (
                  <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ring-1 ${allConsensusAgree ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30" : "bg-amber-500/15 text-amber-400 ring-amber-500/30"}`}>
                    {consensusAgreement}/{consensusSignals.length} agree
                  </span>
                )}
              </div>
              <button
                onClick={handleRefreshStat}
                disabled={statLoading}
                title="Force-refresh all models"
                className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded transition-all ${
                  statJustRefreshed
                    ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/30"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/30 border border-transparent"
                } disabled:opacity-40`}
              >
                {statJustRefreshed ? (
                  <><Check className="w-3.5 h-3.5" /> Refreshed</>
                ) : (
                  <><RefreshCw className={`w-3.5 h-3.5 ${statLoading ? "animate-spin" : ""}`} /> Refresh</>
                )}
              </button>
            </div>
            {consensusAbove !== null && consensusConf !== null ? (
              <div className={`flex items-center gap-2 mb-3 ${consensusAbove ? "text-emerald-400" : "text-red-400"}`}>
                {consensusAbove ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />}
                <span className="text-xl font-black">{consensusAbove ? "ABOVE" : "BELOW"}</span>
                <span className="text-base font-bold text-muted-foreground">{consensusConf}%</span>
              </div>
            ) : liveDirectionLoading ? (
              <div className="text-[11px] text-muted-foreground/50 flex items-center gap-1.5 mb-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Gathering signals…
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground/50 mb-3">Awaiting signals — data builds after window open</div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              {consensusSignals.map((sig) => (
                <div key={sig.name} className={`flex items-center gap-1 text-[11px] font-semibold ${sig.above ? "text-emerald-400" : "text-red-400"}`}>
                  {sig.above ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                  <span>{sig.name}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Quarter-Hour Forecasts — side-by-side model comparison ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-primary" /> Quarter-Hour Forecasts
            <span className="text-xs font-normal text-muted-foreground">— Statistical vs Claude AI at each {tz} mark</span>
          </h3>
          {aiLoading && (
            <span className="text-[11px] text-amber-400 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> {autoTriggerReason ?? "Analyzing…"}
            </span>
          )}
        </div>

        {/* ── Drift alert banner ─────────────────────────────────────────── */}
        {driftAlert && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold leading-snug">
                Model drift detected
              </div>
              <div className="text-[11px] text-amber-300/80 leading-snug mt-0.5">
                {driftAlert.lockedAbove !== null && driftAlert.claudeAbove !== null ? (
                  <>
                    Window opened calling{" "}
                    <span className={driftAlert.lockedAbove ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
                      {driftAlert.lockedAbove ? "ABOVE" : "BELOW"}
                    </span>
                    {" — Claude now says "}
                    <span className={driftAlert.claudeAbove ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
                      {driftAlert.claudeAbove ? "ABOVE" : "BELOW"}
                    </span>
                  </>
                ) : (
                  <>
                    Window opened calling{" "}
                    <span className="font-semibold">{driftAlert.lockedDirection.toUpperCase()}</span>
                    {" — Claude now says "}
                    <span className="font-semibold">{driftAlert.claudeDirection.toUpperCase()}</span>
                  </>
                )}
                {" · detected "}
                {driftAlert.detectedAt.toLocaleTimeString("en-US", {
                  hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
                })} ET
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {coin.predictions.map((statPred, i) => {
            const aiPred = aiEntry?.preds[i] ?? null;
            const statChangePct = livePrice > 0 ? ((statPred.predictedPrice - livePrice) / livePrice) * 100 : statPred.changePct;
            const aiChangePct = aiPred && livePrice > 0 ? ((aiPred.predictedPrice - livePrice) / livePrice) * 100 : 0;
            const statDir: "up" | "down" | "flat" = statChangePct > 0.05 ? "up" : statChangePct < -0.05 ? "down" : "flat";
            const aiDir: "up" | "down" | "flat" = aiPred ? (aiChangePct > 0.05 ? "up" : aiChangePct < -0.05 ? "down" : "flat") : "flat";
            // Per-window combined call — only when Claude has run and weights are
            // available; mirrors the server ensemble so the headline matches the
            // two columns below it.
            const combined: CombinedCall | null =
              aiPred && aiEntry?.ensembleWeights && livePrice > 0
                ? computeCombinedCall({
                    statPrice: statPred.predictedPrice,
                    statConf: statPred.confidence,
                    statDir,
                    aiPrice: aiPred.predictedPrice,
                    aiConf: aiPred.confidence,
                    aiDir,
                    weights: aiEntry.ensembleWeights,
                    abstainMinConf: aiEntry.abstainMinConf ?? 55,
                    livePrice,
                    kalshiTarget,
                  })
                : null;
            return (
              <Card key={statPred.target} data-testid={`prediction-${i}`} className="overflow-hidden border-border bg-card/60">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20">
                  <span className="text-sm font-bold tabular-nums">{statPred.label}</span>
                  <span className="text-[11px] text-muted-foreground">{tz} · in {statPred.minutesAhead} min</span>
                </div>
                {/* Combined call headline — regime-weighted blend with no-bet */}
                {combined && (
                  <div className="px-4 py-2 border-b border-border bg-primary/5 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-primary/50" /> Combined
                    </span>
                    {combined.abstained ? (
                      <span className="inline-flex items-center gap-1 text-xs font-black text-amber-400">
                        <Minus className="w-3.5 h-3.5" /> NO BET
                      </span>
                    ) : (
                      <span className="flex items-baseline gap-2 tabular-nums">
                        <span className={`inline-flex items-center gap-1 text-sm font-black ${combined.direction === "up" ? "text-emerald-400" : combined.direction === "down" ? "text-red-400" : "text-muted-foreground"}`}>
                          {combined.direction === "up" ? <TrendingUp className="w-3.5 h-3.5" /> : combined.direction === "down" ? <TrendingDown className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                          ${formatPrice(combined.predictedPrice)}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{combined.confidence}%</span>
                      </span>
                    )}
                  </div>
                )}
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
                            Click Enhance in the prediction panel<br />to run Claude analysis
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
        <p className="text-[11px] text-muted-foreground mt-3">
          60-min candles · RSI, MACD, Bollinger Bands, ATR · Prices update every 3 s · Not financial advice · {tz}
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
