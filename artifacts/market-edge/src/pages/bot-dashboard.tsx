import { useState, useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign,
  BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus,
  Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders,
  ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

import type { BotStatus, BotConfig, HistoryRecord, LogicModeStats, BacktestModeStats, AutoTuneLogEntry, BotStats, PerformanceReport, CoinGuardState, OpenPosition, WindowEval, BotConditionsSnapshot, BotStepEntry, ConvictionThresholdData, ScalpOrder } from "./bot/types";
import { API_BASE, fmt$, fmtPct, fmtCrypto, wkToEst, utcToEst, ET_LABEL } from "./bot/utils";
import { ConditionsPanel, ClearPausesButton } from "./bot/conditions-panel";
import { BotHeader } from "./bot/bot-header";
import { GoLiveModal } from "./bot/go-live-modal";
import { ActivePositions } from "./bot/active-positions";
import { PerCoinGuard } from "./bot/per-coin-guard";
import { WindowEvalTable } from "./bot/window-eval-table";
import { BotConfigSection } from "./bot/bot-config-section";
import { LogicModePerf } from "./bot/logic-mode-perf";
import { TransactionLog } from "./bot/transaction-log";
import { PerformanceInsights } from "./bot/performance-insights";
import { TimingAnalytics, type TimeAnalyticsRow } from "./bot/timing-analytics";
import { BotEntryTimingPanel, type BotEntryTimingRow } from "./bot/bot-entry-timing-panel";
import { AutoTuneHistory } from "./bot/autotune-history";
import { ManualOrderModal } from "./bot/manual-order-modal";
import { BotStepsPanel } from "./bot/bot-steps";
import { CoinSignalBoard } from "./bot/coin-signal-board";
import { KalshiLiveTickerPanel } from "./bot/kalshi-live-ticker-panel";
import { ConvictionThresholdPanel } from "./bot/conviction-threshold-panel";
import { GapAnalyticsPanel } from "./bot/gap-analytics-panel";
import { BotScalperPanel } from "./bot/bot-scalper-panel";
import { BotSmartExitPanel } from "./bot/bot-smart-exit-panel";
import { BotRegularIntentPanel } from "./bot/bot-regular-intent-panel";
import { PnlWhatIfCalculator } from "./bot/pnl-what-if-calculator";
import { normalizeScalpOrders } from "./bot/scalper-ledger";
import { readApiResponse } from "./bot/api-response";
import type { GapAnalyticsResult } from "./bot/types";
function ResetPnlButton({ resetAt, onReset }: { resetAt: string | null; onReset: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleReset() {
    setResetting(true);
    try {
      await onReset();
      setDone(true);
      setTimeout(() => { setDone(false); setConfirming(false); }, 3000);
    } finally {
      setResetting(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-4 py-2">
        <CheckCircle2 className="w-3.5 h-3.5" />
        P&L display reset — showing $0 from now. All history preserved.
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={() => setConfirming(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Reset P&L display
        </button>
        {resetAt && (
          <span className="text-[10px] text-muted-foreground">
            (showing bets since {new Date(resetAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2">
      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
      <span className="text-xs text-amber-300">
        Today's P&L tile will show $0 from this moment. No bets are deleted.
      </span>
      <button
        onClick={handleReset}
        disabled={resetting}
        className="ml-auto text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 px-3 py-1 rounded disabled:opacity-50 transition-colors"
      >
        {resetting ? "Resetting…" : "Confirm Reset"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function ResetLiveStatsButton({ resetAt, onReset }: { resetAt: string | null; onReset: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleReset() {
    setResetting(true);
    try {
      await onReset();
      setDone(true);
      setTimeout(() => { setDone(false); setConfirming(false); }, 3000);
    } finally {
      setResetting(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-4 py-2">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Stats reset — tracking fresh from now. All historical data preserved.
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={() => setConfirming(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Reset live stats display
        </button>
        {resetAt && (
          <span className="text-[10px] text-muted-foreground">
            (showing bets since {new Date(resetAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2">
      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
      <span className="text-xs text-amber-300">
        Win/loss %, profit, and history will show only bets from now on. No data is deleted.
      </span>
      <button
        onClick={handleReset}
        disabled={resetting}
        className="ml-auto text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 px-3 py-1 rounded disabled:opacity-50 transition-colors"
      >
        {resetting ? "Resetting…" : "Confirm Reset"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function PerfByCoin({ stats, activeMode }: { stats: BotStats; activeMode: "paper" | "live" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 sm:px-5 py-3 border-b border-border flex flex-wrap items-center gap-2 hover:bg-muted/20 transition-colors text-left"
      >
        <Activity className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold text-sm">Performance by Coin</h2>
        <span className={`ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${activeMode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"}`}>{activeMode}</span>
        <span className="ml-auto">{open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}</span>
      </button>
      {open && (
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                {["Coin", "Bets", "Wins", "Losses", "Win Rate", "P&L"].map(h => (
                  <th key={h} className="px-5 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.bySymbol.map(row => (
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
      )}
    </div>
  );
}

export default function BotDashboard() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [liveCheckboxChecked, setLiveCheckboxChecked] = useState(false);
  const [configDraft, setConfigDraft] = useState<Partial<BotConfig>>({});
  const [saving, setSaving] = useState(false);
  const [persistMsg, setPersistMsg] = useState<"saved" | "failed" | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [perfOpen, setPerfOpen] = useState(false);
  const [tuneLogOpen, setTuneLogOpen] = useState(false);
  const [histPage, setHistPage] = useState(0);
  // historyMode is the mode shown in the Transaction History table and stats.
  // Defaults to the active bot mode but can be toggled independently so the
  // user can browse paper history while live or vice versa.
  const [historyMode, setHistoryMode] = useState<"paper" | "live">("paper");
  const [histSourceFilter, setHistSourceFilter] = useState<"all" | "bot" | "manual" | "scalper" | "skips">("all");
  const [reEvalState, setReEvalState] = useState<{ loading: boolean; msg: string | null; ok: boolean }>({ loading: false, msg: null, ok: false });

  // ── Close manual position state ──────────────────────────────────────────
  const [closingManualSym, setClosingManualSym] = useState<string | null>(null);
  const [closeManualError, setCloseManualError] = useState<string | null>(null);

  async function closeManualPos(symbol: string) {
    if (closingManualSym) return;
    setClosingManualSym(symbol);
    setCloseManualError(null);
    try {
      const data = await authPost("/crypto/bot/close-manual-position", { symbol }) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setCloseManualError(data.error ?? "Close failed");
        setTimeout(() => setCloseManualError(null), 6000);
      } else {
        qc.invalidateQueries({ queryKey: ["bot-status"] });
        qc.invalidateQueries({ queryKey: ["bot-all-history"] });
      }
    } catch (err) {
      setCloseManualError(err instanceof Error ? err.message : "Network error — please try again");
      setTimeout(() => setCloseManualError(null), 6000);
    } finally {
      setClosingManualSym(null);
    }
  }

  // ── Manual order modal state ─────────────────────────────────────────────
  const [manualOrderSym, setManualOrderSym] = useState<string | null>(null);
  const [manualDir, setManualDir] = useState<"yes" | "no">("yes");
  const [manualBetSize, setManualBetSize] = useState<string>("");
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualToast, setManualToast] = useState<{ ok: boolean; msg: string } | null>(null);

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

  const historyKind = histSourceFilter === "skips" ? "skips" : "transactions";
  const {
    data: historyData,
    isLoading: historyLoading,
    isError: historyError,
  } = useQuery<{ history: HistoryRecord[] }>({
    queryKey: ["bot-all-history", historyMode, historyKind],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/all-history?limit=500&mode=${historyMode}&kind=${historyKind}`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  const { data: scalpHistoryData } = useQuery<{ orders: ScalpOrder[] }>({
    queryKey: ["bot-scalper-history", "all"],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/history?limit=500`).then(r => r.json()),
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

  const { data: dailyPnlData, isError: dailyPnlError } = useQuery<{
    mode: "paper" | "live";
    timeZone: "America/New_York";
    asOf: string;
    dayStartAt: string;
    nextResetAt: string;
    regularPnl: number;
    scalperPnl: number;
    totalPnl: number;
  }>({
    queryKey: ["bot-daily-pnl", activeMode],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/crypto/bot/daily-pnl?mode=${activeMode}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? "Unable to load authoritative daily P&L");
      }
      return body;
    },
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const { data: evalData } = useQuery<{ evaluation: WindowEval[] }>({
    queryKey: ["bot-window-eval"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/window-eval`).then(r => r.json()),
    refetchInterval: 3_000,
  });

  const { data: conditionsData } = useQuery<BotConditionsSnapshot>({
    queryKey: ["bot-conditions"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/conditions`).then(r => r.json()),
    refetchInterval: 5_000,
  });

  const { data: perfReportData } = useQuery<{ report: PerformanceReport | null; pausedCoins: Record<string, number> }>({
    queryKey: ["bot-performance-report", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/performance-report?mode=${activeMode}`).then(r => r.json()),
    refetchInterval: 5 * 60_000,
  });

  const { data: timeAnalyticsData } = useQuery<{ rows: TimeAnalyticsRow[]; totalBets: number; lastUpdated: string }>({
    queryKey: ["bot-time-analytics"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/time-analytics`).then(r => r.json()),
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
  });

  const { data: botEntryTimingData, isLoading: botEntryTimingLoading } = useQuery<BotEntryTimingRow[]>({
    queryKey: ["bot-entry-timing"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/entry-timing`).then(r => r.json()),
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
  });

  const { data: gapAnalyticsData } = useQuery<GapAnalyticsResult>({
    queryKey: ["bot-gap-analytics", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/gap-analytics?mode=${activeMode}`).then(r => r.json()),
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
  });

  const { data: autoTuneLogData } = useQuery<{ entries: AutoTuneLogEntry[] }>({
    queryKey: ["bot-auto-tune-log"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/auto-tune-log`).then(r => r.json()),
    refetchInterval: 60_000,
  });

  const { data: logicPerfData } = useQuery<{ modes: LogicModeStats[] }>({
    queryKey: ["bot-logic-performance", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/logic-performance?mode=${activeMode}`).then(r => r.json()),
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

  const { data: modeDefaultsData } = useQuery<{ defaults: Partial<Record<string, object>> }>({
    queryKey: ["bot-mode-defaults"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/config/mode-defaults`).then(r => r.json()),
    staleTime: Infinity,
  });

  const { data: backtestData } = useQuery<{ modes: BacktestModeStats[] }>({
    queryKey: ["bot-backtest-modes"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/backtest-modes`).then(r => r.json()),
    refetchInterval: 10 * 60_000,
  });

  const { data: convictionThresholdData } = useQuery<ConvictionThresholdData>({
    queryKey: ["bot-conviction-threshold", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/conviction-threshold-analysis?mode=${activeMode}`).then(r => r.json()),
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
  });

  const { data: coinGuardData } = useQuery<CoinGuardState>({
    queryKey: ["bot-coin-guard-state", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/coin-guard-state?mode=${activeMode}`).then(r => r.json()),
    refetchInterval: 10_000,
  });

  const { data: pipelineStatusData } = useQuery<{
    liveSignals?: Record<string, import("./bot/types").CoinSignals>;
    kalshiTargets?: Record<string, number | null>;
    currentWindowKey?: string | null;
    botSteps?: BotStepEntry[];
    minConfidence?: number;
    decisionMode?: string;
    coinStability?: Record<string, import("./bot/types").CoinStabilityResult>;
    coinTrajectory?: Record<string, import("./bot/types").TrajectoryGateResult>;
    extremeCautionAborted?: string[];
    convictionDirectionBlocked?: Record<string, { direction: "yes" | "no"; advisory?: boolean; gate: "tick" | "candle-decline" | "candle-rise" | "no-data"; evidenceClass?: "unavailable" | "adverse" | "clear"; reason?: string | null; slopePct?: number; effectiveThreshold?: number; lookback?: number; fromPrice?: number; toPrice?: number }>;
    activeScheduleBracket?: { minutesElapsed: number; betAmount: number } | null;
  }>({
    queryKey: ["bot-pipeline-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/pipeline-status`).then(r => r.json()),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });

  // Live Kalshi prices for the manual order modal — polls every 5s while modal is open
  const { data: manualOrderKalshiData } = useQuery<{
    target: number | null;
    ticker: string | null;
    yesPrice: number | null;
    yesAsk: number | null;
    yesBid: number | null;
  }>({
    queryKey: ["manual-order-kalshi", manualOrderSym],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/crypto/kalshi-target?symbol=${manualOrderSym}`);
      return r.json();
    },
    enabled: manualOrderSym !== null,
    refetchInterval: 5_000,
    staleTime: 0,
  });

  const [btPerfTab, setBtPerfTab] = useState<"live" | "backtest">("live");
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);

  // ── Mutations ────────────────────────────────────────────────────────────
  async function postAuthenticated(path: string, body: object, strictErrors: boolean) {
    const token = await getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = strictErrors ? await readApiResponse(res) : await res.json();
    if (path.startsWith("/crypto/bot/")) {
      await qc.invalidateQueries({ queryKey: ["bot-status"] });
    }
    return data;
  }

  async function authPost(path: string, body: object) {
    return postAuthenticated(path, body, false);
  }

  async function scalperAuthPost(path: string, body: object) {
    return postAuthenticated(path, body, true);
  }

  async function submitManualOrder() {
    if (!manualOrderSym || manualSubmitting) return;
    setManualSubmitting(true);
    try {
      const token = await getToken();
      const betSizeNum = parseFloat(manualBetSize);
      const body: Record<string, unknown> = {
        symbol: manualOrderSym,
        direction: manualDir,
        mode: activeMode,
      };
      if (!isNaN(betSizeNum) && betSizeNum > 0) body.betSize = betSizeNum;
      const resp = await fetch(`${API_BASE}/crypto/bot/manual-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json() as { ok?: boolean; error?: string; fillPrice?: number; contractCount?: number; betAmount?: number; pnlProjected?: number };
      if (!resp.ok || data.error) {
        setManualToast({ ok: false, msg: data.error ?? "Order failed" });
      } else {
        const fp = data.fillPrice != null ? `${(data.fillPrice * 100).toFixed(0)}¢` : "—";
        const contracts = data.contractCount ?? "?";
        const payout = data.pnlProjected != null ? `$${data.pnlProjected.toFixed(2)}` : "—";
        setManualToast({
          ok: true,
          msg: `Filled ${contracts} contract${contracts === 1 ? "" : "s"} at ${fp} — projected win: ${payout}`,
        });
        setManualOrderSym(null);
        void qc.invalidateQueries({ queryKey: ["bot-status"] });
        void qc.invalidateQueries({ queryKey: ["bot-all-history"] });
      }
    } catch {
      setManualToast({ ok: false, msg: "Network error — please try again" });
    } finally {
      setManualSubmitting(false);
      setTimeout(() => setManualToast(null), 6000);
    }
  }

  function openManualOrder(sym: string) {
    setManualOrderSym(sym);
    setManualDir("yes");
    setManualBetSize(String(status?.config?.betSize ?? "1"));
    setManualToast(null);
  }

  async function togglePause() {
    await authPost("/crypto/bot/pause", { paused: !status?.paused });
  }

  async function runReEvalQuick() {
    if (reEvalState.loading) return;
    setReEvalState({ loading: true, msg: null, ok: false });
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
      const data = await authPost(`/crypto/bot/re-evaluate-bets?since=${encodeURIComponent(since)}&limit=500`, {}) as { ok?: boolean; checked?: number; corrected?: number; error?: string };
      if (data.ok) {
        const msg = data.corrected
          ? `Fixed ${data.corrected} bet${data.corrected > 1 ? "s" : ""} (checked ${data.checked})`
          : `All ${data.checked} bets correct`;
        setReEvalState({ loading: false, msg, ok: true });
        if (data.corrected) {
          void qc.invalidateQueries({ queryKey: ["bot-all-history"] });
          void qc.invalidateQueries({ queryKey: ["bot-stats"] });
          void qc.invalidateQueries({ queryKey: ["bot-performance-report"] });
          void qc.invalidateQueries({ queryKey: ["gap-analytics"] });
        }
      } else {
        setReEvalState({ loading: false, msg: data.error ?? "Unknown error", ok: false });
      }
    } catch {
      setReEvalState({ loading: false, msg: "Request failed", ok: false });
    }
    setTimeout(() => setReEvalState(s => ({ ...s, msg: null })), 8000);
  }

  async function setMode(mode: "paper" | "live") {
    await authPost("/crypto/bot/mode", { mode });
    setConfirmLive(false);
  }

  async function saveConfig() {
    setSaving(true);
    setPersistError(null);
    try {
      const result = await authPost("/crypto/bot/config", configDraft) as {
        ok?: boolean;
        persisted?: boolean;
        config?: BotConfig;
        error?: string;
      };
      if (result.ok === false || result.error || result.persisted !== true || !result.config) {
        setPersistMsg("failed");
        setPersistError(result.error ?? "Settings were not persisted. Your changes are still available to retry.");
        setTimeout(() => {
          setPersistMsg(null);
          setPersistError(null);
        }, 5000);
        return;
      }
      // Make the canonical persisted config visible immediately. The subsequent
      // invalidation remains the freshness path for fields changed by other
      // actors, but it no longer creates a stale flash after this save.
      qc.setQueryData<BotStatus>(["bot-status"], current => (
        current ? { ...current, config: result.config! } : current
      ));
      setConfigDraft({});
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bot-status"] }),
        qc.invalidateQueries({ queryKey: ["bot-coin-guard-state"] }),
      ]);
      setPersistMsg("saved");
      setTimeout(() => setPersistMsg(null), 3000);
    } catch (err) {
      setPersistMsg("failed");
      setPersistError(err instanceof Error ? err.message : "Request failed");
      setTimeout(() => setPersistMsg(null), 4000);
      console.error("[saveConfig] failed:", err);
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
  const normalizedScalps = normalizeScalpOrders(scalpHistoryData?.orders ?? []);
  const regularHistory = historyData?.history ?? [];
  const history = [
    ...regularHistory,
    ...normalizedScalps.history.filter(record => record.mode === historyMode),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const bets = history.filter(r => {
    const isSkipAction = r.action === "skip";

    // "skips" tab: only gate-skip records
    if (histSourceFilter === "skips") return isSkipAction;

    // All other tabs: only real bet lifecycle actions — skips go in their own tab
    const allowed = r.action === "bet" || r.action === "exit" || r.action === "late_recovery_exit" || r.action === "expired";
    if (!allowed) return false;

    if (histSourceFilter === "manual") {
      return r.source === "manual" || (r.signals as Record<string, unknown> | null)?.manual === true;
    }
    if (histSourceFilter === "scalper") return r.source === "scalper";
    if (histSourceFilter === "bot") {
      return r.source !== "manual"
        && r.source !== "scalper"
        && (r.signals as Record<string, unknown> | null)?.manual !== true;
    }
    return true; // "all"
  });

  const HIST_PAGE_SIZE = 20;
  const totalHistPages = Math.max(1, Math.ceil(bets.length / HIST_PAGE_SIZE));
  const clampedHistPage = Math.min(histPage, totalHistPages - 1);
  const pagedBets = bets.slice(clampedHistPage * HIST_PAGE_SIZE, (clampedHistPage + 1) * HIST_PAGE_SIZE);
  const evaluation = evalData?.evaluation ?? [];
  const stats = statsData;
  const regularOpenPosList = status?.openPositions ?? [];
  const openPosList = [...regularOpenPosList, ...normalizedScalps.positions];
  const pnl = dailyPnlData?.totalPnl ?? 0;
  const pnlUpdatedLabel = dailyPnlData?.asOf
    ? `Updated ${new Date(dailyPnlData.asOf).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "America/New_York",
      })} ET`
    : dailyPnlError
      ? "Authoritative total unavailable"
      : "Loading authoritative total…";
  const winRate = (stats?.totalBets ?? 0) > 0 ? Math.round((stats!.wins / stats!.totalBets) * 100) : 0;

  const statusLabel = () => {
    if (!status) return "Loading…";
    if (merged.enabled === false) return "Disabled"; // only explicitly false = disabled; undefined/null = running
    if (status.paused) return "Paused";
    if (status.warmupSecondsRemaining !== null) return `Warming up · ${status.warmupSecondsRemaining}s`;
    if (openPosList.length > 0) return openPosList.length === 1 ? "Position Open" : `${openPosList.length} Positions Open`;
    if (status.status === "daily_limit_hit") return "Daily Limit Hit";
    return "Watching Markets";
  };

  const tuneEntries = autoTuneLogData?.entries ?? [];
  const tuneCount = tuneEntries.length;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Exclude synthetic cooldown-guard entries written by "Reset all" / "Clear pauses" — those
  // have newValue "user_reset" or "user_cleared" and are NOT real auto-tune events.
  const recentTuneEntry = tuneEntries.find(e =>
    new Date(e.createdAt).getTime() > oneHourAgo &&
    e.newValue !== "user_cleared" &&
    e.newValue !== "user_reset"
  ) ?? null;
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
    <div className="flex w-full min-w-0 max-w-full flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-background">
      <BotHeader
        status={status}
        openPosList={openPosList}
        statusLabel={statusLabel()}
        cfg={cfg}
        merged={merged}
        confirmLive={confirmLive}
        recentTuneEntry={recentTuneEntry}
        kalshiBalanceData={kalshiBalanceData}
        pnl={pnl}
        togglePause={togglePause}
        setConfirmLive={setConfirmLive}
        setMode={setMode}
      />
      <GoLiveModal
        confirmLive={confirmLive}
        setConfirmLive={setConfirmLive}
        liveCheckboxChecked={liveCheckboxChecked}
        setLiveCheckboxChecked={setLiveCheckboxChecked}
        status={status}
        preflightLoading={preflightLoading}
        kalshiPreflightData={kalshiPreflightData}
        merged={merged}
        setMode={setMode}
      />
      <div className="w-full min-w-0 flex-1 p-3 sm:p-6 space-y-4 sm:space-y-6">
        {/* ── Stats Row ── */}
        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
          {[
            {
              label: status?.mode === "live" ? "Kalshi Balance" : "Paper Balance",
              value: fmt$(status?.accountBalance), icon: DollarSign, color: "text-sky-400",
            },
            {
              label: `Today's P&L (${activeMode})`,
              value: dailyPnlData ? fmt$(pnl) : dailyPnlError ? "Unavailable" : "Loading…",
              sub: pnlUpdatedLabel,
              icon: pnl >= 0 ? TrendingUp : TrendingDown,
              color: dailyPnlData ? (pnl >= 0 ? "text-emerald-400" : "text-red-400") : "text-amber-400",
              bold: true,
            },
            { label: `Win Rate (${activeMode})`, value: `${winRate}%`, icon: Trophy, color: "text-violet-400" },
            { label: `Total Bets (${activeMode})`, value: `${stats?.totalBets ?? 0}`, sub: `${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`, icon: BarChart3, color: "text-amber-400" },
          ].map(({ label, value, sub, icon: Icon, color, bold }) => (
            <div key={label} className="min-w-0 bg-card border border-border rounded-lg p-3 sm:p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 shrink-0 ${color}`} />
                <span className="min-w-0 text-xs leading-tight text-muted-foreground">{label}</span>
              </div>
              <div className={`text-xl font-bold ${bold ? (pnl >= 0 ? "text-emerald-400" : "text-red-400") : "text-foreground"}`}>{value}</div>
              {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
            </div>
          ))}
        </div>
        {/* ── Reset Live Stats ── */}
        {activeMode === "live" && (
          <ResetLiveStatsButton
            resetAt={cfg?.liveStatsResetAt ?? null}
            onReset={async () => {
              await authPost("/crypto/bot/reset-live-stats", {});
              void qc.invalidateQueries({ queryKey: ["bot-status"] });
              void qc.invalidateQueries({ queryKey: ["bot-stats"] });
              void qc.invalidateQueries({ queryKey: ["bot-all-history"] });
              void qc.invalidateQueries({ queryKey: ["bot-performance-report"] });
            }}
          />
        )}
        {/* ── Reset P&L display ── */}
        <ResetPnlButton
          resetAt={activeMode === "live" ? (cfg?.livePnlResetAt ?? null) : (cfg?.paperPnlResetAt ?? null)}
          onReset={async () => {
            await authPost("/crypto/bot/reset-daily-pnl", {});
            void qc.invalidateQueries({ queryKey: ["bot-daily-pnl", activeMode] });
            void qc.invalidateQueries({ queryKey: ["bot-status"] });
          }}
        />


        {/* ── Paused Coins Banner ── */}
        {(Object.keys(pausedCoins).length > 0 || streakPausedCoins.length > 0 || (status?.circuitBreakerWindowsRemaining ?? 0) > 0) && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 sm:px-5 py-3 flex flex-wrap items-start sm:items-center gap-3">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm flex-shrink-0">
              <Pause className="w-4 h-4" />
              Blocked coins
            </div>
            <div className="min-w-0 flex flex-1 flex-wrap gap-2">
              {Object.entries(pausedCoins).map(([sym, windowsRemaining]) => (
                <span
                  key={`tune-${sym}`}
                  className="max-w-full flex flex-wrap items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40"
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
                    className="max-w-full flex flex-wrap items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/40"
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
            <ClearPausesButton />
          </div>
        )}

        <PnlWhatIfCalculator
          mode={activeMode}
          isProduction={status?.isProductionEnv ?? false}
        />
        <ConditionsPanel
          conditions={conditionsData}
          evaluation={evalData?.evaluation ?? []}
          status={status}
        />
        <KalshiLiveTickerPanel />

        {pipelineStatusData?.liveSignals && (
          <CoinSignalBoard
            liveSignals={pipelineStatusData.liveSignals}
            kalshiTargets={pipelineStatusData.kalshiTargets ?? {}}
            windowKey={pipelineStatusData.currentWindowKey ?? null}
            decisionMode={pipelineStatusData.decisionMode ?? null}
            coinStability={pipelineStatusData.coinStability}
            coinTrajectory={pipelineStatusData.coinTrajectory}
            stabilityConfig={{
              minER:                  status?.config?.convictionStabilityMinER,
              maxOsc:                 status?.config?.convictionStabilityMaxOsc,
              maxVolPct:              status?.config?.convictionStabilityMaxVolPct,
              minMLConf:              status?.config?.convictionStabilityMinMLConf,
              strikeProximityMinPct:          status?.config?.strikeProximityMinPct,
              strikeProximityAtrScale:        status?.config?.strikeProximityAtrScale,
              strikeProximityMinPctOverrides: status?.config?.strikeProximityMinPctOverrides,
            }}
            trajectoryConfig={{
              dangerBandPct: status?.config?.maxBetTrajectoryDangerBandPct,
            }}
            maxBetMinWindowEntryMinutes={status?.config?.maxBetMinWindowEntryMinutes}
            extremeCautionAborted={pipelineStatusData.extremeCautionAborted}
            convictionDirectionBlocked={pipelineStatusData.convictionDirectionBlocked}
            activeScheduleBracket={pipelineStatusData.activeScheduleBracket}
          />
        )}
        {pipelineStatusData?.decisionMode !== "conviction" && (
          <BotStepsPanel
            steps={pipelineStatusData?.botSteps ?? []}
            minConfidence={pipelineStatusData?.minConfidence ?? null}
            decisionMode={pipelineStatusData?.decisionMode ?? null}
            windowKey={pipelineStatusData?.currentWindowKey ?? null}
          />
        )}
        <ActivePositions
          openPosList={openPosList}
          closeManualError={closeManualError}
          closingManualSym={closingManualSym}
          closeManualPos={closeManualPos}
          openManualOrder={openManualOrder}
        />
        <PerCoinGuard coinGuardData={coinGuardData} />
        <WindowEvalTable evaluation={evaluation} openPosList={regularOpenPosList} openManualOrder={openManualOrder} />
        <BotRegularIntentPanel authPost={authPost} getToken={getToken} />
        <BotScalperPanel authPost={scalperAuthPost} />
        <BotSmartExitPanel authPost={authPost} />
        <BotConfigSection
          cfg={cfg}
          merged={merged}
          configDraft={configDraft}
          setConfigDraft={setConfigDraft}
          saving={saving}
          saveConfig={saveConfig}
          persistMsg={persistMsg}
           persistError={persistError}
          status={status}
          activeMode={activeMode}
          presetsData={presetsData}
          modeDefaults={modeDefaultsData?.defaults}
          savingPreset={savingPreset}
          savePreset={savePreset}
          presetMsg={presetMsg}
          backtestData={backtestData}
          configOpen={configOpen}
          setConfigOpen={setConfigOpen}
          authPost={authPost}
          qc={qc}
        />
        <LogicModePerf
          logicPerfData={logicPerfData}
          backtestData={backtestData}
          btPerfTab={btPerfTab}
          setBtPerfTab={setBtPerfTab}
          activeMode={activeMode}
        />
        {(merged?.decisionMode === "conviction" || (convictionThresholdData?.totalBets ?? 0) > 0) && (
          <ConvictionThresholdPanel
            data={convictionThresholdData}
            currentLockPrice={merged?.kalshiLockPrice}
            activeMode={activeMode}
            maxBetStats={perfReportData?.report?.maxBetStats}
            convictionPollerRunning={merged?.decisionMode === "conviction" ? status?.convictionPollerRunning : undefined}
            convictionPriceAgeMs={merged?.decisionMode === "conviction" ? status?.convictionPriceAgeMs : undefined}
          />
        )}
        {/* ── Per-Coin Stats ── */}
        {(stats?.bySymbol?.length ?? 0) > 0 && (
          <PerfByCoin stats={stats!} activeMode={activeMode} />
        )}


        <GapAnalyticsPanel
          data={gapAnalyticsData}
          activeMode={activeMode}
        />

        {/* ── Re-evaluate settled bets ── */}
        <div className="flex items-center gap-3 px-1">
          <button
            onClick={runReEvalQuick}
            disabled={reEvalState.loading}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-sky-500/40 hover:bg-sky-500/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {reEvalState.loading
              ? <RefreshCw className="w-3 h-3 animate-spin" />
              : <RotateCcw className="w-3 h-3" />}
            Re-evaluate Settled Bets
          </button>
          {reEvalState.msg && (
            <span className={`text-xs ${reEvalState.ok ? "text-emerald-400" : "text-amber-400"}`}>
              {reEvalState.ok ? "✓ " : "⚠ "}{reEvalState.msg}
            </span>
          )}
        </div>

        <TransactionLog
          pagedBets={pagedBets}
          histPage={clampedHistPage}
          setHistPage={setHistPage}
          totalHistPages={totalHistPages}
          totalBets={bets.length}
          historyMode={historyMode}
          setHistoryMode={setHistoryMode}
          histSourceFilter={histSourceFilter}
          setHistSourceFilter={setHistSourceFilter}
          activeMode={activeMode}
          loading={historyLoading}
          error={historyError}
        />
        <PerformanceInsights
          perfReportData={perfReportData}
          statsData={statsData}
          activeMode={activeMode}
        />
        {timeAnalyticsData && (
          <TimingAnalytics
            rows={timeAnalyticsData.rows}
            totalBets={timeAnalyticsData.totalBets}
            lastUpdated={timeAnalyticsData.lastUpdated}
          />
        )}
        <BotEntryTimingPanel
          rows={botEntryTimingData ?? []}
          isLoading={botEntryTimingLoading}
        />
        <AutoTuneHistory
          tuneEntries={tuneEntries}
          tuneCount={tuneCount}
          tuneLogOpen={tuneLogOpen}
          setTuneLogOpen={setTuneLogOpen}
        />
      </div>
      <ManualOrderModal
        manualOrderSym={manualOrderSym}
        setManualOrderSym={setManualOrderSym}
        manualDir={manualDir}
        setManualDir={setManualDir}
        manualBetSize={manualBetSize}
        setManualBetSize={setManualBetSize}
        manualSubmitting={manualSubmitting}
        submitManualOrder={submitManualOrder}
        manualOrderKalshiData={manualOrderKalshiData}
        status={status}
        activeMode={activeMode}
      />
      {/* ── Toast notification ── */}
      {manualToast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl border text-sm font-medium max-w-sm text-center ${
          manualToast.ok
            ? "bg-emerald-950 border-emerald-500/40 text-emerald-300"
            : "bg-red-950 border-red-500/40 text-red-300"
        }`}>
          {manualToast.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <XCircle className="w-4 h-4 flex-shrink-0" />}
          <span>{manualToast.msg}</span>
          <button onClick={() => setManualToast(null)} className="ml-1 opacity-60 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
