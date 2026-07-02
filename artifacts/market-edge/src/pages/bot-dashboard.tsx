import { useState, useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign,
  BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus,
  Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders,
  ChevronLeft, ChevronRight, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

// ─── Mode presets ────────────────────────────────────────────────────────────
// Each entry is the subset of BotConfig that should be applied automatically
// when the user switches to that decision mode.  Settings not listed here are
// left untouched so the user's manual overrides survive a mode switch.
//
// Values are derived from historical bet analysis (139 settled classic bets):
//   stat ≥ 55 → 69% WR   stat ≥ 56 → 74% WR   stat 53-56 → 49% WR (!)
//
type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous";

type ModePreset = Partial<{
  // Signal quality gates
  minStatConfidence: number;
  minConfidence: number;
  regimePenalty: number;
  // Entry timing
  maxEntryMinutes: number;
  minRemainingMinutes: number;
  // Volume / direction controls
  maxBetsPerWindow: number;
  maxSameDirectionBets: number;
  enableDirectionCap: boolean;
  // Momentum / trend filter
  enableMomentumFilter: boolean;
  momentumWindowCount: number;
  // Exit
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number;
  // Circuit breaker
  maxConsecutiveLosses: number;
  circuitBreakerPauseWindows: number;
  // Border guard
  enableBorderGuard: boolean;
  borderProximityPct: number;
  borderLookbackBets: number;
  // Auto-tune
  enableAutoTuning: boolean;
  autoTuneWindowSize: number;
}>;

const MODE_PRESETS: Record<DecisionMode, ModePreset & { label: string; why: string }> = {
  // ── Classic ──────────────────────────────────────────────────────────────
  // Stat → Claude → ML cascade. Full pre-cost-cut configuration + data-derived
  // stat floor of 55 (69% WR) from 139-bet DB analysis.
  classic: {
    label: "Classic",
    why: "Stat → Claude → ML cascade. Hard stat floor at 55 filters the 49%-WR noise band; regime penalty blocks against-trend bets.",
    // Signal gates (data-derived)
    minStatConfidence:      55,
    minConfidence:          65,
    regimePenalty:          15,
    // Entry timing — no ceiling; skip when fewer than 2 min remain
    maxEntryMinutes:        0,
    minRemainingMinutes:    2,
    // Volume
    maxBetsPerWindow:       3,
    maxSameDirectionBets:   3,
    enableDirectionCap:     true,
    // Momentum / trend
    enableMomentumFilter:   true,
    momentumWindowCount:    3,
    // Exit
    midExitSensitivity:     "balanced",
    phase2ThresholdPp:      30,
    // Circuit breaker disabled — auto-tune handles pausing underperformers
    maxConsecutiveLosses:   0,
    circuitBreakerPauseWindows: 2,
    // Border guard off (proximity hasn't been a reliable gate)
    enableBorderGuard:      false,
    borderProximityPct:     0.1,
    borderLookbackBets:     3,
    // Auto-tune on with 100-bet rolling window
    enableAutoTuning:       true,
    autoTuneWindowSize:     100,
  },

  // ── ML Gate ──────────────────────────────────────────────────────────────
  // Stat+Claude decide direction; ML vetos if it disagrees.
  // Full pre-cost-cut parameter set — all settings restored to what was in
  // place before the cost-reduction changes (reduced thinking budget, quiet-
  // hours snap-off, live-dir TTL). Those changes are now in the AI intensity
  // tiers (Eco / Balanced / Max) so the bot config is unaffected.
  //
  // NOTE: the old 45s time-based warmup was replaced with a smarter
  // target-detection gate (confirms the Kalshi strike before allowing entry)
  // which fires earlier and is more reliable. That gate is always active
  // regardless of mode — no extra entry delay needed here.
  ml_gate: {
    label: "ML Gate",
    why: "Stat+Claude pick direction; ML vetos if it disagrees. ML veto already filters weak-stat calls so the stat floor is slightly relaxed.",
    // Signal gates — slightly relaxed because ML veto adds a second safety layer
    minStatConfidence:      52,
    minConfidence:          63,
    regimePenalty:          10,
    // Entry timing — no ceiling; skip when fewer than 2 min remain
    maxEntryMinutes:        0,
    minRemainingMinutes:    2,
    // Volume — conservative; ML veto already limits entries naturally
    maxBetsPerWindow:       3,
    maxSameDirectionBets:   3,
    enableDirectionCap:     true,
    // Momentum / trend
    enableMomentumFilter:   true,
    momentumWindowCount:    3,
    // Exit — balanced exit; ML veto means we're more confident on entry
    midExitSensitivity:     "balanced",
    phase2ThresholdPp:      30,
    // Circuit breaker: 5 consecutive losses → pause 2 windows
    maxConsecutiveLosses:   5,
    circuitBreakerPauseWindows: 2,
    // Border guard off
    enableBorderGuard:      false,
    borderProximityPct:     0.1,
    borderLookbackBets:     3,
    // Auto-tune on
    enableAutoTuning:       true,
    autoTuneWindowSize:     100,
  },

  // ── Consensus ────────────────────────────────────────────────────────────
  // ≥2 of 3 signals (Stat, Claude, ML) must agree on direction.
  consensus: {
    label: "Consensus",
    why: "≥2 of 3 signals must agree — multi-signal agreement is its own quality gate so individual floors are relaxed.",
    // Signal gates — relaxed because consensus already filters noise
    minStatConfidence:      50,
    minConfidence:          60,
    regimePenalty:          8,
    // Entry timing
    maxEntryMinutes:        0,
    minRemainingMinutes:    2,
    // Volume — 4 slots since entries are already selective
    maxBetsPerWindow:       4,
    maxSameDirectionBets:   4,
    enableDirectionCap:     true,
    // Momentum / trend
    enableMomentumFilter:   true,
    momentumWindowCount:    3,
    // Exit
    midExitSensitivity:     "balanced",
    phase2ThresholdPp:      30,
    // Circuit breaker
    maxConsecutiveLosses:   5,
    circuitBreakerPauseWindows: 2,
    // Border guard off
    enableBorderGuard:      false,
    borderProximityPct:     0.1,
    borderLookbackBets:     3,
    // Auto-tune on
    enableAutoTuning:       true,
    autoTuneWindowSize:     100,
  },

  // ── Unanimous ────────────────────────────────────────────────────────────
  // All 3 signals must agree — highest conviction, fewest bets.
  unanimous: {
    label: "Unanimous",
    why: "All 3 signals must agree — the strictest entry bar. Confidence floors are relaxed since unanimity already guarantees conviction; more slots because entries are rare.",
    // Signal gates — very relaxed; 3-signal unanimity is already very strict
    minStatConfidence:      50,
    minConfidence:          55,
    regimePenalty:          5,
    // Entry timing
    maxEntryMinutes:        0,
    minRemainingMinutes:    2,
    // Volume — 5 slots since entries are rare; direction cap still protects
    maxBetsPerWindow:       5,
    maxSameDirectionBets:   5,
    enableDirectionCap:     true,
    // Momentum — 2-window lookback (less strict; 3-signal agreement overrides trend)
    enableMomentumFilter:   true,
    momentumWindowCount:    2,
    // Exit
    midExitSensitivity:     "balanced",
    phase2ThresholdPp:      30,
    // Circuit breaker: very conservative — unanimous bets should rarely lose
    maxConsecutiveLosses:   3,
    circuitBreakerPauseWindows: 3,
    // Border guard off
    enableBorderGuard:      false,
    borderProximityPct:     0.1,
    borderLookbackBets:     3,
    // Auto-tune on
    enableAutoTuning:       true,
    autoTuneWindowSize:     100,
  },
};

interface BotConfig {
  betSize: number;
  dailyLossLimit: number;
  signalThreshold: number;
  minConfidence: number;
  decisionMode: DecisionMode;
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number;
  maxEntryMinutes: number;
  minRemainingMinutes: number;
  maxBetsPerWindow: number;
  enabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxConsecutiveLosses: number;
  circuitBreakerPauseWindows: number;
  enableDirectionCap: boolean;
  maxSameDirectionBets: number;
  enableMomentumFilter: boolean;
  momentumWindowCount: number;
  enableAutoTuning: boolean;
  autoTuneWindowSize: number;
  enableBorderGuard: boolean;
  borderProximityPct: number;
  borderLookbackBets: number;
  regimePenalty: number;
  aiPaused: boolean;
  paperStartingBalance: number;
  paperWinReturnRate: number;
  paperBalanceResetAt: string | null;
  minStatConfidence: number;
}

interface LogicModeStats {
  mode: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  avgConfidence: number | null;
}

interface BacktestModeStats {
  mode: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  coverage: number;
}

interface OpenPosition {
  id: string; symbol: string; windowKey: string; ticker: string;
  direction: "yes" | "no"; entryYesPrice: number; contractCount: number;
  betAmount: number; kalshiTarget: number; openedAt: number;
  cryptoPriceAtEntry: number | null;
  currentYesPrice: number | null;
  unrealizedPnl: number | null;
  guardStates: GuardStates | null;
  guardReason: string | null;
}

interface GuardStates {
  holdDurationMet?: boolean; flipConfirmed?: boolean;
  erSupports?: boolean; timingSupports?: boolean; phase2Active?: boolean;
  [key: string]: boolean | undefined;
}

interface BotStatus {
  mode: "paper" | "live"; status: string; paused: boolean;
  config: BotConfig; openPositions: OpenPosition[];
  dailyPnl: number; overallPnl: number | null; accountBalance: number | null;
  warmupSecondsRemaining: number | null; configured: boolean;
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  isInQuietHours: boolean;
  mlStatus?: {
    ready: boolean; readyCount: number; totalCount: number;
    minWindows: number; minRequired: number;
  };
}

interface HistoryRecord {
  id: string; symbol: string; windowKey: string; ticker: string | null;
  direction: string | null; action: string; mode: string;
  signals: Record<string, unknown> | null;
  entryPrice: string | null; exitPrice: string | null;
  contractCount: number | null; betAmount: string | null;
  pnl: string | null; exitReason: string | null;
  phase2Activated: boolean | null; outcome: string | null;
  kalshiTarget: string | null;
  cryptoPriceAtEntry: string | null; cryptoPriceAtExit: string | null;
  createdAt: string; exitedAt: string | null;
  decisionMode: string | null;
}

interface WindowEval {
  symbol: string; action: "BET_YES" | "BET_NO" | "SKIP";
  confidence: number; score: number; reason: string;
  windowKey: string; selected: boolean; evaluatedAt: string;
  trendStability: "clean" | "choppy" | "reversing" | null;
  regime: "trending_up" | "trending_down" | "ranging" | null;
}

interface BotStats {
  totalBets: number; wins: number; losses: number; totalPnl: number;
  paperBets: number; liveBets: number;
  bySymbol: Array<{ symbol: string; bets: number; wins: number; losses: number; pnl: number }>;
}

interface SymbolStats {
  wins: number; losses: number; betCount: number; winRate: number | null;
  currentConsecutiveLosses: number;
}

interface HourBandStats {
  band: string; wins: number; losses: number; betCount: number; winRate: number | null;
}

interface DirectionStats {
  wins: number; losses: number; betCount: number; winRate: number | null;
}

interface ConfidenceBandStats {
  band: string; lowerBound: number;
  wins: number; losses: number; betCount: number; winRate: number | null;
}

interface AgreementLevelStats {
  level: string; agreeing: number; total: number;
  wins: number; losses: number; betCount: number; winRate: number | null;
}

interface DayOfWeekStats {
  day: number; dayName: string;
  wins: number; losses: number; betCount: number; winRate: number | null;
}
interface HourOfDayStats {
  hour: number;
  wins: number; losses: number; betCount: number; winRate: number | null;
}
interface PerformanceReport {
  totalBets: number; wins: number; losses: number;
  overallWinRate: number | null;
  last10WinRate: number | null;
  last30WinRate: number | null;
  last24hWinRate: number | null;
  bySymbol: Record<string, SymbolStats>;
  byHourBand: Record<string, HourBandStats>;
  byDirection: { yes: DirectionStats; no: DirectionStats };
  byConfidenceBand: Record<string, ConfidenceBandStats>;
  byAgreementLevel: Record<string, AgreementLevelStats>;
  byDayOfWeek: Record<string, DayOfWeekStats>;
  byHourOfDay: Record<string, HourOfDayStats>;
  optimalConfidenceThreshold: number | null;
  avgConfidenceWinners: number | null; avgConfidenceLosers: number | null;
  exitReasonBreakdown: Record<string, number>;
  circuitBreakerTriggers: number;
  recommendations: string[];
  computedAt: string;
}

interface AutoTuneLogEntry {
  id: number; createdAt: string;
  ruleName: string; oldValue: string | null; newValue: string | null;
  triggerReason: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmt$ = (n: number | string | null | undefined, decimals = 2) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

const fmtPct = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : `${(v * 100).toFixed(0)}¢`;
};

const fmtCrypto = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "—";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const fmtDuration = (start: string | null, end: string | null) => {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
};

const GUARD_LABELS: Record<string, string> = {
  holdDurationMet: "Hold", flipConfirmed: "Flip",
  erSupports: "ER", timingSupports: "Timing", phase2Active: "Phase2",
  mlFlipped: "ML",
};

// EST ↔ UTC helpers (EST = UTC − 5; no DST adjustment — bot config uses fixed offset)
const utcToEst = (h: number) => (h - 5 + 24) % 24;
const estToUtc = (h: number) => (h + 5) % 24;

// ─── Main Component ──────────────────────────────────────────────────────────

export default function BotDashboard() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(true);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<Partial<BotConfig>>({});
  const [saving, setSaving] = useState(false);
  const [persistMsg, setPersistMsg] = useState<"saved" | "failed" | null>(null);
  const [presetApplied, setPresetApplied] = useState<DecisionMode | null>(null);
  const [modeResetMsg, setModeResetMsg] = useState<DecisionMode | null>(null);
  const [perfOpen, setPerfOpen] = useState(true);
  const [tuneLogOpen, setTuneLogOpen] = useState(true);
  const [histPage, setHistPage] = useState(0);

  // ── Data fetching ────────────────────────────────────────────────────────
  const { data: status, isLoading } = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/status`).then(r => r.json()),
    refetchInterval: 5_000,
  });

  // ── Sync draft with backend ───────────────────────────────────────────────
  // When the backend config changes (e.g. server restart resets to defaults),
  // clear any stale local draft so the UI always reflects reality.
  const prevCfgRef = useRef<BotConfig | undefined>(undefined);
  useEffect(() => {
    const cfg = status?.config;
    if (!cfg) return;
    const prev = prevCfgRef.current;
    if (prev && JSON.stringify(prev) !== JSON.stringify(cfg)) {
      setConfigDraft({});
    }
    prevCfgRef.current = cfg;
  }, [status?.config]);

  const { data: historyData } = useQuery<{ history: HistoryRecord[] }>({
    queryKey: ["bot-all-history"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/all-history?limit=500`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  const { data: statsData } = useQuery<BotStats>({
    queryKey: ["bot-stats"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/stats`).then(r => r.json()),
    refetchInterval: 30_000,
  });

  const { data: evalData } = useQuery<{ evaluation: WindowEval[] }>({
    queryKey: ["bot-window-eval"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/window-eval`).then(r => r.json()),
    refetchInterval: 30_000,
  });

  const { data: perfReportData } = useQuery<{ report: PerformanceReport | null; pausedCoins: Record<string, number> }>({
    queryKey: ["bot-performance-report"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/performance-report`).then(r => r.json()),
    refetchInterval: 5 * 60_000,
  });

  const { data: autoTuneLogData } = useQuery<{ entries: AutoTuneLogEntry[] }>({
    queryKey: ["bot-auto-tune-log"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/auto-tune-log`).then(r => r.json()),
    refetchInterval: 60_000,
  });

  const { data: logicPerfData } = useQuery<{ modes: LogicModeStats[] }>({
    queryKey: ["bot-logic-performance"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/logic-performance`).then(r => r.json()),
    refetchInterval: 5 * 60_000,
  });

  const { data: backtestData } = useQuery<{ modes: BacktestModeStats[] }>({
    queryKey: ["bot-backtest-modes"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/backtest-modes`).then(r => r.json()),
    refetchInterval: 10 * 60_000,
  });

  const [btPerfTab, setBtPerfTab] = useState<"live" | "backtest">("live");

  // ── Mutations ────────────────────────────────────────────────────────────
  async function authPost(path: string, body: object) {
    const token = await getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    await qc.invalidateQueries({ queryKey: ["bot-status"] });
    return res.json();
  }

  async function togglePause() {
    await authPost("/crypto/bot/pause", { paused: !status?.paused });
  }

  async function setMode(mode: "paper" | "live") {
    await authPost("/crypto/bot/mode", { mode });
    setConfirmLive(false);
  }

  async function softReset() {
    await authPost("/crypto/bot/bets/soft-reset", {});
    await qc.invalidateQueries({ queryKey: ["bot-history"] });
    await qc.invalidateQueries({ queryKey: ["bot-stats"] });
    await qc.invalidateQueries({ queryKey: ["bot-eval"] });
    await qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
    setConfirmReset(false);
    setResetMsg("Visual stats cleared — all bet data preserved");
    setTimeout(() => setResetMsg(null), 4000);
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const result = await authPost("/crypto/bot/config", configDraft) as { ok: boolean; persisted: boolean; modeReset?: boolean };
      await qc.invalidateQueries({ queryKey: ["bot-status"] });
      await qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
      setConfigDraft({});
      setPersistMsg(result.persisted ? "saved" : "failed");
      setTimeout(() => setPersistMsg(null), 3000);
      if (result.modeReset) {
        const newMode = (configDraft.decisionMode ?? "classic") as DecisionMode;
        setModeResetMsg(newMode);
        setTimeout(() => setModeResetMsg(null), 6000);
      }
    } finally {
      setSaving(false);
    }
  }

  // ── Derived state ────────────────────────────────────────────────────────
  const cfg = status?.config;
  const merged = { ...cfg, ...configDraft } as BotConfig;
  const hasDraft = Object.keys(configDraft).length > 0;
  const history = historyData?.history ?? [];
  const bets = history.filter(r => r.action === "bet" || r.action === "exit" || r.action === "late_recovery_exit" || r.action === "expired");

  const HIST_PAGE_SIZE = 20;
  const totalHistPages = Math.max(1, Math.ceil(bets.length / HIST_PAGE_SIZE));
  const clampedHistPage = Math.min(histPage, totalHistPages - 1);
  const pagedBets = bets.slice(clampedHistPage * HIST_PAGE_SIZE, (clampedHistPage + 1) * HIST_PAGE_SIZE);
  const evaluation = evalData?.evaluation ?? [];
  const stats = statsData;
  const openPosList = status?.openPositions ?? [];
  const pnl = status?.overallPnl ?? 0;
  const winRate = (stats?.totalBets ?? 0) > 0 ? Math.round((stats!.wins / stats!.totalBets) * 100) : 0;

  const statusLabel = () => {
    if (!status) return "Loading…";
    if (!cfg?.enabled) return "Disabled";
    if (status.paused) return "Paused";
    if (status.warmupSecondsRemaining !== null) return `Warming up · ${status.warmupSecondsRemaining}s`;
    if (status.openPositions.length > 0) return status.openPositions.length === 1 ? "Position Open" : `${status.openPositions.length} Positions Open`;
    if (status.status === "daily_limit_hit") return "Daily Limit Hit";
    return "Watching Markets";
  };

  const tuneEntries = autoTuneLogData?.entries ?? [];
  const tuneCount = tuneEntries.length;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentTuneEntry = tuneEntries.find(e => new Date(e.createdAt).getTime() > oneHourAgo) ?? null;
  const pausedCoins = perfReportData?.pausedCoins ?? {};

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading bot dashboard…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-background">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Bot className="w-6 h-6 text-cyan-400" />
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground">Kalshi Bot Dashboard</h1>
            <p className="text-xs text-muted-foreground">Automated prediction market engine</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold px-2 py-1 rounded-full border ${status?.mode === "live" ? "border-red-500/50 bg-red-500/10 text-red-400" : "border-yellow-500/50 bg-yellow-500/10 text-yellow-400"}`}>
            {status?.mode?.toUpperCase() ?? "PAPER"}
          </span>
          <span className={`text-xs px-2 py-1 rounded-full ${status?.paused ? "bg-muted text-muted-foreground" : openPosList.length > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-sky-500/10 text-sky-400"}`}>
            {statusLabel()}
          </span>
          {(status?.circuitBreakerWindowsRemaining ?? 0) > 0 ? (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-500/30" title={`Circuit breaker active — ${status!.circuitBreakerWindowsRemaining} window(s) remaining`}>
              <AlertTriangle className="w-3 h-3" />
              CB {status!.circuitBreakerWindowsRemaining}w
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground border border-border" title="Circuit breaker inactive">
              <AlertTriangle className="w-3 h-3" />
              CB off
            </span>
          )}
          {status?.isInQuietHours && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground border border-border" title={`Quiet hours active (${String(utcToEst(cfg?.quietHoursStart ?? 0)).padStart(2,"0")}:00–${String(utcToEst(cfg?.quietHoursEnd ?? 0)).padStart(2,"0")}:00 EST) — no new entries`}>
              <Clock className="w-3 h-3" />
              Quiet
            </span>
          )}
          {recentTuneEntry && (() => {
            const ruleLabel =
              recentTuneEntry.ruleName === "confidence_floor_raise" ? "Confidence raised" :
              recentTuneEntry.ruleName === "per_coin_pause" ? "Coin paused" :
              recentTuneEntry.ruleName === "quiet_hours_expand" ? "Quiet hrs expanded" :
              recentTuneEntry.ruleName;
            const minutesAgo = Math.round((Date.now() - new Date(recentTuneEntry.createdAt).getTime()) / 60000);
            return (
              <span
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30 animate-pulse"
                title={`Auto-tune fired ${minutesAgo}m ago: ${recentTuneEntry.triggerReason}`}
              >
                <Sliders className="w-3 h-3" />
                {ruleLabel} · {minutesAgo}m ago
              </span>
            );
          })()}
          <Button size="sm" variant="outline" onClick={togglePause} className="h-7 gap-1">
            {status?.paused ? <><Play className="w-3 h-3" />Resume</> : <><Pause className="w-3 h-3" />Pause</>}
          </Button>
          {status?.mode === "paper" ? (
            confirmLive ? (
              <div className="flex gap-1">
                <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => setMode("live")}>Confirm Live</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setConfirmLive(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="h-7 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => setConfirmLive(true)}>Go Live</Button>
            )
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setMode("paper")}>Paper Mode</Button>
          )}
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">

        {/* ── Stats Row ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Performance Since Reset</span>
            <div className="flex items-center gap-2">
              {resetMsg && (
                <span className="text-xs text-emerald-400 font-medium">{resetMsg}</span>
              )}
              {confirmReset ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground mr-1">Archive all visual stats?</span>
                  <Button size="sm" variant="destructive" className="h-6 text-xs px-2" onClick={() => void softReset()}>Confirm</Button>
                  <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => setConfirmReset(false)}>Cancel</Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs gap-1 text-muted-foreground hover:text-foreground"
                  title="Hides all current bets from display so you can measure performance from a clean slate. No data is deleted — the bot, auto-tune, and ML model still see everything."
                  onClick={() => setConfirmReset(true)}
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset Visual Stats
                </Button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Account Balance", value: fmt$(status?.accountBalance), icon: DollarSign, color: "text-sky-400" },
              { label: "Overall P&L", value: fmt$(pnl), icon: pnl >= 0 ? TrendingUp : TrendingDown, color: pnl >= 0 ? "text-emerald-400" : "text-red-400", bold: true },
              { label: "Win Rate", value: `${winRate}%`, icon: Trophy, color: "text-violet-400" },
              { label: "Total Bets", value: `${stats?.totalBets ?? 0}`, sub: `${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`, icon: BarChart3, color: "text-amber-400" },
            ].map(({ label, value, sub, icon: Icon, color, bold }) => (
              <div key={label} className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${color}`} />
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
                <div className={`text-xl font-bold ${bold ? (pnl >= 0 ? "text-emerald-400" : "text-red-400") : "text-foreground"}`}>{value}</div>
                {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* ── Paused Coins Banner ── */}
        {Object.keys(pausedCoins).length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm flex-shrink-0">
              <Pause className="w-4 h-4" />
              Auto-paused coins
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(pausedCoins).map(([sym, windowsRemaining]) => (
                <span
                  key={sym}
                  className="flex items-center gap-1 text-xs font-medium pl-2.5 pr-1.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  title={`${sym} is paused by auto-tune for ${windowsRemaining} more window(s)`}
                >
                  {sym}
                  <span className="font-mono text-amber-400/70">· {windowsRemaining}w left</span>
                  <button
                    type="button"
                    title={`Unpause ${sym}`}
                    onClick={async () => {
                      await fetch(`${API_BASE}/crypto/bot/coins/paused/${sym}`, { method: "DELETE" });
                      await qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
                      await qc.invalidateQueries({ queryKey: ["bot-status"] });
                    }}
                    className="ml-0.5 flex items-center justify-center w-4 h-4 rounded-full hover:bg-amber-400/30 text-amber-400/70 hover:text-amber-200 transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={async () => {
                await authPost("/crypto/bot/coins/unpause-all", {});
                await qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
                await qc.invalidateQueries({ queryKey: ["bot-status"] });
              }}
              className="ml-auto text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 text-amber-300 border border-amber-500/40 transition-colors"
            >
              Unpause All
            </button>
          </div>
        )}

        {/* ── Active Positions ── */}
        {openPosList.length > 0 && (
          <div className="space-y-3">
            {openPosList.length > 1 && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-sm font-semibold text-foreground">Active Positions</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-mono">{openPosList.length}</span>
              </div>
            )}
            {openPosList.map((pos) => (
              <div key={pos.id} className={`border rounded-xl p-5 ${pos.direction === "yes" ? "border-emerald-500/40 bg-emerald-950/20" : "border-red-500/40 bg-red-950/20"}`}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`text-2xl font-black ${pos.direction === "yes" ? "text-emerald-400" : "text-red-400"}`}>
                      {pos.symbol}
                    </div>
                    <span className={`text-sm font-bold px-3 py-1 rounded-full ${pos.direction === "yes" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                      {pos.direction === "yes" ? "▲ YES" : "▼ NO"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Opened {new Date(pos.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Unrealized P&L</div>
                    <div className={`text-lg font-bold ${(pos.unrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {fmt$(pos.unrealizedPnl)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 text-sm mb-4">
                  {[
                    { label: "Strike Price", value: fmtCrypto(pos.kalshiTarget) },
                    { label: "Crypto @ Entry", value: fmtCrypto(pos.cryptoPriceAtEntry) },
                    { label: "Entry Yes%", value: fmtPct(pos.entryYesPrice) },
                    { label: "Entry No%", value: fmtPct(1 - pos.entryYesPrice) },
                    { label: "Current Yes%", value: fmtPct(pos.currentYesPrice) },
                    { label: "Current No%", value: pos.currentYesPrice != null ? fmtPct(1 - pos.currentYesPrice) : "—" },
                    { label: "Contracts", value: String(pos.contractCount) },
                    { label: "Bet Size", value: fmt$(pos.betAmount) },
                    { label: "Ticker", value: pos.ticker },
                    { label: "Window", value: pos.windowKey.slice(11) },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-background/30 rounded-lg p-2.5">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</div>
                      <div className="font-semibold text-foreground text-sm">{value}</div>
                    </div>
                  ))}
                </div>

                {pos.guardStates && (
                  <div className="flex flex-wrap gap-2">
                    <span className="text-xs text-muted-foreground self-center">Exit guards:</span>
                    {Object.entries(pos.guardStates).map(([key, val]) => (
                      <span key={key} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full ${val ? "bg-emerald-500/15 text-emerald-400" : "bg-muted/50 text-muted-foreground"}`}>
                        {val ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                        {GUARD_LABELS[key] ?? key}
                      </span>
                    ))}
                    {pos.guardReason && (
                      <span className="text-xs text-muted-foreground italic self-center">· {pos.guardReason}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Window Evaluation ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-sm">Market Selection — This Window</h2>
            {evaluation.length > 0 && (
              <span className="text-xs text-muted-foreground ml-auto">
                {evaluation[0]?.windowKey?.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
          {evaluation.length === 0 ? (
            <div className="px-5 py-8 text-center text-muted-foreground text-sm">
              Waiting for next bot tick (every 30s)…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                    <th className="px-5 py-2">Coin</th>
                    <th className="px-3 py-2">Decision</th>
                    <th className="px-3 py-2">Confidence</th>
                    <th className="px-3 py-2">Score</th>
                    <th className="px-3 py-2">Trend</th>
                    <th className="px-3 py-2">Regime</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">Selected</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluation.map((e) => (
                    <tr key={e.symbol} className={`border-b border-border/50 ${e.selected ? "bg-amber-500/5" : ""}`}>
                      <td className="px-5 py-2.5 font-bold">{e.symbol}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          e.action === "BET_YES" ? "bg-emerald-500/15 text-emerald-400" :
                          e.action === "BET_NO" ? "bg-red-500/15 text-red-400" :
                          "bg-muted text-muted-foreground"
                        }`}>
                          {e.action.replace("BET_", "")}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {e.action !== "SKIP" ? <span className="font-mono">{e.confidence.toFixed(0)}%</span> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.action !== "SKIP" ? <span className="font-mono">{e.score.toFixed(2)}</span> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.trendStability ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            e.trendStability === "clean" ? "bg-emerald-500/15 text-emerald-400" :
                            e.trendStability === "reversing" ? "bg-red-500/15 text-red-400" :
                            "bg-amber-500/15 text-amber-400"
                          }`}>
                            {e.trendStability}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.regime ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            e.regime === "trending_up" ? "bg-sky-500/15 text-sky-400" :
                            e.regime === "trending_down" ? "bg-orange-500/15 text-orange-400" :
                            "bg-zinc-500/15 text-zinc-400"
                          }`}>
                            {e.regime === "trending_up" ? "↑ trending" :
                             e.regime === "trending_down" ? "↓ trending" :
                             "↔ ranging"}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">{e.reason}</td>
                      <td className="px-3 py-2.5">
                        {e.selected ? <Star className="w-4 h-4 text-amber-400 fill-amber-400" /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Config Settings ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setConfigOpen(o => !o)}
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Bot Configuration</h2>
            {hasDraft && <span className="text-xs text-amber-400 font-medium ml-1">· unsaved changes</span>}
            <span className="ml-auto text-muted-foreground">{configOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
          </button>

          {configOpen && cfg && (
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {/* Bet Size */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Bet Size ($)</span>
                  <input type="number" min={0.5} max={25} step={0.5}
                    className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.betSize ?? 0.5}
                    onChange={e => setConfigDraft(d => ({ ...d, betSize: parseFloat(e.target.value) }))} />
                </label>

                {/* Daily Loss Limit */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Daily Loss Limit ($)</span>
                  <input type="number" min={1} max={500} step={1}
                    className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.dailyLossLimit ?? 20}
                    onChange={e => setConfigDraft(d => ({ ...d, dailyLossLimit: parseFloat(e.target.value) }))} />
                </label>

                {/* Min Signals */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Signals Agreeing</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.signalThreshold ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, signalThreshold: parseInt(e.target.value) }))}>
                    <option value={2}>2 of 4</option>
                    <option value={3}>3 of 4</option>
                    <option value={4}>4 of 4</option>
                  </select>
                </label>

                {/* Min Confidence */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Confidence ({merged.minConfidence ?? 60}%)</span>
                  <input type="range" min={40} max={90} step={5}
                    className="mt-1"
                    value={merged.minConfidence ?? 60}
                    onChange={e => setConfigDraft(d => ({ ...d, minConfidence: parseInt(e.target.value) }))} />
                </label>

                {/* Min Stat Confidence */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Min Stat Confidence ({merged.minStatConfidence ?? 55}%)
                    <span className="ml-1 text-amber-400/70">· data-derived floor</span>
                  </span>
                  <input type="range" min={0} max={70} step={1}
                    className="mt-1"
                    value={merged.minStatConfidence ?? 55}
                    onChange={e => setConfigDraft(d => ({ ...d, minStatConfidence: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">
                    0 = disabled · 55 = 69% WR · 56 = 74% WR (based on {139} settled bets)
                  </span>
                </label>

                {/* Decision Mode — full-width row */}
                <div className="col-span-2 flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">Decision Logic</span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {(Object.entries(MODE_PRESETS) as [DecisionMode, typeof MODE_PRESETS[DecisionMode]][]).map(([id, preset]) => {
                      const isSelected = (merged.decisionMode ?? "classic") === id;
                      const needsML = id === "ml_gate" || id === "unanimous";
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            const { label: _l, why: _w, ...presetFields } = preset;
                            setConfigDraft(d => ({ ...d, decisionMode: id, ...presetFields }));
                            setPresetApplied(id);
                            setTimeout(() => setPresetApplied(null), 4000);
                          }}
                          className={`text-left rounded-xl p-3 border transition-all ${
                            isSelected
                              ? "border-sky-500/60 bg-sky-500/10 ring-1 ring-sky-500/30"
                              : "border-border bg-background/30 hover:border-border/80 hover:bg-muted/30"
                          }`}
                        >
                          <div className={`text-xs font-semibold mb-1 ${isSelected ? "text-sky-400" : "text-foreground"}`}>
                            {preset.label}
                            {isSelected && <span className="ml-1.5 text-[9px] text-sky-400/70">✓ active</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground/80 leading-tight">
                            {preset.why.split(".")[0]}.
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            <span className="text-[9px] px-1 py-0.5 rounded bg-muted/40 text-muted-foreground/70">
                              conf ≥{preset.minConfidence}%
                            </span>
                            <span className="text-[9px] px-1 py-0.5 rounded bg-muted/40 text-muted-foreground/70">
                              stat ≥{preset.minStatConfidence}%
                            </span>
                            <span className="text-[9px] px-1 py-0.5 rounded bg-muted/40 text-muted-foreground/70">
                              {preset.maxBetsPerWindow} slots
                            </span>
                          </div>
                          {needsML && (
                            <div className={`mt-1.5 text-[9px] font-medium px-1.5 py-0.5 rounded inline-block ${
                              status?.mlStatus?.ready
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-amber-500/15 text-amber-400"
                            }`}>
                              ML {status?.mlStatus?.ready ? "ready" : "warming up…"}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Preset-applied flash */}
                  {presetApplied && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
                      <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
                      <div>
                        <p className="text-xs font-medium text-sky-300">
                          {MODE_PRESETS[presetApplied].label} preset applied
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground/80 leading-snug">
                          {MODE_PRESETS[presetApplied].why}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground/60">
                          You can still adjust any setting below — changes are saved when you click Save.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Exit Sensitivity */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Exit Sensitivity</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.midExitSensitivity ?? "balanced"}
                    onChange={e => setConfigDraft(d => ({ ...d, midExitSensitivity: e.target.value as BotConfig["midExitSensitivity"] }))}>
                    <option value="conservative">Conservative</option>
                    <option value="balanced">Balanced</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </label>

                {/* Phase 2 Threshold */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Phase 2 Threshold ({merged.phase2ThresholdPp ?? 30}¢)</span>
                  <input type="range" min={10} max={50} step={5}
                    className="mt-1"
                    value={merged.phase2ThresholdPp ?? 30}
                    onChange={e => setConfigDraft(d => ({ ...d, phase2ThresholdPp: parseInt(e.target.value) }))} />
                </label>

                {/* Max Entry Time */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Latest Entry into Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxEntryMinutes ?? 11}
                    onChange={e => setConfigDraft(d => ({ ...d, maxEntryMinutes: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled (no ceiling)</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                      <option key={m} value={m}>{m} min in ({15 - m} min left)</option>
                    ))}
                  </select>
                </label>

                {/* Min Time Remaining */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Time Remaining</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minRemainingMinutes ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, minRemainingMinutes: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled (no floor)</option>
                    {[1, 2, 3, 4, 5, 6, 7].map(m => (
                      <option key={m} value={m}>Don&apos;t enter with &lt;{m} min left</option>
                    ))}
                  </select>
                </label>

                {/* Max Bets Per Window */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Bets / Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxBetsPerWindow ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxBetsPerWindow: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Quiet Hours Start */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Quiet Hours Start (EST)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={utcToEst(merged.quietHoursStart ?? 0)}
                    onChange={e => setConfigDraft(d => ({ ...d, quietHoursStart: estToUtc(parseInt(e.target.value)) }))}>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, "0")}:00 EST</option>
                    ))}
                  </select>
                </label>

                {/* Quiet Hours End */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Quiet Hours End (EST) — set equal to start to disable</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={utcToEst(merged.quietHoursEnd ?? 0)}
                    onChange={e => setConfigDraft(d => ({ ...d, quietHoursEnd: estToUtc(parseInt(e.target.value)) }))}>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, "0")}:00 EST{i === utcToEst(merged.quietHoursStart ?? 0) ? " (disabled)" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Max Consecutive Losses */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Circuit Breaker Trigger (losses)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxConsecutiveLosses ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxConsecutiveLosses: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} consecutive loss{n > 1 ? "es" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Circuit Breaker Pause Windows */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Circuit Breaker Pause (windows)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.circuitBreakerPauseWindows ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, circuitBreakerPauseWindows: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                      <option key={n} value={n}>Pause {n} window{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Direction Cap Enable */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Directional Balance Filter</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableDirectionCap: !(merged.enableDirectionCap ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableDirectionCap ?? true) ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableDirectionCap ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableDirectionCap ?? true) ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {(merged.enableDirectionCap ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* Max Same-Direction Bets */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Same-Direction Bets / Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxSameDirectionBets ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxSameDirectionBets: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Momentum Filter Enable */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Momentum Override Filter</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableMomentumFilter: !(merged.enableMomentumFilter ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableMomentumFilter ?? true) ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableMomentumFilter ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableMomentumFilter ?? true) ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {(merged.enableMomentumFilter ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* Momentum Window Count */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Momentum Windows Required</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.momentumWindowCount ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, momentumWindowCount: parseInt(e.target.value) }))}>
                    {[2, 3, 4, 5, 6, 7, 8].map(n => (
                      <option key={n} value={n}>{n} consecutive windows</option>
                    ))}
                  </select>
                </label>

                {/* Border Proximity Guard */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Border Proximity Guard</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableBorderGuard: !(merged.enableBorderGuard ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableBorderGuard ?? true) ? "bg-amber-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableBorderGuard ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableBorderGuard ?? true) ? "text-amber-400" : "text-muted-foreground"}`}>
                      {(merged.enableBorderGuard ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
                    Skips bets when price has been hovering within X% of the strike in recent settled windows.
                  </span>
                </label>

                {/* Border Proximity Threshold */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Proximity Threshold — {((merged.borderProximityPct ?? 0.3)).toFixed(2)}% of strike
                  </span>
                  <input
                    type="range" min={0.05} max={1.0} step={0.05}
                    value={merged.borderProximityPct ?? 0.3}
                    onChange={e => setConfigDraft(d => ({ ...d, borderProximityPct: parseFloat(e.target.value) }))}
                    className="w-full accent-amber-500"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0.05% (tight)</span><span>1.0% (wide)</span>
                  </div>
                </label>

                {/* Border Lookback Bets */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Proximity Lookback (bets)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.borderLookbackBets ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, borderLookbackBets: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>Last {n} settled bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Auto-Tuning */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Self-Learning Auto-Tune</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableAutoTuning: !(merged.enableAutoTuning ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableAutoTuning ?? true) ? "bg-sky-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableAutoTuning ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableAutoTuning ?? true) ? "text-sky-400" : "text-muted-foreground"}`}>
                      {(merged.enableAutoTuning ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* Auto-Tune Window Size */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Auto-Tune Window (bets, 20–500)</span>
                  <input
                    type="number" min={20} max={500} step={10}
                    value={merged.autoTuneWindowSize ?? 100}
                    onChange={e => setConfigDraft(d => ({ ...d, autoTuneWindowSize: parseInt(e.target.value) }))}
                    className="bg-background border border-border rounded-md px-3 py-1.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-sky-500"
                  />
                </label>

                {/* Regime Penalty */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Regime Penalty ({merged.regimePenalty ?? 15}pp)
                  </span>
                  <input type="range" min={0} max={20} step={1}
                    className="mt-1"
                    value={merged.regimePenalty ?? 15}
                    onChange={e => setConfigDraft(d => ({ ...d, regimePenalty: parseInt(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0 (off)</span><span>20pp</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    Confidence deducted when betting against the recent settlement direction. Lower = more bets.
                  </span>
                </label>

                {/* Master Enable */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Bot Master Switch</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enabled: !merged.enabled }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${merged.enabled ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${merged.enabled ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${merged.enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {merged.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* AI Pause — emergency cost kill-switch */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Pause All AI Calls</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, aiPaused: !merged.aiPaused }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${merged.aiPaused ? "bg-amber-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${merged.aiPaused ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${merged.aiPaused ? "text-amber-400" : "text-muted-foreground"}`}>
                      {merged.aiPaused ? "AI Paused — no Claude calls" : "AI Active"}
                    </span>
                  </div>
                  {merged.aiPaused && (
                    <p className="text-[10px] text-amber-400/80 mt-0.5">
                      Snaps + live direction return null. Bot continues using stat + ML signals only.
                    </p>
                  )}
                </label>
              </div>

              {/* Paper Trading Simulation — only visible in paper mode */}
              {status?.mode === "paper" && (
                <div className="border border-border/60 rounded-lg p-4 space-y-4 bg-sky-500/5">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-xs font-semibold text-sky-400">Paper Trading Simulation</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {/* Starting Balance */}
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Starting Wallet ($)</span>
                      <input type="number" min={1} max={100000} step={10}
                        className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                        value={merged.paperStartingBalance ?? 100}
                        onChange={e => setConfigDraft(d => ({ ...d, paperStartingBalance: parseFloat(e.target.value) }))} />
                      <span className="text-[10px] text-muted-foreground/70">
                        Balance when the wallet is reset.
                      </span>
                    </label>

                    {/* Win Return Rate */}
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        Win Profit Rate ({((merged.paperWinReturnRate ?? 0.5) * 100).toFixed(0)}%)
                      </span>
                      <input type="range" min={0.05} max={1.0} step={0.05}
                        className="mt-1"
                        value={merged.paperWinReturnRate ?? 0.5}
                        onChange={e => setConfigDraft(d => ({ ...d, paperWinReturnRate: parseFloat(e.target.value) }))} />
                      <div className="flex justify-between text-[10px] text-muted-foreground/60">
                        <span>5%</span><span>100%</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70">
                        Profit returned as % of bet on a win (e.g. 50% → +$0.50 per $1 bet).
                      </span>
                    </label>

                    {/* Reset Wallet */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Reset Wallet</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-sky-500/40 text-sky-400 hover:bg-sky-500/10 text-xs"
                        onClick={() => {
                          const now = new Date().toISOString();
                          setConfigDraft(d => ({
                            ...d,
                            paperBalanceResetAt: now,
                            paperStartingBalance: merged.paperStartingBalance ?? 100,
                          }));
                        }}
                      >
                        Reset to ${(merged.paperStartingBalance ?? 100).toFixed(0)}
                      </Button>
                      <span className="text-[10px] text-muted-foreground/70">
                        Resets the wallet to the Starting Wallet amount. Save to apply.
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2 border-t border-border">
                <Button size="sm" disabled={!hasDraft || saving} onClick={saveConfig} className="gap-1">
                  {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
                  {saving ? "Saving…" : "Save Configuration"}
                </Button>
                {hasDraft && !saving && (
                  <Button size="sm" variant="outline" onClick={() => setConfigDraft({})}>Reset</Button>
                )}
                {persistMsg === "saved" && (
                  <span className="text-xs text-emerald-400">✓ Settings saved</span>
                )}
                {persistMsg === "failed" && (
                  <span className="text-xs text-yellow-400">⚠ Applied (not persisted)</span>
                )}
              </div>

              {/* Mode-switch state reset banner */}
              {modeResetMsg && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 mt-1">
                  <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <div>
                    <p className="text-xs font-medium text-emerald-300">
                      Switched to {MODE_PRESETS[modeResetMsg].label} — adaptive state cleared
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground/80 leading-snug">
                      Doubt filter history, circuit-breaker streak, and per-window bet counts from the previous mode have been wiped. The bot starts fresh with no cross-mode bias.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Logic Mode Performance ── */}
        {(() => {
          const modes = logicPerfData?.modes ?? [];
          const totalBets = modes.reduce((s, m) => s + m.bets, 0);
          const activeMode = status?.config?.decisionMode ?? "classic";

          const MODE_META: Record<string, { label: string; desc: string; color: string; accent: string }> = {
            classic:   { label: "Classic",   desc: "Stat → Claude → ML cascade", color: "border-sky-500/40 bg-sky-950/10",      accent: "text-sky-400" },
            ml_gate:   { label: "ML Gate",   desc: "ML veto on disagreement",    color: "border-violet-500/40 bg-violet-950/10", accent: "text-violet-400" },
            consensus: { label: "Consensus", desc: "2/3 majority vote",          color: "border-amber-500/40 bg-amber-950/10",  accent: "text-amber-400" },
            unanimous: { label: "Unanimous", desc: "All 3 signals must agree",   color: "border-emerald-500/40 bg-emerald-950/10", accent: "text-emerald-400" },
          };

          const btModes = backtestData?.modes ?? [];

          const fmt$ = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          const renderModeCard = (
            m: LogicModeStats | BacktestModeStats,
            isBacktest: boolean,
          ) => {
            const meta = MODE_META[m.mode] ?? { label: m.mode, desc: "", color: "border-border bg-card/60", accent: "text-foreground" };
            const isActive = m.mode === activeMode;
            const wr = m.winRate;
            const wrPct = wr != null ? Math.round(wr * 100) : null;
            const wrColor = wrPct == null ? "" : wrPct >= 60 ? "text-emerald-400" : wrPct >= 45 ? "text-amber-400" : "text-red-400";
            const pnlColor = m.pnl >= 0 ? "text-emerald-400" : "text-red-400";
            const coveragePct = isBacktest ? Math.round((m as BacktestModeStats).coverage * 100) : null;

            return (
              <div key={m.mode} className={`border rounded-xl p-4 relative ${meta.color} ${isActive ? "ring-2 ring-offset-1 ring-offset-card ring-current" : ""}`} style={isActive ? { ["--tw-ring-color" as string]: "rgb(99 102 241 / 0.5)" } : {}}>
                {isActive && (
                  <span className={`absolute top-2.5 right-2.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-current/20 ${meta.accent}`}>
                    ACTIVE
                  </span>
                )}
                <div className={`text-sm font-bold ${meta.accent} mb-0.5`}>{meta.label}</div>
                <div className="text-[10px] text-muted-foreground/70 mb-3 leading-tight">{meta.desc}</div>

                {m.bets === 0 ? (
                  <div className="text-xs text-muted-foreground italic">No bets yet</div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2 mb-2">
                      <span className={`text-2xl font-black ${wrColor}`}>
                        {wrPct != null ? `${wrPct}%` : "—"}
                      </span>
                      <span className="text-[10px] text-muted-foreground">win rate</span>
                    </div>

                    <div className="flex items-center gap-1 mb-2">
                      <div className="flex-1 h-2 bg-muted/30 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${wrPct != null && wrPct >= 50 ? "bg-emerald-500" : "bg-red-500"} opacity-70 transition-all`}
                          style={{ width: `${wrPct ?? 0}%` }}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1 text-center">
                      <div className="bg-background/30 rounded p-1.5">
                        <div className="text-[9px] text-muted-foreground uppercase">Bets</div>
                        <div className="text-xs font-bold">{m.bets}</div>
                      </div>
                      <div className="bg-emerald-500/10 rounded p-1.5">
                        <div className="text-[9px] text-emerald-400 uppercase">Wins</div>
                        <div className="text-xs font-bold text-emerald-400">{m.wins}</div>
                      </div>
                      <div className="bg-red-500/10 rounded p-1.5">
                        <div className="text-[9px] text-red-400 uppercase">Losses</div>
                        <div className="text-xs font-bold text-red-400">{m.losses}</div>
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-between">
                      <div className="text-[10px] text-muted-foreground">Total P&L</div>
                      <div className={`text-xs font-bold ${pnlColor}`}>{m.pnl >= 0 ? "+" : ""}{fmt$(m.pnl)}</div>
                    </div>

                    {!isBacktest && (m as LogicModeStats).avgConfidence != null && (
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-muted-foreground">Avg confidence</div>
                        <div className={`text-xs font-semibold ${
                          (m as LogicModeStats).avgConfidence! >= 60 ? "text-emerald-400/90"
                          : (m as LogicModeStats).avgConfidence! >= 52 ? "text-amber-400/90"
                          : "text-muted-foreground"
                        }`}>
                          {(m as LogicModeStats).avgConfidence!.toFixed(1)}%
                        </div>
                      </div>
                    )}

                    {isBacktest && coveragePct !== null && (
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="text-[10px] text-muted-foreground">Bets taken</div>
                        <div className={`text-xs font-semibold ${coveragePct >= 90 ? "text-muted-foreground" : coveragePct >= 70 ? "text-amber-400/80" : "text-sky-400/80"}`}>
                          {coveragePct}% of all
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          };

          return (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
                <Brain className="w-4 h-4 text-violet-400" />
                <h2 className="font-semibold text-sm">Logic Mode Performance</h2>
                <span className="text-xs text-muted-foreground">win/loss per decision strategy</span>
                <div className="ml-auto flex items-center gap-1">
                  {(["live", "backtest"] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setBtPerfTab(tab)}
                      className={`text-[10px] font-semibold px-2.5 py-1 rounded transition-colors ${
                        btPerfTab === tab
                          ? "bg-violet-500/20 text-violet-300"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                      }`}
                    >
                      {tab === "live" ? "Live" : "Backtest"}
                    </button>
                  ))}
                  <span className="ml-2 text-[10px] text-muted-foreground">{totalBets} settled bets</span>
                </div>
              </div>
              <div className="p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {btPerfTab === "live"
                    ? modes.map(m => renderModeCard(m, false))
                    : btModes.map(m => renderModeCard(m, true))
                  }
                </div>
                {btPerfTab === "live" ? (
                  <p className="text-[10px] text-muted-foreground mt-3">
                    Historical bets placed before this feature was added are attributed to Classic mode. Switch modes in Bot Configuration above and save to start tracking a new strategy.
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground/70 mt-3 italic">
                    Backtest replays your settled bets through each mode's gating rules using the signals recorded at bet time. Classic always approves (baseline). ML Gate rejects when ML was available and disagreed. Consensus requires ≥2 of 3 signals to agree. Results assume the same entries — real live behavior may differ.
                  </p>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── Per-Coin Stats ── */}
        {(stats?.bySymbol?.length ?? 0) > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">Performance by Coin</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                    {["Coin", "Bets", "Wins", "Losses", "Win Rate", "P&L"].map(h => (
                      <th key={h} className="px-5 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats!.bySymbol.map(row => (
                    <tr key={row.symbol} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-5 py-2.5 font-bold">{row.symbol}</td>
                      <td className="px-5 py-2.5">{row.bets}</td>
                      <td className="px-5 py-2.5 text-emerald-400">{row.wins}</td>
                      <td className="px-5 py-2.5 text-red-400">{row.losses}</td>
                      <td className="px-5 py-2.5">{row.bets > 0 ? `${Math.round(row.wins / row.bets * 100)}%` : "—"}</td>
                      <td className={`px-5 py-2.5 font-semibold ${row.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt$(row.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Transaction Log ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Transaction History</h2>
            <span className="text-xs text-muted-foreground">{bets.length} record{bets.length !== 1 ? "s" : ""}</span>
            {totalHistPages > 1 && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setHistPage(p => Math.max(0, p - 1))}
                  disabled={clampedHistPage === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-muted-foreground tabular-nums px-1">
                  {clampedHistPage + 1} / {totalHistPages}
                </span>
                <button
                  onClick={() => setHistPage(p => Math.min(totalHistPages - 1, p + 1))}
                  disabled={clampedHistPage === totalHistPages - 1}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {bets.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Bot className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No bets placed yet. The bot is watching the markets.</p>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {totalHistPages > 1 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground pb-1">
                  <span>Showing {clampedHistPage * HIST_PAGE_SIZE + 1}–{Math.min((clampedHistPage + 1) * HIST_PAGE_SIZE, bets.length)} of {bets.length}</span>
                </div>
              )}
              {pagedBets.map((r) => {
                const pnlNum = r.pnl != null ? parseFloat(r.pnl) : null;
                const ep = r.entryPrice != null ? parseFloat(r.entryPrice) : null;
                const xp = r.exitPrice != null ? parseFloat(r.exitPrice) : null;
                const isOpen = r.action === "bet";
                const isPendingEval = !isOpen && r.outcome == null;
                const isWin = r.outcome === "win";
                const isLoss = r.outcome === "loss";
                const sigs = r.signals as Record<string, unknown> | null;
                const closePx = sigs?.closePriceAtEval as number | null ?? null;
                const endPx = closePx ?? (r.cryptoPriceAtExit != null ? parseFloat(r.cryptoPriceAtExit) : null);
                const strike = r.kalshiTarget != null ? parseFloat(r.kalshiTarget) : null;
                const endAboveStrike = endPx != null && strike != null ? endPx >= strike : null;

                const statAbove = sigs?.statAbove as boolean | null ?? null;
                const claudeAbove = sigs?.claudeAbove as boolean | null ?? null;
                const mlAbove = sigs?.mlAbove as boolean | null ?? null;
                const agreementTarget = sigs?.agreementTarget as string | null ?? null;

                const cardBg = isOpen
                  ? "border-sky-500/30 bg-sky-950/10"
                  : isWin
                    ? "border-emerald-500/30 bg-emerald-950/10"
                    : isLoss
                      ? "border-red-500/30 bg-red-950/10"
                      : isPendingEval
                        ? "border-amber-500/20 bg-amber-950/5"
                        : "border-border bg-card/60";

                return (
                  <div key={r.id} className={`border rounded-xl p-4 transition-colors ${cardBg}`}>
                    {/* Card header */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-base font-black tracking-tight text-foreground">{r.symbol}</span>

                      {r.direction && (
                        <span className={`flex items-center gap-0.5 text-xs font-bold px-2 py-0.5 rounded-full ${r.direction === "yes" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                          {r.direction === "yes" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                          {r.direction === "yes" ? "ABOVE" : "BELOW"}
                        </span>
                      )}

                      {isOpen ? (
                        <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 animate-pulse">
                          <Activity className="w-3 h-3" /> ACTIVE
                        </span>
                      ) : isWin ? (
                        <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                          <Trophy className="w-3 h-3" /> WIN
                        </span>
                      ) : isLoss ? (
                        <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">
                          <XCircle className="w-3 h-3" /> LOSS
                        </span>
                      ) : isPendingEval ? (
                        <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 animate-pulse">
                          <Activity className="w-3 h-3" /> EVALUATING
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {r.action.replace(/_/g, " ").toUpperCase()}
                        </span>
                      )}

                      {/* Signal agreement pills */}
                      {agreementTarget != null && (
                        <div className="flex items-center gap-1 ml-1">
                          {([["S", statAbove], ["C", claudeAbove], ["ML", mlAbove]] as [string, boolean | null][]).map(([label, val]) => (
                            val != null ? (
                              <span key={label} className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                (agreementTarget === "BET_YES" ? val === true : val === false)
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-red-500/15 text-red-400"
                              }`}>{label}</span>
                            ) : null
                          ))}
                        </div>
                      )}

                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-500"}`}>
                        {r.mode?.toUpperCase()}
                      </span>

                      {/* Decision mode badge */}
                      {(() => {
                        const dm = r.decisionMode ?? "classic";
                        const meta: Record<string, { label: string; cls: string }> = {
                          classic:   { label: "Classic",   cls: "bg-sky-500/10 text-sky-400/80" },
                          ml_gate:   { label: "ML Gate",   cls: "bg-violet-500/10 text-violet-400/80" },
                          consensus: { label: "Consensus", cls: "bg-amber-500/10 text-amber-400/80" },
                          unanimous: { label: "Unanimous", cls: "bg-emerald-500/10 text-emerald-400/80" },
                        };
                        const { label, cls } = meta[dm] ?? { label: dm, cls: "bg-muted/30 text-muted-foreground" };
                        return (
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>
                            {label}
                          </span>
                        );
                      })()}

                      <span className="ml-auto text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                    </div>

                    {/* Key metrics grid */}
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Strike</div>
                        <div className="text-xs font-semibold font-mono">{fmtCrypto(r.kalshiTarget)}</div>
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">
                          {closePx != null ? "Close Price" : isOpen ? "Entry Price" : "End Price"}
                        </div>
                        <div className="text-xs font-semibold font-mono flex items-center gap-1">
                          {endPx != null ? (
                            <>
                              {fmtCrypto(endPx)}
                              {endAboveStrike !== null && (
                                <span className={endAboveStrike ? "text-emerald-400" : "text-red-400"}>
                                  {endAboveStrike ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />}
                                </span>
                              )}
                            </>
                          ) : "—"}
                        </div>
                        {closePx == null && endPx != null && (
                          <div className="text-[9px] text-muted-foreground mt-0.5">at exit</div>
                        )}
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Entry</div>
                        <div className="text-xs font-mono">
                          {ep != null ? (
                            <span>{(ep * 100).toFixed(0)}¢ YES · {((1 - ep) * 100).toFixed(0)}¢ NO</span>
                          ) : "—"}
                        </div>
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Exit</div>
                        <div className="text-xs font-mono">
                          {xp != null ? `${(xp * 100).toFixed(0)}¢ YES` : isOpen ? <span className="text-sky-400 text-[9px]">in play…</span> : "—"}
                        </div>
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Size</div>
                        <div className="text-xs font-semibold">{r.contractCount ?? "—"} × {fmt$(r.betAmount)}</div>
                      </div>

                      <div className={`rounded-lg p-2.5 col-span-1 ${isPendingEval || pnlNum == null ? "bg-background/40" : pnlNum > 0 ? "bg-emerald-500/10" : pnlNum < 0 ? "bg-red-500/10" : "bg-background/40"}`}>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">P&L</div>
                        <div className={`text-sm font-bold font-mono ${isPendingEval || pnlNum == null ? "text-muted-foreground" : pnlNum >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {!isPendingEval && pnlNum != null ? (pnlNum >= 0 ? "+" : "") + fmt$(pnlNum) : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Footer row */}
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                      {!isOpen && r.exitedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {fmtDuration(r.createdAt, r.exitedAt)}
                        </span>
                      )}
                      <span className="font-mono">{r.windowKey?.slice(11, 16)} window</span>
                      {(() => {
                        const conf = sigs?.confidence as number | null ?? sigs?.statConfidence as number | null ?? null;
                        return conf != null ? (
                          <span className={`font-semibold ${conf >= 60 ? "text-emerald-400" : conf >= 52 ? "text-amber-400" : "text-muted-foreground"}`}>
                            {Math.round(conf)}% conf
                          </span>
                        ) : null;
                      })()}
                      {r.exitReason && (
                        <span className="truncate max-w-[220px]" title={r.exitReason}>
                          · {r.exitReason.replace(/_/g, " ")}
                        </span>
                      )}
                      {r.phase2Activated && (
                        <span className="text-amber-400 font-medium">· Phase 2</span>
                      )}
                      {isPendingEval && (
                        <span className="text-amber-400/70">· awaiting window close price</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {totalHistPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-2 border-t border-border mt-1">
                  <button
                    onClick={() => setHistPage(p => Math.max(0, p - 1))}
                    disabled={clampedHistPage === 0}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page {clampedHistPage + 1} of {totalHistPages}
                  </span>
                  <button
                    onClick={() => setHistPage(p => Math.min(totalHistPages - 1, p + 1))}
                    disabled={clampedHistPage === totalHistPages - 1}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Performance Insights ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setPerfOpen(o => !o)}
          >
            <Brain className="w-4 h-4 text-sky-400" />
            <h2 className="font-semibold text-sm">Performance Insights</h2>
            {perfReportData?.report && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {perfReportData.report.totalBets} bets analysed
              </span>
            )}
            {perfOpen ? <ChevronUp className="w-4 h-4 ml-1 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 ml-1 text-muted-foreground" />}
          </button>
          {perfOpen && (
            <div className="p-5 space-y-5">
              {!perfReportData?.report ? (
                <p className="text-sm text-muted-foreground">
                  No report yet — the first analysis runs 15 minutes after startup.
                </p>
              ) : (() => {
                const r = perfReportData.report;
                const paused = perfReportData.pausedCoins ?? {};
                const pct = (v: number | null) => v == null ? "—" : `${Math.round(v * 100)}%`;

                return (
                  <>
                    {/* Top stats */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Total Bets", value: String(r.totalBets) },
                        { label: "Overall Win Rate", value: pct(r.overallWinRate) },
                        { label: "Last-24h Win Rate", value: pct(r.last24hWinRate) },
                        { label: "CB Triggers", value: String(r.circuitBreakerTriggers),
                          color: r.circuitBreakerTriggers >= 3 ? "text-red-400" : r.circuitBreakerTriggers >= 1 ? "text-amber-400" : "" },
                      ].map(({ label, value, color }) => (
                        <div key={label} className="bg-background/40 rounded-lg p-3 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
                          <div className={`text-base font-bold ${color ?? ""}`}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Win-rate trend sparkline */}
                    {r.totalBets > 0 && (() => {
                      const points = [
                        { label: "Last 10", wr: r.last10WinRate },
                        { label: "Last 30", wr: r.last30WinRate },
                        { label: "Last 24h", wr: r.last24hWinRate },
                        { label: "All-time", wr: r.overallWinRate },
                      ].filter(p => p.wr !== null);
                      if (points.length === 0) return null;
                      return (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win-Rate Trend</div>
                          <div className="flex items-end gap-2 h-16">
                            {points.map(({ label, wr }) => {
                              const pctVal = Math.round((wr ?? 0) * 100);
                              const barH = Math.max(4, Math.round((pctVal / 100) * 64));
                              const color = pctVal >= 60 ? "bg-emerald-500" : pctVal >= 45 ? "bg-yellow-500" : "bg-red-500";
                              return (
                                <div key={label} className="flex flex-col items-center gap-1 flex-1">
                                  <span className="text-[9px] font-medium" style={{ color: pctVal >= 60 ? "#10b981" : pctVal >= 45 ? "#eab308" : "#ef4444" }}>{pctVal}%</span>
                                  <div className={`w-full rounded-t ${color} opacity-80 transition-all`} style={{ height: `${barH}px` }} />
                                  <span className="text-[8px] text-muted-foreground text-center leading-tight">{label}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Direction balance bar */}
                    {(r.byDirection.yes.betCount + r.byDirection.no.betCount) > 0 && (() => {
                      const total = r.byDirection.yes.betCount + r.byDirection.no.betCount;
                      const yesPct = Math.round((r.byDirection.yes.betCount / total) * 100);
                      const noPct = 100 - yesPct;
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Direction Balance</span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              YES {r.byDirection.yes.betCount} · NO {r.byDirection.no.betCount}
                            </span>
                          </div>
                          <div className="flex rounded-full overflow-hidden h-4">
                            <div
                              className="bg-sky-500 flex items-center justify-center text-[9px] font-bold text-white"
                              style={{ width: `${yesPct}%` }}
                            >{yesPct >= 20 ? `${yesPct}%` : ""}</div>
                            <div
                              className="bg-violet-500 flex items-center justify-center text-[9px] font-bold text-white"
                              style={{ width: `${noPct}%` }}
                            >{noPct >= 20 ? `${noPct}%` : ""}</div>
                          </div>
                          <div className="flex justify-between mt-1">
                            <span className="text-[9px] text-sky-400 font-medium">▲ YES · {pct(r.byDirection.yes.winRate)} WR</span>
                            <span className="text-[9px] text-violet-400 font-medium">▼ NO · {pct(r.byDirection.no.winRate)} WR</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Confidence avg W vs L */}
                    {(r.avgConfidenceWinners != null || r.avgConfidenceLosers != null) && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-emerald-400 mb-1">Avg Confidence — Winners</div>
                          <div className="text-base font-bold text-emerald-400">{r.avgConfidenceWinners != null ? `${r.avgConfidenceWinners.toFixed(0)}%` : "—"}</div>
                        </div>
                        <div className="bg-red-500/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-red-400 mb-1">Avg Confidence — Losers</div>
                          <div className="text-base font-bold text-red-400">{r.avgConfidenceLosers != null ? `${r.avgConfidenceLosers.toFixed(0)}%` : "—"}</div>
                        </div>
                      </div>
                    )}

                    {/* Confidence-band win-rate breakdown */}
                    {(() => {
                      const bands = r.byConfidenceBand
                        ? Object.values(r.byConfidenceBand).filter(b => b.betCount > 0)
                        : [];
                      if (bands.length === 0) return null;
                      const maxBets = Math.max(...bands.map(b => b.betCount));
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Confidence Level</span>
                            {r.optimalConfidenceThreshold != null && (
                              <span className="text-[10px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                Optimal floor: {r.optimalConfidenceThreshold}%
                              </span>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            {Object.values(r.byConfidenceBand ?? {})
                              .sort((a, b) => a.lowerBound - b.lowerBound)
                              .map(b => {
                                const wr = b.winRate ?? 0;
                                const isOptimal = r.optimalConfidenceThreshold === b.lowerBound;
                                const barColor = b.betCount < 5 ? "bg-muted/50"
                                  : wr >= 0.65 ? "bg-emerald-500"
                                  : wr >= 0.50 ? "bg-yellow-500"
                                  : "bg-red-500";
                                const textColor = b.betCount < 5 ? "text-muted-foreground"
                                  : wr >= 0.65 ? "text-emerald-400"
                                  : wr >= 0.50 ? "text-yellow-400"
                                  : "text-red-400";
                                const barWidth = maxBets > 0 ? Math.max(4, Math.round((b.betCount / maxBets) * 100)) : 4;
                                return (
                                  <div key={b.band} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${isOptimal ? "bg-emerald-500/10 ring-1 ring-emerald-500/40" : "bg-background/30"}`}>
                                    <span className="text-[10px] font-mono w-12 flex-shrink-0 text-muted-foreground">{b.band}%</span>
                                    <div className="flex-1 h-3 bg-muted/30 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full transition-all ${barColor} opacity-70`} style={{ width: `${barWidth}%` }} />
                                    </div>
                                    <span className={`text-[10px] font-bold w-8 text-right ${textColor}`}>
                                      {b.betCount < 5 ? "—" : `${Math.round(wr * 100)}%`}
                                    </span>
                                    <span className="text-[9px] text-muted-foreground w-12 text-right">{b.betCount} bet{b.betCount !== 1 ? "s" : ""}</span>
                                    {isOptimal && <span className="text-[9px] text-emerald-400 font-bold">★</span>}
                                  </div>
                                );
                              })}
                          </div>
                          {Object.values(r.byConfidenceBand ?? {}).every(b => b.betCount < 5) && (
                            <p className="text-[10px] text-muted-foreground mt-1.5">Need ≥ 5 bets per band to show reliable win rates</p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Signal agreement breakdown */}
                    {(() => {
                      const levels = r.byAgreementLevel
                        ? Object.values(r.byAgreementLevel).filter(l => l.betCount > 0)
                        : [];
                      if (levels.length === 0) return null;
                      return (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win Rate by Signal Agreement</div>
                          <div className="grid grid-cols-3 gap-2">
                            {levels
                              .sort((a, b) => b.agreeing - a.agreeing)
                              .map(l => {
                                const wr = l.winRate ?? 0;
                                const color = l.betCount < 3 ? "text-muted-foreground"
                                  : wr >= 0.60 ? "text-emerald-400"
                                  : wr >= 0.45 ? "text-yellow-400"
                                  : "text-red-400";
                                const bg = l.betCount < 3 ? "bg-muted/20"
                                  : wr >= 0.60 ? "bg-emerald-500/10"
                                  : wr >= 0.45 ? "bg-yellow-500/10"
                                  : "bg-red-500/10";
                                return (
                                  <div key={l.level} className={`rounded-lg p-3 text-center ${bg}`}>
                                    <div className="text-xs font-bold mb-0.5">{l.level} signals</div>
                                    <div className={`text-base font-bold ${color}`}>
                                      {l.betCount < 3 ? "—" : `${Math.round(wr * 100)}%`}
                                    </div>
                                    <div className="text-[9px] text-muted-foreground">{l.wins}W / {l.losses}L</div>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Per-symbol breakdown */}
                    {Object.keys(r.bySymbol).length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">By Coin</div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {Object.entries(r.bySymbol).map(([sym, s]) => {
                            const isPaused = paused[sym] != null;
                            return (
                              <div key={sym} className={`rounded-lg p-3 bg-background/40 border ${isPaused ? "border-amber-500/50" : "border-transparent"}`}>
                                <div className="flex items-center gap-1 mb-1">
                                  <span className="text-xs font-bold">{sym}</span>
                                  {isPaused && (
                                    <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1 rounded">
                                      paused {paused[sym]}w
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {s.wins}W / {s.losses}L · {pct(s.winRate)} WR
                                </div>
                                {s.currentConsecutiveLosses >= 3 && (
                                  <div className="text-[9px] text-red-400 mt-0.5">
                                    {s.currentConsecutiveLosses} consecutive losses
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Hour band heatmap */}
                    {Object.keys(r.byHourBand).length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win Rate by Hour Band (UTC)</div>
                        <div className="flex flex-wrap gap-2">
                          {Object.values(r.byHourBand)
                            .sort((a, b) => a.band.localeCompare(b.band))
                            .map(b => {
                              const wr = b.winRate ?? 0;
                              const color = b.betCount < 5 ? "bg-muted/40 text-muted-foreground"
                                : wr >= 0.6 ? "bg-emerald-500/20 text-emerald-400"
                                : wr >= 0.4 ? "bg-yellow-500/20 text-yellow-400"
                                : "bg-red-500/20 text-red-400";
                              return (
                                <div key={b.band} className={`rounded-lg px-3 py-2 text-center min-w-[70px] ${color}`}>
                                  <div className="text-[9px] font-mono mb-0.5">{b.band}</div>
                                  <div className="text-xs font-bold">{pct(b.winRate)}</div>
                                  <div className="text-[9px] opacity-70">{b.betCount} bets</div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}

                    {/* Day of Week win rate */}
                    {r.byDayOfWeek && Object.values(r.byDayOfWeek).some(d => d.betCount > 0) && (() => {
                      const days = [1,2,3,4,5,6,0].map(d => r.byDayOfWeek[d]).filter(Boolean);
                      const maxWR = Math.max(...days.map(d => d.winRate ?? 0));
                      const bestDay = days.reduce((b, d) => (d.betCount >= 3 && (d.winRate ?? 0) > (b.winRate ?? 0)) ? d : b, days[0]);
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Day of Week (UTC)</div>
                            {bestDay?.betCount >= 3 && bestDay.winRate !== null && (
                              <span className="text-[10px] text-emerald-400 font-medium">
                                Best: {bestDay.dayName} ({Math.round(bestDay.winRate * 100)}% / {bestDay.betCount} bets)
                              </span>
                            )}
                          </div>
                          <div className="flex gap-1.5">
                            {days.map(d => {
                              const wr = d.winRate ?? 0;
                              const barH = d.betCount === 0 ? 4 : Math.max(8, Math.round(wr * 56));
                              const isTop = d.betCount >= 3 && wr === maxWR && maxWR > 0;
                              const color = d.betCount < 3 ? "bg-muted/40"
                                : wr >= 0.65 ? "bg-emerald-500"
                                : wr >= 0.5  ? "bg-sky-500"
                                : wr >= 0.35 ? "bg-yellow-500"
                                : "bg-red-500";
                              return (
                                <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                                  <div className="w-full flex items-end justify-center" style={{ height: 60 }}>
                                    <div
                                      className={`w-full rounded-t transition-all ${color} ${isTop ? "ring-1 ring-emerald-400/60" : ""}`}
                                      style={{ height: barH }}
                                      title={`${d.dayName}: ${d.betCount} bets, ${d.betCount > 0 ? Math.round(wr * 100) : "—"}% WR`}
                                    />
                                  </div>
                                  <div className="text-[9px] font-medium text-muted-foreground">{d.dayName}</div>
                                  <div className={`text-[9px] font-bold ${d.betCount < 3 ? "text-muted-foreground/50" : wr >= 0.6 ? "text-emerald-400" : wr >= 0.4 ? "text-sky-400" : "text-red-400"}`}>
                                    {d.betCount === 0 ? "—" : `${Math.round(wr * 100)}%`}
                                  </div>
                                  <div className="text-[8px] text-muted-foreground/50">{d.betCount}b</div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="text-[9px] text-muted-foreground/50 mt-1">Bars fade when &lt;3 bets — not enough data yet</div>
                        </div>
                      );
                    })()}

                    {/* Hour of Day win rate heatmap */}
                    {r.byHourOfDay && Object.values(r.byHourOfDay).some(h => h.betCount > 0) && (() => {
                      const hours = Array.from({ length: 24 }, (_, i) => r.byHourOfDay[i]).filter(Boolean);
                      const bestHour = hours.reduce((b, h) => (h.betCount >= 3 && (h.winRate ?? 0) > (b.winRate ?? 0)) ? h : b, hours[0]);
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Hour of Day (UTC)</div>
                            {bestHour?.betCount >= 3 && bestHour.winRate !== null && (
                              <span className="text-[10px] text-emerald-400 font-medium">
                                Best: {String(bestHour.hour).padStart(2,"0")}:00 UTC ({Math.round(bestHour.winRate * 100)}%)
                              </span>
                            )}
                          </div>
                          <div className="flex gap-px">
                            {hours.map(h => {
                              const wr = h.winRate ?? 0;
                              const barH = h.betCount === 0 ? 3 : Math.max(6, Math.round(wr * 48));
                              const color = h.betCount < 2 ? "bg-muted/30"
                                : wr >= 0.7  ? "bg-emerald-400"
                                : wr >= 0.55 ? "bg-sky-400"
                                : wr >= 0.4  ? "bg-yellow-400"
                                : "bg-red-400";
                              return (
                                <div key={h.hour} className="flex-1 flex flex-col items-center gap-px" title={`${String(h.hour).padStart(2,"0")}:00 UTC — ${h.betCount} bets${h.betCount > 0 ? `, ${Math.round(wr*100)}% WR` : ""}`}>
                                  <div className="w-full flex items-end" style={{ height: 52 }}>
                                    <div className={`w-full rounded-sm ${color}`} style={{ height: barH }} />
                                  </div>
                                  {h.hour % 6 === 0 && (
                                    <div className="text-[8px] text-muted-foreground/60">{String(h.hour).padStart(2,"0")}</div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex justify-between text-[8px] text-muted-foreground/40 mt-0.5 px-px">
                            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
                          </div>
                          <div className="text-[9px] text-muted-foreground/50 mt-1">Hover bars for detail · Labels every 6 hours · Faded = &lt;2 bets</div>
                        </div>
                      );
                    })()}

                    {/* Recommendations */}
                    {r.recommendations.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Recommendations</div>
                        <div className="space-y-1.5">
                          {r.recommendations.map((rec, i) => (
                            <div key={i} className="flex items-start gap-2 text-sm bg-sky-500/10 text-sky-300 rounded-lg px-3 py-2">
                              <Zap className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                              {rec}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="text-[10px] text-muted-foreground">
                      Last computed: {r.computedAt ? new Date(r.computedAt).toLocaleString() : "—"}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>

        {/* ── Auto-Tune History ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setTuneLogOpen(o => !o)}
          >
            <Sliders className="w-4 h-4 text-violet-400" />
            <h2 className="font-semibold text-sm">Auto-Tune History</h2>
            {tuneCount > 0 && (
              <span className={`inline-flex items-center justify-center text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] ${recentTuneEntry ? "bg-violet-500/30 text-violet-300 border border-violet-500/50" : "bg-muted text-muted-foreground border border-border"}`}>
                {tuneCount}
              </span>
            )}
            {recentTuneEntry && (
              <span className="text-[10px] text-violet-400 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block animate-pulse" />
                last {Math.round((Date.now() - new Date(recentTuneEntry.createdAt).getTime()) / 60000)}m ago
              </span>
            )}
            {tuneLogOpen ? <ChevronUp className="w-4 h-4 ml-auto text-muted-foreground" /> : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />}
          </button>
          {tuneLogOpen && (
            <div className="p-5">
              {(autoTuneLogData?.entries?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No parameter changes yet — auto-tune mutations will appear here once the rules trigger.
                </p>
              ) : (
                <div className="space-y-2">
                  {autoTuneLogData!.entries.map(entry => {
                    const ruleColor = entry.ruleName === "confidence_floor_raise"
                      ? "text-amber-400"
                      : entry.ruleName === "per_coin_pause"
                      ? "text-red-400"
                      : "text-sky-400";
                    const ruleLabel = entry.ruleName === "confidence_floor_raise"
                      ? "Confidence Raised"
                      : entry.ruleName === "per_coin_pause"
                      ? "Coin Paused"
                      : entry.ruleName === "quiet_hours_expand"
                      ? "Quiet Hours Expanded"
                      : entry.ruleName;
                    return (
                      <div key={entry.id} className="bg-background/40 rounded-lg px-4 py-3 flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-semibold ${ruleColor}`}>{ruleLabel}</span>
                          {entry.oldValue && entry.newValue && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {entry.oldValue} → {entry.newValue}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">{entry.triggerReason}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
