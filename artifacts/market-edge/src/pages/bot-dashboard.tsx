import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign,
  BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus,
  Settings, ChevronDown, ChevronUp, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

// ─── Types ──────────────────────────────────────────────────────────────────

interface BotConfig {
  betSize: number;
  dailyLossLimit: number;
  signalThreshold: number;
  minConfidence: number;
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number;
  maxEntryMinutes: number;
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
}

interface OpenPosition {
  id: string; symbol: string; windowKey: string; ticker: string;
  direction: "yes" | "no"; entryYesPrice: number; contractCount: number;
  betAmount: number; kalshiTarget: number; openedAt: number;
  cryptoPriceAtEntry: number | null;
}

interface GuardStates {
  holdDurationMet?: boolean; flipConfirmed?: boolean;
  erSupports?: boolean; timingSupports?: boolean; phase2Active?: boolean;
  [key: string]: boolean | undefined;
}

interface BotStatus {
  mode: "paper" | "live"; status: string; paused: boolean;
  config: BotConfig; openPosition: OpenPosition | null;
  openPositionCurrentYesPrice: number | null;
  openPositionUnrealizedPnl: number | null;
  dailyPnl: number; accountBalance: number | null;
  lastGuardStates: GuardStates | null; lastGuardReason: string | null;
  warmupSecondsRemaining: number | null; configured: boolean;
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  isInQuietHours: boolean;
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

// ─── Main Component ──────────────────────────────────────────────────────────

export default function BotDashboard() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(true);
  const [confirmLive, setConfirmLive] = useState(false);
  const [configDraft, setConfigDraft] = useState<Partial<BotConfig>>({});
  const [saving, setSaving] = useState(false);
  const [persistMsg, setPersistMsg] = useState<"saved" | "failed" | null>(null);

  // ── Data fetching ────────────────────────────────────────────────────────
  const { data: status, isLoading } = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/status`).then(r => r.json()),
    refetchInterval: 5_000,
  });

  const { data: historyData } = useQuery<{ history: HistoryRecord[] }>({
    queryKey: ["bot-all-history"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/all-history?limit=100`).then(r => r.json()),
    refetchInterval: 30_000,
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

  // ── Derived state ────────────────────────────────────────────────────────
  const cfg = status?.config;
  const merged = { ...cfg, ...configDraft } as BotConfig;
  const hasDraft = Object.keys(configDraft).length > 0;
  const history = historyData?.history ?? [];
  const bets = history.filter(r => r.action === "bet" || r.action === "exit" || r.action === "late_recovery_exit" || r.action === "expired");
  const evaluation = evalData?.evaluation ?? [];
  const stats = statsData;
  const pos = status?.openPosition ?? null;
  const pnl = status?.dailyPnl ?? 0;
  const winRate = (stats?.totalBets ?? 0) > 0 ? Math.round((stats!.wins / stats!.totalBets) * 100) : 0;

  const statusLabel = () => {
    if (!status) return "Loading…";
    if (!cfg?.enabled) return "Disabled";
    if (status.paused) return "Paused";
    if (status.warmupSecondsRemaining !== null) return `Warming up · ${status.warmupSecondsRemaining}s`;
    if (status.openPosition) return "Position Open";
    if (status.status === "daily_limit_hit") return "Daily Limit Hit";
    return "Watching Markets";
  };

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
          <span className={`text-xs px-2 py-1 rounded-full ${status?.paused ? "bg-muted text-muted-foreground" : pos ? "bg-emerald-500/15 text-emerald-400" : "bg-sky-500/10 text-sky-400"}`}>
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
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground border border-border" title={`Quiet hours active (${cfg?.quietHoursStart}:00–${cfg?.quietHoursEnd}:00 UTC) — no new entries`}>
              <Clock className="w-3 h-3" />
              Quiet
            </span>
          )}
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Account Balance", value: fmt$(status?.accountBalance), icon: DollarSign, color: "text-sky-400" },
            { label: "Today's P&L", value: fmt$(pnl), icon: pnl >= 0 ? TrendingUp : TrendingDown, color: pnl >= 0 ? "text-emerald-400" : "text-red-400", bold: true },
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

        {/* ── Active Position ── */}
        {pos && (
          <div className={`border rounded-xl p-5 ${pos.direction === "yes" ? "border-emerald-500/40 bg-emerald-950/20" : "border-red-500/40 bg-red-950/20"}`}>
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
                <div className={`text-lg font-bold ${(status?.openPositionUnrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {fmt$(status?.openPositionUnrealizedPnl)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 text-sm mb-4">
              {[
                { label: "Strike Price", value: fmtCrypto(pos.kalshiTarget) },
                { label: "Crypto @ Entry", value: fmtCrypto(pos.cryptoPriceAtEntry) },
                { label: "Entry Yes%", value: fmtPct(pos.entryYesPrice) },
                { label: "Entry No%", value: fmtPct(1 - pos.entryYesPrice) },
                { label: "Current Yes%", value: fmtPct(status?.openPositionCurrentYesPrice) },
                { label: "Current No%", value: status?.openPositionCurrentYesPrice != null ? fmtPct(1 - status.openPositionCurrentYesPrice) : "—" },
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

            {status?.lastGuardStates && (
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground self-center">Exit guards:</span>
                {Object.entries(status.lastGuardStates).map(([key, val]) => (
                  <span key={key} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full ${val ? "bg-emerald-500/15 text-emerald-400" : "bg-muted/50 text-muted-foreground"}`}>
                    {val ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                    {GUARD_LABELS[key] ?? key}
                  </span>
                ))}
                {status.lastGuardReason && (
                  <span className="text-xs text-muted-foreground italic self-center">· {status.lastGuardReason}</span>
                )}
              </div>
            )}
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
                      <td className="px-3 py-2.5 text-muted-foreground text-xs max-w-[200px] truncate">{e.reason}</td>
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
                  <span className="text-xs text-muted-foreground">Max Entry Time (never in last 4 min)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxEntryMinutes ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxEntryMinutes: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7].map(m => (
                      <option key={m} value={m}>{m} min into window</option>
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
                  <span className="text-xs text-muted-foreground">Quiet Hours Start (UTC)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.quietHoursStart ?? 12}
                    onChange={e => setConfigDraft(d => ({ ...d, quietHoursStart: parseInt(e.target.value) }))}>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, "0")}:00 UTC</option>
                    ))}
                  </select>
                </label>

                {/* Quiet Hours End */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Quiet Hours End (UTC)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.quietHoursEnd ?? 18}
                    onChange={e => setConfigDraft(d => ({ ...d, quietHoursEnd: parseInt(e.target.value) }))}>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, "0")}:00 UTC{i === (merged.quietHoursStart ?? 12) ? " (disabled)" : ""}</option>
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
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Transaction History</h2>
            <span className="ml-auto text-xs text-muted-foreground">{bets.length} record{bets.length !== 1 ? "s" : ""}</span>
          </div>

          {bets.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Bot className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No bets placed yet. The bot is watching the markets.</p>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {bets.map((r) => {
                const pnlNum = r.pnl != null ? parseFloat(r.pnl) : null;
                const ep = r.entryPrice != null ? parseFloat(r.entryPrice) : null;
                const xp = r.exitPrice != null ? parseFloat(r.exitPrice) : null;
                const isOpen = r.action === "bet";
                const isWin = r.outcome === "win";
                const isLoss = r.outcome === "loss";
                const closePx = (r.signals as Record<string, unknown> | null)?.closePriceAtEval as number | null ?? null;
                const endPx = closePx ?? (r.cryptoPriceAtExit != null ? parseFloat(r.cryptoPriceAtExit) : null);
                const strike = r.kalshiTarget != null ? parseFloat(r.kalshiTarget) : null;
                const endAboveStrike = endPx != null && strike != null ? endPx >= strike : null;

                const cardBg = isOpen
                  ? "border-sky-500/30 bg-sky-950/10"
                  : isWin
                    ? "border-emerald-500/30 bg-emerald-950/10"
                    : isLoss
                      ? "border-red-500/30 bg-red-950/10"
                      : "border-border bg-card/60";

                return (
                  <div key={r.id} className={`border rounded-xl p-4 transition-colors ${cardBg}`}>
                    {/* Card header */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-base font-black tracking-tight text-foreground">{r.symbol}</span>

                      {r.direction && (
                        <span className={`flex items-center gap-0.5 text-xs font-bold px-2 py-0.5 rounded-full ${r.direction === "yes" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                          {r.direction === "yes" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                          {r.direction.toUpperCase()}
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
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {r.action.replace(/_/g, " ").toUpperCase()}
                        </span>
                      )}

                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-500"}`}>
                        {r.mode?.toUpperCase()}
                      </span>

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
                      {!isOpen && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {fmtDuration(r.createdAt, r.exitedAt)}
                        </span>
                      )}
                      <span className="font-mono">{r.windowKey?.slice(11, 16)} window</span>
                      {r.exitReason && (
                        <span className="truncate max-w-[200px]" title={r.exitReason}>
                          · {r.exitReason.replace(/_/g, " ")}
                        </span>
                      )}
                      {r.phase2Activated && (
                        <span className="text-amber-400 font-medium">· Phase 2</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
