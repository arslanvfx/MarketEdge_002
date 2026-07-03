import { useState, useEffect, useRef, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign,
  BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus,
  Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

// ─── Types ──────────────────────────────────────────────────────────────────

type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous";

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
  requireMonitorReady: boolean;
  regimePenalty: number;
  mlVetoMinConfidence: number;
  betProfile: "normal" | "aggressive";
  paperStartingBalance: number;
  paperWinReturnRate: number;
  paperBalanceResetAt: string | null;
  maxBetSize: number;
  minAccountBalance: number;
  maxTotalExposure: number;
  maxDailyLossPerCoin: number;
  coinStreakLossLimit: number;
  coinStreakPauseWindows: number;
  maxSlippageCents: number;
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
  dailyPnl: number; accountBalance: number | null;
  warmupSecondsRemaining: number | null; configured: boolean;
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  isInQuietHours: boolean;
  dbDegraded?: boolean;
  dbDegradedSince?: string | null;
  isProductionEnv?: boolean;
  mlStatus?: {
    ready: boolean; readyCount: number; totalCount: number;
    minWindows: number; minRequired: number;
  };
  coinStreakState?: Record<string, { consecutiveLosses: number; pauseUntilWindowKey: string | null }>;
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
  windowKey: string; selected: boolean; betPlacedThisWindow: boolean; evaluatedAt: string;
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

interface CoinGuardEntry {
  symbol: string;
  dailyLoss: number;
  consecutiveLosses: number;
  pauseUntilWindowKey: string | null;
  slippageStrikes: number;
}

interface CoinGuardState {
  coins: CoinGuardEntry[];
  maxDailyLossPerCoin: number;
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
  // Use enough decimals to preserve meaningful precision at every price tier.
  // $1000+  → 2dp (BTC, ETH high-range)
  // $1–999  → up to 4dp (XRP $1.1355, SOL, LINK, etc.)
  // <$1     → up to 6dp (DOGE, very low-priced coins)
  if (v >= 1000) return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 1)    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
};

const EST = "America/New_York";
const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: EST }) + " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: EST }) + " EST";
};

/** Convert a windowKey like "2026-07-03T05:15" (UTC) to "12:15 AM EST" display. */
const wkToEst = (wk: string | null | undefined): string => {
  if (!wk) return "—";
  const d = new Date(wk + ":00Z");
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EST });
};

/** Convert "HH-HH" UTC hour band to EST, e.g. "00-02" → "7PM-9PM EST". */
const bandToEst = (band: string): string => {
  const [s, e] = band.split("-").map(Number);
  const fmt = (h: number) => {
    const ampm = ((h % 24) < 12) ? "AM" : "PM";
    const h12 = ((h % 24) % 12) || 12;
    return `${h12}${ampm}`;
  };
  return `${fmt((s - 5 + 24) % 24)}-${fmt((e - 5 + 24) % 24)}`;
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

// ─── Animated countdown cell for Market Selection table ─────────────────────
//
// Countdown end times are derived from windowKey (wall-clock math) rather than
// the server-reported remaining seconds.  This means the countdown is accurate
// even immediately after a server restart — the server's transient "45s remaining"
// snapshot is ignored in favour of reality.
//
// Countdown scenarios:
//   "window buffer (Xs remaining)"           → clears at windowStart + 45 s
//   "window monitor not ready (…)"           → clears at windowStart + 120 s
//   "min-remaining floor (<Xmin remaining)"  → shows time left in the window

type CountdownColor = "amber" | "violet" | "rose";

const COUNTDOWN_COLORS: Record<CountdownColor, { ring: string; text: string; pulse: string }> = {
  amber:  { ring: "stroke-amber-400",  text: "text-amber-400",  pulse: "bg-amber-400"  },
  violet: { ring: "stroke-violet-400", text: "text-violet-400", pulse: "bg-violet-400" },
  rose:   { ring: "stroke-rose-400",   text: "text-rose-400",   pulse: "bg-rose-400"   },
};

function parseCountdownScenario(
  reason: string,
  windowKey: string,
): { label: string; endsAt: number; total: number; color: CountdownColor } | null {
  // windowKey is always UTC ("YYYY-MM-DDTHH:mm" from toISOString().slice(0,16)).
  // Without a "Z" suffix, browsers parse it as LOCAL time → large wrong offset.
  const ws = new Date(windowKey + "Z").getTime();
  if (reason.startsWith("window buffer")) {
    return { label: "Buffer clears in", endsAt: ws + 45_000,       total: 45,      color: "amber"  };
  }
  if (reason.startsWith("window monitor not ready")) {
    return { label: "Monitor ready in", endsAt: ws + 120_000,      total: 120,     color: "violet" };
  }
  if (reason.startsWith("min-remaining floor")) {
    return { label: "Window ends in",   endsAt: ws + 15 * 60_000,  total: 15 * 60, color: "rose"   };
  }
  return null;
}

function CountdownCell({ reason, windowKey }: { reason: string; windowKey: string }) {
  const scenario = useMemo(() => parseCountdownScenario(reason, windowKey), [reason, windowKey]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!scenario) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [scenario]);

  if (!scenario) {
    return <span className="text-muted-foreground text-xs truncate max-w-[200px] block">{reason}</span>;
  }

  const remaining = Math.max(0, Math.round((scenario.endsAt - now) / 1000));
  const pct = Math.max(0, Math.min(1, remaining / scenario.total));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = mins > 0 ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`;

  const R = 10;
  const circ = 2 * Math.PI * R;
  const dash = circ * pct;
  const colors = COUNTDOWN_COLORS[scenario.color];

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-6 h-6 flex-shrink-0">
        <svg viewBox="0 0 24 24" className="-rotate-90 w-6 h-6">
          <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor"
            strokeWidth="2.5" className="text-muted-foreground/20" />
          <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            className={`${colors.ring} transition-all duration-900`} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center">
          <span className={`w-1.5 h-1.5 rounded-full ${colors.pulse} animate-pulse`} />
        </span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className={`text-xs font-mono font-bold tabular-nums ${colors.text}`}>{timeStr}</span>
        <span className="text-[9px] text-muted-foreground/60 whitespace-nowrap">{scenario.label}</span>
      </div>
    </div>
  );
}

export default function BotDashboard() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(true);
  const [confirmLive, setConfirmLive] = useState(false);
  const [liveCheckboxChecked, setLiveCheckboxChecked] = useState(false);
  const [configDraft, setConfigDraft] = useState<Partial<BotConfig>>({});
  const [saving, setSaving] = useState(false);
  const [persistMsg, setPersistMsg] = useState<"saved" | "failed" | null>(null);
  const [perfOpen, setPerfOpen] = useState(true);
  const [tuneLogOpen, setTuneLogOpen] = useState(true);
  const [histPage, setHistPage] = useState(0);
  // historyMode is the mode shown in the Transaction History table and stats.
  // Defaults to the active bot mode but can be toggled independently so the
  // user can browse paper history while live or vice versa.
  const [historyMode, setHistoryMode] = useState<"paper" | "live">("paper");

  // ── Data fetching ────────────────────────────────────────────────────────
  const { data: status, isLoading } = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/status`).then(r => r.json()),
    refetchInterval: 5_000,
  });

  // Pre-live preflight check — fires when the pre-live confirmation modal is open.
  // Uses a separate mode-agnostic endpoint so we can verify Kalshi API reachability
  // and account balance BEFORE the user switches to live mode.
  const { data: kalshiPreflightData, isLoading: preflightLoading } = useQuery<{ configured: boolean; balance: number | null; ok: boolean }>({
    queryKey: ["bot-kalshi-preflight"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/kalshi-preflight`).then(r => r.json()),
    enabled: confirmLive,
    staleTime: 0,
    refetchInterval: false,
  });

  // Live Kalshi balance badge — fires only while the bot is in live mode (mode-guarded endpoint).
  const { data: kalshiBalanceData } = useQuery<{ balance: number | null; ok: boolean; reason?: string }>({
    queryKey: ["bot-kalshi-balance"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/kalshi-balance`).then(r => r.json()),
    enabled: status?.mode === "live",
    staleTime: 0,
    refetchInterval: status?.mode === "live" ? 30_000 : false,
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

  // Sync the history/stats view mode when the bot's active mode changes so the
  // user always sees their current session's data by default.
  const prevBotMode = useRef<"paper" | "live" | undefined>(undefined);
  useEffect(() => {
    const m = status?.mode;
    if (m && m !== prevBotMode.current) {
      prevBotMode.current = m;
      setHistoryMode(m);
      setHistPage(0);
    }
  }, [status?.mode]);

  const { data: historyData } = useQuery<{ history: HistoryRecord[] }>({
    queryKey: ["bot-all-history", historyMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/all-history?limit=500&mode=${historyMode}`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  // Stats always reflect the active bot mode so the KPI cards are authoritative.
  // Only the Transaction History table is separately switchable via historyMode.
  const activeMode = status?.mode ?? "paper";
  const { data: statsData } = useQuery<BotStats>({
    queryKey: ["bot-stats", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/stats?mode=${activeMode}`).then(r => r.json()),
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

  const { data: presetsData } = useQuery<{ presets: Partial<Record<string, object>> }>({
    queryKey: ["bot-mode-presets"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/crypto/bot/config/presets`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const { data: backtestData } = useQuery<{ modes: BacktestModeStats[] }>({
    queryKey: ["bot-backtest-modes"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/backtest-modes`).then(r => r.json()),
    refetchInterval: 10 * 60_000,
  });

  const { data: coinGuardData } = useQuery<CoinGuardState>({
    queryKey: ["bot-coin-guard-state"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/coin-guard-state`).then(r => r.json()),
    refetchInterval: 10_000,
  });

  const [btPerfTab, setBtPerfTab] = useState<"live" | "backtest">("live");
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);

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

  async function saveConfig() {
    setSaving(true);
    try {
      const result = await authPost("/crypto/bot/config", configDraft) as { ok: boolean; persisted: boolean };
      setConfigDraft({});
      setPersistMsg(result.persisted ? "saved" : "failed");
      setTimeout(() => setPersistMsg(null), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function savePreset() {
    setSavingPreset(true);
    try {
      await authPost("/crypto/bot/config/save-preset", {});
      void qc.invalidateQueries({ queryKey: ["bot-mode-presets"] });
      setPresetMsg("Preset saved ✓");
      setTimeout(() => setPresetMsg(null), 3000);
    } catch {
      setPresetMsg("Save failed");
      setTimeout(() => setPresetMsg(null), 3000);
    } finally {
      setSavingPreset(false);
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
  const pnl = status?.dailyPnl ?? 0;
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

  // Coins currently blocked by the per-coin streak loss limit (coinStreakState).
  // These are separate from the auto-tune pausedCoins and always come from /bot/status.
  const streakPausedCoins: Array<{ sym: string; pauseUntilWindowKey: string; consecutiveLosses: number }> =
    Object.entries(status?.coinStreakState ?? {})
      .filter(([, s]) => s.pauseUntilWindowKey !== null)
      .map(([sym, s]) => ({ sym, pauseUntilWindowKey: s.pauseUntilWindowKey!, consecutiveLosses: s.consecutiveLosses }));

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
              CB: {status!.circuitBreakerWindowsRemaining} {status!.circuitBreakerWindowsRemaining === 1 ? "window" : "windows"}
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
          {status?.dbDegraded && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 animate-pulse" title={`Database unreachable since ${status.dbDegradedSince ? new Date(status.dbDegradedSince).toLocaleTimeString() : "recently"} — new bets paused until connection restores`}>
              <AlertTriangle className="w-3 h-3" />
              DB offline
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
          {/* Paper ⇄ Live mode toggle. Switching to Paper is immediate and stops
              all real-money betting. Switching to Live requires confirmation.
              The toggle is locked to Paper in non-production environments — live
              betting is only permitted in the production deployment. */}
          {!status?.isProductionEnv ? (
            <div
              className="flex items-center gap-2 opacity-50 cursor-not-allowed select-none"
              title="Live betting is only available in the production deployment."
            >
              <span className="text-xs font-medium text-yellow-400">Paper</span>
              <div className="relative w-11 h-6 rounded-full bg-muted">
                <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">Live</span>
            </div>
          ) : confirmLive ? (
            <>
              {/* Overlay modal backdrop */}
              <div
                className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center"
                onClick={() => { setConfirmLive(false); setLiveCheckboxChecked(false); }}
              >
                <div
                  className="w-96 max-w-[92vw] bg-card border border-red-500/40 rounded-2xl shadow-2xl p-6 flex flex-col gap-4"
                  onClick={e => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2 text-red-400 font-bold text-base">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    Switch to Live Betting
                  </div>
                  <p className="text-xs text-muted-foreground -mt-1">Real money will be at stake. Review the checks below before confirming.</p>

                  {/* Pre-live checklist */}
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center gap-2 text-xs">
                      {status?.configured
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        : <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                      <span className={status?.configured ? "text-emerald-400" : "text-red-400 font-medium"}>
                        {status?.configured ? "Kalshi API key configured" : "Kalshi API key NOT configured — cannot go live"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {preflightLoading
                        ? <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
                        : kalshiPreflightData?.ok
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          : <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                      <span className={preflightLoading ? "text-muted-foreground" : kalshiPreflightData?.ok ? "text-emerald-400" : "text-red-400 font-medium"}>
                        {preflightLoading
                          ? "Checking Kalshi account balance…"
                          : kalshiPreflightData?.ok
                            ? `Kalshi balance: $${kalshiPreflightData.balance?.toFixed(2)} (above $${(merged.minAccountBalance ?? 5).toFixed(2)} minimum)`
                            : "Could not verify Kalshi balance — check API key or connection"}
                      </span>
                    </div>
                  </div>

                  {/* Active limits summary */}
                  <div className="bg-background/60 border border-border rounded-lg px-4 py-3 text-xs flex flex-col gap-1.5">
                    <div className="text-muted-foreground font-medium mb-1">Active safety limits</div>
                    {([
                      ["Max single bet", `$${(merged.maxBetSize ?? 2).toFixed(2)}`],
                      ["Daily loss limit", `$${(merged.dailyLossLimit ?? 20).toFixed(2)}`],
                      ["Total exposure cap", `$${(merged.maxTotalExposure ?? 5).toFixed(2)}`],
                      ["Min account balance", `$${(merged.minAccountBalance ?? 5).toFixed(2)}`],
                      ["Daily loss / coin", `$${(merged.maxDailyLossPerCoin ?? 3).toFixed(2)}`],
                    ] as [string, string][]).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="text-foreground font-mono">{v}</span>
                      </div>
                    ))}
                  </div>

                  {/* Confirmation checkbox */}
                  <label className="flex items-start gap-2.5 cursor-pointer select-none text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-red-500 cursor-pointer"
                      checked={liveCheckboxChecked}
                      onChange={e => setLiveCheckboxChecked(e.target.checked)}
                    />
                    <span className="text-muted-foreground leading-relaxed">
                      I understand this will place real bets on Kalshi. I have reviewed my settings and accept the financial risk.
                    </span>
                  </label>

                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="destructive"
                      className="flex-1 h-8 font-semibold"
                      disabled={!status?.configured || !kalshiPreflightData?.ok || !liveCheckboxChecked}
                      onClick={() => { setMode("live"); setConfirmLive(false); setLiveCheckboxChecked(false); }}
                    >
                      {preflightLoading ? "Verifying…" : "Confirm — Go Live"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => { setConfirmLive(false); setLiveCheckboxChecked(false); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
              {/* Subtle indicator in header while the modal is open */}
              <span className="text-xs text-red-400 font-medium animate-pulse">Confirming…</span>
            </>
          ) : (
            <div className="flex items-center gap-2" title={status?.mode === "live" ? "Live — betting real money. Click to switch back to Paper." : "Paper — simulated betting. Click to go Live."}>
              <span className={`text-xs font-medium ${status?.mode === "paper" ? "text-yellow-400" : "text-muted-foreground"}`}>Paper</span>
              <button
                type="button"
                role="switch"
                aria-checked={status?.mode === "live"}
                onClick={() => {
                  if (status?.mode === "live") {
                    setMode("paper"); // immediate — stops real-money betting
                  } else {
                    setConfirmLive(true); // require confirmation before real money
                  }
                }}
                className={`relative w-11 h-6 rounded-full transition-colors ${status?.mode === "live" ? "bg-red-500" : "bg-muted"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${status?.mode === "live" ? "translate-x-5" : ""}`} />
              </button>
              <span className={`text-xs font-medium ${status?.mode === "live" ? "text-red-400" : "text-muted-foreground"}`}>Live</span>
              {/* Live Kalshi balance badge — shown next to the toggle when in live mode */}
              {status?.mode === "live" && (kalshiBalanceData?.ok ? kalshiBalanceData.balance : status?.accountBalance) != null && (
                <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 ml-1" title="Kalshi account balance">
                  ${((kalshiBalanceData?.ok ? kalshiBalanceData.balance : status?.accountBalance) ?? 0).toFixed(2)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">

        {/* ── Stats Row ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              label: status?.mode === "live" ? "Kalshi Balance" : "Paper Balance",
              value: fmt$(status?.accountBalance), icon: DollarSign, color: "text-sky-400",
            },
            { label: `Today's P&L (${activeMode})`, value: fmt$(pnl), icon: pnl >= 0 ? TrendingUp : TrendingDown, color: pnl >= 0 ? "text-emerald-400" : "text-red-400", bold: true },
            { label: `Win Rate (${activeMode})`, value: `${winRate}%`, icon: Trophy, color: "text-violet-400" },
            { label: `Total Bets (${activeMode})`, value: `${stats?.totalBets ?? 0}`, sub: `${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`, icon: BarChart3, color: "text-amber-400" },
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

        {/* ── Paused Coins Banner ── */}
        {(Object.keys(pausedCoins).length > 0 || streakPausedCoins.length > 0 || (status?.circuitBreakerWindowsRemaining ?? 0) > 0) && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm flex-shrink-0">
              <Pause className="w-4 h-4" />
              Blocked coins
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(pausedCoins).map(([sym, windowsRemaining]) => (
                <span
                  key={`tune-${sym}`}
                  className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  title={`${sym} is paused by auto-tune for ${windowsRemaining} more 15-min window(s) (~${windowsRemaining * 15} min)`}
                >
                  {sym}
                  <span className="font-mono text-amber-400/70">· {windowsRemaining} {windowsRemaining === 1 ? "window" : "windows"} (tune)</span>
                </span>
              ))}
              {streakPausedCoins.map(({ sym, pauseUntilWindowKey, consecutiveLosses }) => {
                const utcTime = pauseUntilWindowKey.slice(11, 16);
                return (
                  <span
                    key={`streak-${sym}`}
                    className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/40"
                    title={`${sym} streak-paused after ${consecutiveLosses} consecutive losses — re-opens at window ${pauseUntilWindowKey} UTC`}
                  >
                    {sym}
                    <span className="font-mono text-orange-400/70">· until {utcTime} UTC ({consecutiveLosses}L streak)</span>
                  </span>
                );
              })}
              {(status?.circuitBreakerWindowsRemaining ?? 0) > 0 && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-500/20 text-red-300 border border-red-500/40">
                  CB: {status!.circuitBreakerWindowsRemaining} {status!.circuitBreakerWindowsRemaining === 1 ? "window" : "windows"} left
                </span>
              )}
            </div>
            <button
              className="ml-auto text-[11px] px-2.5 py-1 rounded-lg border border-amber-500/40 text-amber-400 hover:bg-amber-500/20 transition-colors"
              onClick={async () => {
                await authPost("/crypto/bot/clear-pauses", {});
                void qc.invalidateQueries({ queryKey: ["bot-status"] });
                void qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
              }}
            >
              Clear pauses now
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
                    { label: "Window", value: wkToEst(pos.windowKey) + " EST" },
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

        {/* ── Per-Coin Guard Status ── */}
        {coinGuardData && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center gap-2">
              <Shield className="w-4 h-4 text-sky-400" />
              <h2 className="font-semibold text-sm">Per-Coin Guard Status</h2>
              <span className="text-xs text-muted-foreground ml-auto">
                Daily cap: {fmt$(coinGuardData.maxDailyLossPerCoin)} / coin
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4">
              {coinGuardData.coins.map((coin) => {
                // Compute current window key with same formula as backend (YYYY-MM-DDTHH:mm UTC)
                const currentWK = new Date(Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000))
                  .toISOString().slice(0, 16);
                // Paused iff backend pause rule: currentWindowKey <= pauseUntilWindowKey (string compare)
                const isPaused = coin.pauseUntilWindowKey != null && currentWK <= coin.pauseUntilWindowKey;
                // windowsLeft: number of 15-min windows still paused (current window counts as 1)
                const windowsLeft = isPaused ? (() => {
                  const currentMs = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
                  const pauseMs = new Date(coin.pauseUntilWindowKey! + ":00Z").getTime();
                  return Math.max(1, Math.round((pauseMs - currentMs) / (15 * 60_000)) + 1);
                })() : 0;
                const lossPct = coinGuardData.maxDailyLossPerCoin > 0
                  ? Math.min(1, coin.dailyLoss / coinGuardData.maxDailyLossPerCoin)
                  : 0;
                const hasAnything = isPaused || coin.dailyLoss > 0 || coin.consecutiveLosses > 0 || coin.slippageStrikes > 0;
                return (
                  <div
                    key={coin.symbol}
                    className={`rounded-lg p-3 border ${isPaused ? "border-red-500/50 bg-red-950/20" : hasAnything ? "border-amber-500/30 bg-amber-950/10" : "border-border bg-background/30"}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm text-foreground">{coin.symbol}</span>
                      {isPaused ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 whitespace-nowrap">
                          Paused · {windowsLeft}w left
                        </span>
                      ) : (
                        <span className="text-[10px] text-emerald-500 font-medium">Active</span>
                      )}
                    </div>

                    {/* Daily loss bar */}
                    <div className="mb-2">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Daily loss</span>
                        <span className={coin.dailyLoss > 0 ? "text-red-400" : ""}>{fmt$(coin.dailyLoss)} / {fmt$(coinGuardData.maxDailyLossPerCoin)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${lossPct > 0.75 ? "bg-red-500" : lossPct > 0.4 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${(lossPct * 100).toFixed(1)}%` }}
                        />
                      </div>
                    </div>

                    {/* Badges row */}
                    <div className="flex flex-wrap gap-1">
                      {coin.consecutiveLosses > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                          {coin.consecutiveLosses} loss streak
                        </span>
                      )}
                      {coin.slippageStrikes > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">
                          {coin.slippageStrikes} slip {coin.slippageStrikes === 1 ? "strike" : "strikes"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Window Evaluation ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-sm">Market Selection — This Window</h2>
            {evaluation.length > 0 && (
              <span className="text-xs text-muted-foreground ml-auto">
                {wkToEst(evaluation[0]?.windowKey)} EST window
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
                      <td className="px-3 py-2.5"><CountdownCell reason={e.reason} windowKey={e.windowKey} /></td>
                      <td className="px-3 py-2.5">
                        {e.betPlacedThisWindow ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                            BET PLACED
                          </span>
                        ) : e.selected ? (
                          <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                        ) : null}
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

              {/* ── Bet Profile ── */}
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Zap className="w-3 h-3" />
                  Bet Profile
                </span>
                <div className="grid grid-cols-2 gap-3">
                  {((): Array<{ id: "normal" | "aggressive"; label: string; sublabel: string; bullets: string[]; color: string }> => {
                    const mode = merged.decisionMode ?? "classic";
                    const mlBullet = (thresh: number): string => {
                      if (mode === "ml_gate") return `ML vetos bets it opposes (≥${merged.mlVetoMinConfidence ?? 57}% threshold)`;
                      if (mode === "consensus") return `ML is 1 of 3 majority votes`;
                      if (mode === "unanimous") return `ML must agree with all signals`;
                      return `ML leads at ≥${thresh}% confidence`;
                    };
                    return [
                      {
                        id: "normal" as const,
                        label: "Normal",
                        sublabel: "Current proven defaults",
                        bullets: [mlBullet(62), "15pp regime penalty", "No confidence cap"],
                        color: "sky",
                      },
                      {
                        id: "aggressive" as const,
                        label: "Aggressive",
                        sublabel: "More bets per window",
                        bullets: [mlBullet(58), "10pp regime penalty", "Confidence capped at 80%"],
                        color: "amber",
                      },
                    ];
                  })().map(p => {
                    const isSelected = (merged.betProfile ?? "normal") === p.id;
                    const colorSelected = p.color === "sky"
                      ? "border-sky-500/60 bg-sky-500/10 ring-1 ring-sky-500/30"
                      : "border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30";
                    const labelColor = p.color === "sky" ? "text-sky-400" : "text-amber-400";
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, betProfile: p.id }))}
                        className={`text-left rounded-xl p-3.5 border transition-all ${
                          isSelected ? colorSelected : "border-border bg-background/30 hover:border-border/80 hover:bg-muted/30"
                        }`}
                      >
                        <div className={`text-sm font-semibold mb-0.5 ${isSelected ? labelColor : "text-foreground"}`}>
                          {p.label}
                          {isSelected && <span className="ml-1.5 text-[9px] opacity-70">✓ active</span>}
                        </div>
                        <div className="text-[10px] text-muted-foreground/70 mb-2">{p.sublabel}</div>
                        <ul className="space-y-0.5">
                          {p.bullets.map(b => (
                            <li key={b} className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                              <span className="opacity-40">·</span> {b}
                            </li>
                          ))}
                        </ul>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {/* Bet Size */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Bet Size ($)</span>
                  <input type="number" min={0.5} max={merged.maxBetSize ?? 2} step={0.5}
                    className={`bg-background border rounded-md px-3 py-1.5 text-sm text-foreground ${(merged.betSize ?? 1) > (merged.maxBetSize ?? 2) ? "border-red-500" : "border-border"}`}
                    value={merged.betSize ?? 1}
                    onChange={e => setConfigDraft(d => ({ ...d, betSize: parseFloat(e.target.value) }))} />
                  {(merged.betSize ?? 1) > (merged.maxBetSize ?? 2) && (
                    <span className="text-[10px] text-red-400">Exceeds max bet cap — bets will be blocked</span>
                  )}
                </label>

                {/* Max Bet Size (safety cap) */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="text-amber-400">⚠</span> Max Bet Cap ($)
                  </span>
                  <input type="number" min={0.5} max={100} step={0.5}
                    className="bg-background border border-amber-500/40 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxBetSize ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, maxBetSize: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Hard safety cap — any bet above this is blocked</span>
                </label>

                {/* ── Live Mode Guards ─────────────────────────────────── */}
                <div className="col-span-full border-t border-amber-500/20 pt-3 -mt-1">
                  <span className="text-xs font-semibold text-amber-400/90 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5" /> Live Mode Guards
                  </span>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">Active in live betting only — enforced before each trade</p>
                </div>

                {/* Min Account Balance */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Account Balance ($)</span>
                  <input type="number" min={0} max={1000} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minAccountBalance ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, minAccountBalance: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Abort live bet if Kalshi balance drops below this</span>
                </label>

                {/* Max Total Exposure */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Total Exposure ($)</span>
                  <input type="number" min={0} max={500} step={0.5}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxTotalExposure ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, maxTotalExposure: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Max total $ across all open positions at once</span>
                </label>

                {/* Max Daily Loss Per Coin */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Daily Loss / Coin ($)</span>
                  <input type="number" min={0} max={100} step={0.5}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxDailyLossPerCoin ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxDailyLossPerCoin: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Per-coin daily loss cap (0 = disabled)</span>
                </label>

                {/* Streak Loss Limit */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Streak Loss Limit (windows)</span>
                  <input type="number" min={0} max={10} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.coinStreakLossLimit ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, coinStreakLossLimit: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Consecutive losses before this coin pauses (0 = off)</span>
                </label>

                {/* Streak Pause Windows */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Streak Pause (windows)</span>
                  <input type="number" min={1} max={10} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.coinStreakPauseWindows ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, coinStreakPauseWindows: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">How many windows to skip after the streak limit fires</span>
                </label>

                {/* Max Slippage Cents */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Slippage (¢)</span>
                  <input type="number" min={0} max={50} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxSlippageCents ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, maxSlippageCents: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Fill vs expected price warning threshold (0 = off)</span>
                </label>
                {/* ──────────────────────────────────────────────────────── */}

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

                {/* ML Veto Threshold — only shown in ML Gate mode */}
                {(merged.decisionMode ?? "classic") === "ml_gate" && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Brain className="w-3 h-3 text-sky-400" />
                      ML Veto Threshold ({merged.mlVetoMinConfidence ?? 57}%)
                    </span>
                    <input type="range" min={50} max={70} step={1}
                      className="mt-1"
                      value={merged.mlVetoMinConfidence ?? 57}
                      onChange={e => setConfigDraft(d => ({ ...d, mlVetoMinConfidence: parseInt(e.target.value) }))} />
                    <span className="text-[10px] text-muted-foreground/60">
                      ML veto only fires when ML is ≥{merged.mlVetoMinConfidence ?? 57}% confident — below this the bet proceeds
                    </span>
                  </label>
                )}

                {/* Decision Mode — full-width row */}
                <div className="col-span-2 flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">Decision Logic</span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {([
                      { id: "classic",   label: "Classic",   desc: "Stat → Claude → ML cascade; ML boosts if it agrees" },
                      { id: "ml_gate",   label: "ML Gate",   desc: "Stat+Claude decide direction; ML vetos if it disagrees" },
                      { id: "consensus", label: "Consensus", desc: "≥2 of [Stat, Claude, ML] must agree on the same side" },
                      { id: "unanimous", label: "Unanimous", desc: "All 3 of [Stat, Claude, ML] must agree — highest conviction, fewest bets" },
                    ] as { id: DecisionMode; label: string; desc: string }[]).map(m => {
                      const isSelected = (merged.decisionMode ?? "classic") === m.id;
                      const needsML = m.id === "ml_gate" || m.id === "unanimous";
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, decisionMode: m.id }))}
                          className={`text-left rounded-xl p-3 border transition-all ${
                            isSelected
                              ? "border-sky-500/60 bg-sky-500/10 ring-1 ring-sky-500/30"
                              : "border-border bg-background/30 hover:border-border/80 hover:bg-muted/30"
                          }`}
                        >
                          <div className={`text-xs font-semibold mb-1 ${isSelected ? "text-sky-400" : "text-foreground"}`}>
                            {m.label}
                            {isSelected && <span className="ml-1.5 text-[9px] text-sky-400/70">✓ selected</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground/80 leading-tight">{m.desc}</div>
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
                </div>

                {/* Mode preset — save current config as a recall point for this mode */}
                <div className="col-span-2 flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Mode Preset</span>
                    <button
                      type="button"
                      disabled={savingPreset}
                      onClick={savePreset}
                      className="text-[10px] px-2.5 py-1 rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors disabled:opacity-50"
                    >
                      {savingPreset ? "Saving…" : `Save as ${(merged.decisionMode ?? "classic")} preset`}
                    </button>
                  </div>
                  {presetMsg && (
                    <span className={`text-[10px] ${presetMsg.includes("✓") ? "text-emerald-400" : "text-yellow-400"}`}>{presetMsg}</span>
                  )}
                  {(() => {
                    const dm = merged.decisionMode ?? "classic";
                    const p = presetsData?.presets?.[dm] as Record<string, unknown> | undefined;
                    if (!p) return (
                      <p className="text-[9px] text-muted-foreground/50">No preset saved for <span className="font-medium">{dm}</span> yet. Configure settings and save to auto-apply on next mode switch.</p>
                    );
                    return (
                      <p className="text-[9px] text-muted-foreground/60">
                        Preset saved for <span className="font-medium text-sky-400/80">{dm}</span> — auto-applied when you switch to this mode.
                        {typeof p.minConfidence === "number" && ` Min conf: ${p.minConfidence}%.`}
                        {typeof p.betSize === "number" && ` Bet: $${p.betSize}.`}
                      </p>
                    );
                  })()}
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
                    value={merged.maxBetsPerWindow ?? 8}
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
                    Proximity Threshold — {((merged.borderProximityPct ?? 3.0)).toFixed(1)}% of strike
                  </span>
                  <input
                    type="range" min={0.1} max={5.0} step={0.1}
                    value={merged.borderProximityPct ?? 3.0}
                    onChange={e => setConfigDraft(d => ({ ...d, borderProximityPct: parseFloat(e.target.value) }))}
                    className="w-full accent-amber-500"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0.1% (tight)</span><span>5.0% (wide)</span>
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

                {/* Window Monitor Readiness Gate */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Window Monitor Ready Gate</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, requireMonitorReady: !(merged.requireMonitorReady ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.requireMonitorReady ?? true) ? "bg-violet-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.requireMonitorReady ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.requireMonitorReady ?? true) ? "text-violet-400" : "text-muted-foreground"}`}>
                      {(merged.requireMonitorReady ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
                    Defers entry until the window monitor has ≥2 min of intra-window data. First 2 ticks (~0–1 min) are skipped; bets start at minute 2. Recommended: ON.
                  </span>
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
              <span className={`ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${activeMode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"}`}>{activeMode}</span>
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
            {/* Paper / Live tab — independent of the bot's active mode so the user
                can always browse either log regardless of which mode the bot is in. */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-medium ml-1">
              {(["paper", "live"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => { setHistoryMode(m); setHistPage(0); }}
                  className={`px-2.5 py-1 transition-colors capitalize ${historyMode === m ? (m === "live" ? "bg-red-500/20 text-red-300" : "bg-yellow-500/15 text-yellow-300") : "text-muted-foreground hover:text-foreground"}`}
                >
                  {m}
                </button>
              ))}
            </div>
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

                      <div className={`rounded-lg p-2.5 col-span-1 ${pnlNum == null ? "bg-background/40" : pnlNum > 0 ? "bg-emerald-500/10" : pnlNum < 0 ? "bg-red-500/10" : "bg-background/40"}`}>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">P&L</div>
                        <div className={`text-sm font-bold font-mono ${pnlNum == null ? "text-foreground" : pnlNum >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pnlNum != null ? (pnlNum >= 0 ? "+" : "") + fmt$(pnlNum) : "—"}
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
                      <span className="font-mono">{wkToEst(r.windowKey)} EST</span>
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
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win Rate by Hour Band (EST)</div>
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
                                  <div className="text-[9px] font-mono mb-0.5">{bandToEst(b.band)}</div>
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
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Day of Week</div>
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
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Hour of Day (EST)</div>
                            {bestHour?.betCount >= 3 && bestHour.winRate !== null && (
                              <span className="text-[10px] text-emerald-400 font-medium">
                                Best: {new Date(Date.UTC(2000,0,1,(bestHour.hour))).toLocaleTimeString("en-US",{hour:"numeric",hour12:true,timeZone:EST})} EST ({Math.round(bestHour.winRate * 100)}%)
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
                                <div key={h.hour} className="flex-1 flex flex-col items-center gap-px" title={`${new Date(Date.UTC(2000,0,1,h.hour)).toLocaleTimeString("en-US",{hour:"numeric",hour12:true,timeZone:EST})} EST — ${h.betCount} bets${h.betCount > 0 ? `, ${Math.round(wr*100)}% WR` : ""}`}>
                                  <div className="w-full flex items-end" style={{ height: 52 }}>
                                    <div className={`w-full rounded-sm ${color}`} style={{ height: barH }} />
                                  </div>
                                  {h.hour % 6 === 0 && (
                                    <div className="text-[8px] text-muted-foreground/60">{new Date(Date.UTC(2000,0,1,h.hour)).toLocaleTimeString("en-US",{hour:"numeric",hour12:true,timeZone:EST}).replace(":00","")}</div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex justify-between text-[8px] text-muted-foreground/40 mt-0.5 px-px">
                            <span>7PM</span><span>1AM</span><span>7AM</span><span>1PM</span><span>6PM</span>
                          </div>
                          <div className="text-[9px] text-muted-foreground/50 mt-1">Hover bars for detail · Labels every 6 hours (EST) · Faded = &lt;2 bets</div>
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
                      Last computed: {r.computedAt ? new Date(r.computedAt).toLocaleString("en-US", { timeZone: EST, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}
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
                            {new Date(entry.createdAt).toLocaleString("en-US", { timeZone: EST, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}
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
