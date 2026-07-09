import { useEffect, useRef, useState, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Play, Pause, DollarSign, Wallet, Zap, ShieldAlert, Loader2, RefreshCw,
  TrendingUp, TrendingDown, Save, AlertTriangle, Activity, CheckCircle2, X,
  ListChecks, FlaskConical, BarChart3, ChevronDown, ChevronRight, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { StocksShell } from "./stocks-shell";
import {
  stockGet, stockAuth, closeStockPosition, fmtUsd, fmtPct, fmtSignedUsd, SECTORS,
  type BotStatus, type StockBotConfig, type TradingMode, type BotDecision,
  type ScanProgress, type BotPerformance, type AlpacaPosition,
} from "@/lib/stocks-api";

// ── Open bet detail from the DB ──────────────────────────────────────────────

interface OpenBetDetail {
  id: string;
  ticker: string;
  tradingMode: string;
  confidence: number | null;
  stopLoss: number | null;
  targetPrice: number | null;
  peakPrice: number | null;
  entryPrice: number | null;
  signals: {
    claude?: { reasoning?: string; rating?: string };
    research?: { summary?: string; stance?: string };
  } | null;
  sector: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODE_LABELS: Record<TradingMode, string> = {
  day: "Day Trade",
  swing: "Short-Term Swing",
  long: "Long-Term Hold",
};

const MCAP_OPTIONS = [
  { value: 0, label: "Any size" },
  { value: 1, label: "> $1B" },
  { value: 5, label: "> $5B" },
  { value: 10, label: "> $10B" },
];

const DECISION_FILTERS = ["ALL", "ENTER", "EXIT", "SKIP"] as const;
type DecisionFilter = typeof DECISION_FILTERS[number];

// ── Helpers ──────────────────────────────────────────────────────────────────

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtChartDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Main component ───────────────────────────────────────────────────────────

export default function StockBot() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [confirmLive, setConfirmLive] = useState(false);
  const [draft, setDraft] = useState<Partial<StockBotConfig>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cycling, setCycling] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("ALL");
  const [expandedDecisions, setExpandedDecisions] = useState<Set<string>>(new Set());

  const { data: status, isLoading } = useQuery<BotStatus>({
    queryKey: ["stocks-bot-status"],
    queryFn: () => stockGet("/bot/status"),
    refetchInterval: 5_000,
  });

  const { data: posData } = useQuery<{ positions: AlpacaPosition[] }>({
    queryKey: ["stocks-bot-positions"],
    queryFn: () => stockGet("/bot/positions"),
    refetchInterval: 10_000,
  });

  const { data: betsData } = useQuery<{ bets: OpenBetDetail[] }>({
    queryKey: ["stocks-bot-bets-open"],
    queryFn: () => stockGet("/bot/bets/open"),
    refetchInterval: 15_000,
  });

  const { data: scanProgress } = useQuery<ScanProgress>({
    queryKey: ["stocks-scanner-progress"],
    queryFn: () => stockGet("/scanner/progress"),
    refetchInterval: 5_000,
  });

  const { data: perf } = useQuery<BotPerformance>({
    queryKey: ["stocks-bot-performance"],
    queryFn: () => stockGet("/bot/performance"),
    refetchInterval: 60_000,
  });

  // Clear stale draft when backend config changes.
  const prevCfg = useRef<string>("");
  useEffect(() => {
    const key = JSON.stringify(status?.config ?? {});
    if (prevCfg.current && prevCfg.current !== key) setDraft({});
    prevCfg.current = key;
  }, [status?.config]);

  const cfg = status?.config;
  const merged = { ...cfg, ...draft } as StockBotConfig;
  const hasDraft = Object.keys(draft).length > 0;
  const positions = posData?.positions ?? status?.positions ?? [];
  const openBets = betsData?.bets ?? [];
  const betsByTicker = useMemo(
    () => new Map(openBets.map((b) => [b.ticker, b])),
    [openBets],
  );
  const account = status?.account;

  async function patch(partial: Partial<StockBotConfig>) {
    await stockAuth(getToken, "/bot/config", "PUT", partial);
    await qc.invalidateQueries({ queryKey: ["stocks-bot-status"] });
  }

  async function patchSafe(partial: Partial<StockBotConfig>) {
    try {
      await patch(partial);
    } catch (e) {
      toast({
        title: "Could not update bot",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    }
  }

  async function saveDraft() {
    if (!hasDraft) return;
    setSaving(true);
    try {
      await patch(draft);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      toast({
        title: "Could not save settings",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function runCycle() {
    setCycling(true);
    try {
      await stockAuth(getToken, "/bot/cycle", "POST");
      await qc.invalidateQueries({ queryKey: ["stocks-bot-status"] });
      await qc.invalidateQueries({ queryKey: ["stocks-bot-positions"] });
      await qc.invalidateQueries({ queryKey: ["stocks-bot-bets-open"] });
      await qc.invalidateQueries({ queryKey: ["stocks-bot-performance"] });
    } catch (e) {
      toast({
        title: "Cycle failed",
        description: e instanceof Error ? e.message : "Broker may not be connected.",
        variant: "destructive",
      });
    } finally {
      setCycling(false);
    }
  }

  async function closePosition(ticker: string) {
    setClosing(ticker);
    try {
      const r = await closeStockPosition(getToken, ticker);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["stocks-bot-positions"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-bets-open"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-status"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-history"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-pnl"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-performance"] }),
      ]);
      toast({
        title: `Closed ${r.ticker}`,
        description: `Sold ${r.qty} @ ${fmtUsd(r.exitPrice)} · P&L ${fmtSignedUsd(r.pnl)}`,
      });
    } catch (e) {
      toast({
        title: "Could not close position",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    } finally {
      setClosing(null);
      setConfirmClose(null);
    }
  }

  function toggleMode(m: TradingMode) {
    const cur = merged.tradingModes ?? [];
    const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
    patchSafe({ tradingModes: next });
  }

  function saveSlider(k: keyof StockBotConfig, v: number) {
    patchSafe({ [k]: v });
  }

  const setField = <K extends keyof StockBotConfig>(k: K, v: StockBotConfig[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  function toggleDecision(key: string) {
    setExpandedDecisions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const filteredDecisions = useMemo(() => {
    const all = status?.cycle?.decisions ?? [];
    if (decisionFilter === "ALL") return all;
    return all.filter((d) => d.action === decisionFilter);
  }, [status?.cycle?.decisions, decisionFilter]);

  const lastRanAt = status?.cycle?.lastCycleAt ?? 0;

  if (isLoading) {
    return (
      <StocksShell>
        <div className="h-40 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading bot…
        </div>
      </StocksShell>
    );
  }

  return (
    <StocksShell>
      <div className="p-6 space-y-6">

        {/* ── Control bar ─────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
              status?.config.mode === "live"
                ? "border-red-500/50 bg-red-500/10 text-red-400"
                : "border-yellow-500/50 bg-yellow-500/10 text-yellow-400"
            }`}>
              {status?.config.mode?.toUpperCase() ?? "PAPER"}
            </span>
            <span className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ${
              cfg?.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"
            }`}>
              <Activity className="w-3 h-3" />
              {cfg?.enabled ? "Running" : "Stopped"}
            </span>
            {status?.cycle?.running && (
              <span className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-sky-500/10 text-sky-400">
                <Loader2 className="w-3 h-3 animate-spin" /> cycling
              </span>
            )}
            {lastRanAt > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="w-3 h-3" />
                <span title={new Date(lastRanAt).toLocaleTimeString()}>
                  Last ran {relTime(lastRanAt)}
                </span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="h-8 gap-1.5"
              onClick={() => patchSafe({ enabled: !cfg?.enabled })}>
              {cfg?.enabled ? <><Pause className="w-3.5 h-3.5" />Stop</> : <><Play className="w-3.5 h-3.5" />Start</>}
            </Button>
            <div className="relative group">
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={runCycle} disabled={cycling}>
                {cycling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Run cycle
              </Button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 px-3 py-2 rounded-lg bg-popover border border-border text-xs text-muted-foreground shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                Runs one evaluation right now. The bot checks all candidates, enters/exits as needed, then stops. Useful for testing.
              </div>
            </div>
            {status?.config.mode === "paper" ? (
              confirmLive ? (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="destructive" className="h-8 text-xs"
                    onClick={() => { patchSafe({ mode: "live" }); setConfirmLive(false); }}>
                    Confirm real money
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setConfirmLive(false)}>Cancel</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="h-8 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10"
                  onClick={() => setConfirmLive(true)}>
                  Switch to Real
                </Button>
              )
            ) : (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => patchSafe({ mode: "paper" })}>
                Back to Paper
              </Button>
            )}
          </div>
        </div>

        {/* ── Real-money warning ───────────────────────────────────────── */}
        {confirmLive && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-start gap-2">
            <ShieldAlert className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <span>
              <strong>You are about to enable live trading with real money.</strong> The bot will place
              real orders through your Alpaca live account using the settings below. Confirm only if you
              understand the risk.
            </span>
          </div>
        )}

        {/* ── Account cards ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Equity", value: fmtUsd(account?.equity), icon: DollarSign, color: "text-sky-400" },
            { label: "Cash", value: fmtUsd(account?.cash), icon: Wallet, color: "text-emerald-400" },
            { label: "Buying Power", value: fmtUsd(account?.buyingPower), icon: Zap, color: "text-violet-400" },
            { label: "Day Trades", value: account ? `${account.daytradeCount}/${cfg?.maxDayPositions ?? 3}` : "—", sub: account?.patternDayTrader ? "PDT flagged" : undefined, icon: ShieldAlert, color: account?.patternDayTrader ? "text-red-400" : "text-amber-400" },
          ].map(({ label, value, sub, icon: Icon, color }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <div className="text-xl font-bold text-foreground">{value}</div>
              {sub && <div className="text-[11px] text-red-400 mt-0.5">{sub}</div>}
            </div>
          ))}
        </div>

        {status?.cycle?.lastCycleSummary && (
          <div className="text-xs text-muted-foreground">
            Last cycle: <span className="text-foreground">{status.cycle.lastCycleSummary}</span>
            {status.cycle.lastCycleAt > 0 && ` · ${new Date(status.cycle.lastCycleAt).toLocaleTimeString()}`}
          </div>
        )}

        {/* ── Research pipeline progress ───────────────────────────────── */}
        {(scanProgress?.scanning || scanProgress?.researchRunning) && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-xs text-sky-300 flex items-center gap-2">
            <FlaskConical className="w-4 h-4 flex-shrink-0" />
            {scanProgress.researchRunning ? (
              <span>Researching top picks — {scanProgress.researchDone} / {scanProgress.researchTotal} reports done</span>
            ) : scanProgress.phase === "screening" ? (
              <span>Screening market — {scanProgress.screened} / {scanProgress.universeSize} stocks</span>
            ) : scanProgress.phase === "scoring" ? (
              <span>Deep-scoring {scanProgress.done} / {scanProgress.total} candidates</span>
            ) : (
              <span>Scan pipeline running…</span>
            )}
            <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />
          </div>
        )}

        {/* ── Performance section ──────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-violet-400" /> Performance
          </h2>
          {!perf || perf.summary.totalTrades === 0 ? (
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              No closed trades yet — P&L and equity curve will appear here once positions have been exited.
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card p-5 space-y-5">
              {/* Equity curve */}
              {perf.equityCurve.length > 1 && (
                <div>
                  <p className="text-[11px] text-muted-foreground mb-2">Cumulative Realized P&L</p>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={perf.equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={fmtChartDate}
                        tick={{ fontSize: 10, fill: "#666" }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tickFormatter={(v) => `$${v}`}
                        tick={{ fontSize: 10, fill: "#666" }}
                        axisLine={false}
                        tickLine={false}
                        width={52}
                      />
                      <RechartsTip
                        formatter={(v: number) => [`$${v.toFixed(2)}`, "Cum. P&L"]}
                        contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", fontSize: 11 }}
                      />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                      <Line
                        type="monotone"
                        dataKey="cumPnl"
                        stroke={perf.summary.totalPnl >= 0 ? "#10b981" : "#ef4444"}
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Summary stats */}
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                {[
                  { label: "Win Rate", value: fmtPct(perf.summary.winRate * 100, 1), color: perf.summary.winRate >= 0.5 ? "text-emerald-400" : "text-red-400" },
                  { label: "Avg Win", value: fmtUsd(perf.summary.avgWin), color: "text-emerald-400" },
                  { label: "Avg Loss", value: fmtUsd(perf.summary.avgLoss), color: "text-red-400" },
                  { label: "Total Trades", value: String(perf.summary.totalTrades), color: "text-foreground" },
                  { label: "Best Trade", value: fmtSignedUsd(perf.summary.bestTrade), color: "text-emerald-400" },
                  { label: "Worst Trade", value: fmtSignedUsd(perf.summary.worstTrade), color: "text-red-400" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground">{label}</span>
                    <span className={`text-sm font-bold ${color}`}>{value}</span>
                  </div>
                ))}
              </div>

              {/* By-mode breakdown */}
              <div>
                <p className="text-[11px] text-muted-foreground mb-2">By Mode</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left pb-1.5 font-medium">Mode</th>
                        <th className="text-right pb-1.5 font-medium">Wins</th>
                        <th className="text-right pb-1.5 font-medium">Losses</th>
                        <th className="text-right pb-1.5 font-medium">Win Rate</th>
                        <th className="text-right pb-1.5 font-medium">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(["day", "swing", "long"] as TradingMode[]).map((m) => {
                        const row = perf.byMode[m];
                        const total = row.wins + row.losses;
                        const wr = total > 0 ? row.wins / total : null;
                        return (
                          <tr key={m} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 font-medium text-foreground">{MODE_LABELS[m]}</td>
                            <td className="py-1.5 text-right text-emerald-400">{row.wins}</td>
                            <td className="py-1.5 text-right text-red-400">{row.losses}</td>
                            <td className={`py-1.5 text-right font-semibold ${wr == null ? "text-muted-foreground" : wr >= 0.5 ? "text-emerald-400" : "text-red-400"}`}>
                              {wr != null ? fmtPct(wr * 100, 0) : "—"}
                            </td>
                            <td className={`py-1.5 text-right font-semibold ${row.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {fmtSignedUsd(row.totalPnl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ── Decision feed ─────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-sky-400" /> Decision Feed
              <span className="text-xs font-normal text-muted-foreground">
                ({filteredDecisions.length})
              </span>
            </h2>
            <div className="flex items-center gap-1 ml-auto">
              {DECISION_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setDecisionFilter(f)}
                  className={`px-2.5 py-0.5 text-[11px] font-semibold rounded-full border transition-colors ${
                    decisionFilter === f
                      ? f === "ENTER" ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
                        : f === "EXIT" ? "border-sky-500/60 bg-sky-500/15 text-sky-400"
                        : f === "SKIP" ? "border-muted bg-muted text-muted-foreground"
                        : "border-violet-500/60 bg-violet-500/15 text-violet-400"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {filteredDecisions.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              {decisionFilter === "ALL"
                ? "No decisions yet — the bot logs every ENTER / EXIT / SKIP here as it evaluates candidates."
                : `No ${decisionFilter} decisions in the current log.`}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card divide-y divide-border max-h-80 overflow-y-auto">
              {filteredDecisions.map((d, i) => {
                const key = `${d.ts}-${d.ticker}-${i}`;
                const expanded = expandedDecisions.has(key);
                const hasDetail = d.action === "ENTER" && (d.claudeReasoning || d.reason);
                return (
                  <DecisionRow
                    key={key}
                    d={d}
                    expanded={expanded}
                    onToggle={hasDetail ? () => toggleDecision(key) : undefined}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* ── Live positions ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" /> Live Positions
            <span className="text-xs font-normal text-muted-foreground">({positions.length})</span>
          </h2>
          {positions.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              No open positions.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    {["Ticker", "Mode", "Confidence", "Stance", "Entry", "Current", "Mkt Value", "P&L", "Progress", ""].map((h) => (
                      <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const bet = betsByTicker.get(p.ticker);
                    const stopPct = bet?.stopLoss && bet?.entryPrice
                      ? ((bet.entryPrice - bet.stopLoss) / bet.entryPrice) * 100
                      : merged.stopLossPct ?? 3;
                    const targetPct = bet?.targetPrice && bet?.entryPrice
                      ? ((bet.targetPrice - bet.entryPrice) / bet.entryPrice) * 100
                      : merged.targetGainPct ?? 6;
                    const gainPct = p.unrealizedPlpc;
                    const trailingStop = bet?.tradingMode === "long" && bet?.peakPrice
                      ? bet.peakPrice * (1 - (merged.longStopLossPct ?? merged.stopLossPct ?? 6) / 100)
                      : null;

                    return (
                      <tr key={p.ticker} className="border-t border-border" data-testid={`position-${p.ticker}`}>
                        <td className="px-3 py-2.5 font-bold text-foreground">{p.ticker}</td>
                        <td className="px-3 py-2.5">
                          {bet?.tradingMode ? (
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                              bet.tradingMode === "day" ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                              : bet.tradingMode === "swing" ? "border-violet-500/40 bg-violet-500/10 text-violet-400"
                              : "border-sky-500/40 bg-sky-500/10 text-sky-400"
                            }`}>
                              {bet.tradingMode}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {bet?.confidence != null ? (
                            <span className={`text-xs font-bold ${bet.confidence >= 70 ? "text-emerald-400" : bet.confidence >= 60 ? "text-amber-400" : "text-muted-foreground"}`}>
                              {bet.confidence}%
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {(() => {
                            const rating = bet?.signals?.claude?.rating ?? bet?.signals?.research?.stance;
                            if (!rating) return <span className="text-muted-foreground">—</span>;
                            const isPos = rating === "buy" || rating === "buy_now";
                            const isNeg = rating === "sell" || rating === "avoid";
                            return (
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                                isPos ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                                : isNeg ? "border-red-500/40 bg-red-500/10 text-red-400"
                                : "border-amber-500/40 bg-amber-500/10 text-amber-400"
                              }`}>
                                {rating.replace("_", " ")}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-foreground">{fmtUsd(p.avgEntry)}</td>
                        <td className="px-3 py-2.5 text-foreground">{fmtUsd(p.currentPrice)}</td>
                        <td className="px-3 py-2.5 text-foreground">{fmtUsd(p.marketValue)}</td>
                        <td className={`px-3 py-2.5 font-semibold ${p.unrealizedPl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          <span className="inline-flex items-center gap-0.5">
                            {p.unrealizedPl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {fmtUsd(p.unrealizedPl)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="space-y-0.5">
                            <PositionProgressBar gainPct={gainPct} stopPct={stopPct} targetPct={targetPct} />
                            {trailingStop != null && (
                              <div className="text-[10px] text-muted-foreground">
                                Trail: {fmtUsd(trailingStop)}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {confirmClose === p.ticker ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-[11px] text-muted-foreground">Sell all?</span>
                              <Button size="sm" variant="destructive" className="h-7 px-2 text-xs"
                                disabled={closing === p.ticker} onClick={() => closePosition(p.ticker)}
                                data-testid={`confirm-close-${p.ticker}`}>
                                {closing === p.ticker ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs"
                                disabled={closing === p.ticker} onClick={() => setConfirmClose(null)}
                                aria-label="Cancel close">
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </span>
                          ) : (
                            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs"
                              onClick={() => setConfirmClose(p.ticker)}
                              data-testid={`close-${p.ticker}`}>
                              Close
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Trading modes ─────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-foreground mb-3">Trading Modes</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(["day", "swing", "long"] as TradingMode[]).map((m) => {
              const on = merged.tradingModes?.includes(m);
              const capKey = m === "day" ? "maxDayPositions" : m === "swing" ? "maxSwingPositions" : "maxLongPositions";
              const cap = merged[capKey as keyof StockBotConfig] as number | undefined;
              const stopKey = m === "day" ? "dayStopLossPct" : m === "swing" ? "swingStopLossPct" : "longStopLossPct";
              const targetKey = m === "day" ? "dayTargetGainPct" : m === "swing" ? "swingTargetGainPct" : "longTargetGainPct";
              const stopVal = (merged[stopKey as keyof StockBotConfig] as number | undefined) ?? merged.stopLossPct;
              const targetVal = (merged[targetKey as keyof StockBotConfig] as number | undefined) ?? merged.targetGainPct;
              const isStopOverridden = (merged[stopKey as keyof StockBotConfig] as number | undefined) != null;
              const isTargetOverridden = (merged[targetKey as keyof StockBotConfig] as number | undefined) != null;

              return (
                <div key={m} className={`rounded-lg border p-4 transition-colors space-y-3 ${on ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-card"}`}>
                  <button onClick={() => toggleMode(m)} className="flex items-center justify-between w-full">
                    <span className="text-sm font-semibold text-foreground">{MODE_LABELS[m]}</span>
                    <span className={`w-9 h-5 rounded-full relative transition-colors ${on ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
                    </span>
                  </button>

                  <div>
                    <label className="text-[11px] text-muted-foreground">Max positions: <span className="text-foreground font-semibold">{cap ?? 0}</span></label>
                    <input type="range" min={0} max={10} value={cap ?? 0}
                      onChange={(e) => setField(capKey as keyof StockBotConfig, Number(e.target.value) as never)}
                      onPointerUp={(e) => saveSlider(capKey as keyof StockBotConfig, Number((e.target as HTMLInputElement).value))}
                      onMouseUp={(e) => saveSlider(capKey as keyof StockBotConfig, Number((e.target as HTMLInputElement).value))}
                      className="w-full mt-0.5 accent-emerald-500" />
                  </div>

                  <div className="border-t border-border/60 pt-3 space-y-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground flex justify-between">
                        <span>Stop loss: <span className="text-foreground font-semibold">{stopVal?.toFixed(1)}%</span></span>
                        {!isStopOverridden && <span className="text-muted-foreground/60">(global)</span>}
                      </label>
                      <input type="range" min={0.5} max={20} step={0.5}
                        value={stopVal ?? merged.stopLossPct ?? 3}
                        onChange={(e) => setField(stopKey as keyof StockBotConfig, Number(e.target.value) as never)}
                        onPointerUp={(e) => saveSlider(stopKey as keyof StockBotConfig, Number((e.target as HTMLInputElement).value))}
                        onMouseUp={(e) => saveSlider(stopKey as keyof StockBotConfig, Number((e.target as HTMLInputElement).value))}
                        className="w-full mt-0.5 accent-red-500" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground flex justify-between">
                        <span>Target gain: <span className="text-foreground font-semibold">{targetVal?.toFixed(1)}%</span></span>
                        {!isTargetOverridden && <span className="text-muted-foreground/60">(global)</span>}
                      </label>
                      <input type="range" min={1} max={50} step={0.5}
                        value={targetVal ?? merged.targetGainPct ?? 6}
                        onChange={(e) => setField(targetKey as keyof StockBotConfig, Number(e.target.value) as never)}
                        onPointerUp={(e) => saveSlider(targetKey as keyof StockBotConfig, Number((e.target as HTMLInputElement).value))}
                        onMouseUp={(e) => saveSlider(targetKey as keyof StockBotConfig, Number((e.target as HTMLInputElement).value))}
                        className="w-full mt-0.5 accent-emerald-500" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Sector focus ─────────────────────────────────────────────── */}
        <section>
          <div className="mb-3">
            <h2 className="text-sm font-bold text-foreground">Sector Focus</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Bot only considers stocks in selected sectors.{" "}
              {(merged.sectorFocus ?? []).length === 0
                ? "All sectors active."
                : `${(merged.sectorFocus ?? []).length} of ${SECTORS.length} sectors active.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SECTORS.map((s) => {
              const focus = merged.sectorFocus ?? [];
              const allActive = focus.length === 0;
              const active = allActive || focus.includes(s);
              function toggle() {
                const cur = allActive ? [...SECTORS] : [...focus];
                const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
                patchSafe({ sectorFocus: next.length === SECTORS.length ? [] : next });
              }
              return (
                <button key={s} onClick={toggle}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    active
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}>
                  {s}
                </button>
              );
            })}
            {(merged.sectorFocus ?? []).length > 0 && (
              <button onClick={() => patchSafe({ sectorFocus: [] })}
                className="px-2.5 py-1 text-xs font-medium rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground transition-colors">
                Reset all
              </button>
            )}
          </div>
        </section>

        {/* ── Settings ─────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-foreground">Settings</h2>
            <div className="flex items-center gap-2">
              {saved && <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" />Saved</span>}
              <Button size="sm" onClick={saveDraft} disabled={!hasDraft || saving} className="h-8 gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save{hasDraft ? " changes" : "d"}
              </Button>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-5 space-y-5">

            {/* Core settings */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <NumField label="Position size (% of equity)" value={merged.positionSizePct} min={0.5} max={25} step={0.5} onChange={(v) => setField("positionSizePct", v)} />
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Max $ per position <span className="text-muted-foreground/60">(blank = no cap)</span></span>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <input type="number" min={0} step={100} placeholder="No cap"
                    value={merged.maxPositionDollars ?? ""}
                    onChange={(e) => setField("maxPositionDollars", e.target.value === "" ? null : Number(e.target.value))}
                    onBlur={(e) => patchSafe({ maxPositionDollars: e.target.value === "" ? null : Number(e.target.value) })}
                    className="flex-1 px-3 py-2 text-sm rounded-lg bg-background border border-border focus:border-emerald-500/50 outline-none" />
                </div>
              </label>
              <NumField label="Max concurrent positions" value={merged.maxConcurrentPositions} min={1} max={20} step={1} onChange={(v) => setField("maxConcurrentPositions", v)} />
              <NumField label="Daily loss limit ($)" value={merged.dailyLossLimit} min={0} max={100000} step={50} onChange={(v) => setField("dailyLossLimit", v)} />
              <NumField label="Min confidence to enter (%)" value={merged.minConfidence} min={50} max={95} step={1} onChange={(v) => setField("minConfidence", v)} />
              <NumField label="Global stop loss (%)" value={merged.stopLossPct} min={0.5} max={30} step={0.5} onChange={(v) => setField("stopLossPct", v)} />
              <NumField label="Global target gain (%)" value={merged.targetGainPct} min={1} max={100} step={0.5} onChange={(v) => setField("targetGainPct", v)} />
              <NumField label="News sensitivity (1–5)" value={merged.newsSensitivity} min={1} max={5} step={1} onChange={(v) => setField("newsSensitivity", v)} />
              <NumField label="Swing max hold (days)" value={merged.swingMaxHoldDays} min={1} max={30} step={1} onChange={(v) => setField("swingMaxHoldDays", v)} />
              <NumField label="Long max hold (days)" value={merged.longMaxHoldDays} min={7} max={365} step={7} onChange={(v) => setField("longMaxHoldDays", v)} />
            </div>

            {/* Earnings blackout */}
            <div className="border-t border-border pt-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-foreground">Earnings blackout</span>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Skip entries near upcoming earnings</p>
                </div>
                <button onClick={() => patchSafe({ earningsBlackout: !merged.earningsBlackout })}
                  className={`ml-4 flex-shrink-0 w-9 h-5 rounded-full relative transition-colors ${merged.earningsBlackout ? "bg-emerald-500" : "bg-muted"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${merged.earningsBlackout ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
              {merged.earningsBlackout && (
                <NumField label="Blackout window (hours)" value={merged.earningsBlackoutHours} min={1} max={168} step={1} onChange={(v) => setField("earningsBlackoutHours", v)} />
              )}
            </div>

            {/* Advanced */}
            <div className="border-t border-border pt-4 space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Advanced</p>

              {/* Confidence-based sizing toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-foreground">Confidence-based sizing</span>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Scale position size from base to 1.5× proportionally as confidence rises from min to 80%</p>
                </div>
                <button onClick={() => patchSafe({ dynamicSizing: !merged.dynamicSizing })}
                  className={`ml-4 flex-shrink-0 w-9 h-5 rounded-full relative transition-colors ${merged.dynamicSizing ? "bg-emerald-500" : "bg-muted"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${merged.dynamicSizing ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>

              {/* Min market cap */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Min market cap filter</label>
                <div className="flex gap-1.5 flex-wrap">
                  {MCAP_OPTIONS.map((opt) => (
                    <button key={opt.value}
                      onClick={() => patchSafe({ minMarketCapBillion: opt.value })}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        (merged.minMarketCapBillion ?? 0) === opt.value
                          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Max sector concentration */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Max sector concentration: <span className="text-foreground font-semibold">
                    {(merged.maxSectorPct ?? 0) === 0 ? "Disabled" : `${merged.maxSectorPct}%`}
                  </span>
                </label>
                <input type="range" min={0} max={40} step={5}
                  value={merged.maxSectorPct ?? 0}
                  onChange={(e) => setField("maxSectorPct", Number(e.target.value))}
                  onPointerUp={(e) => saveSlider("maxSectorPct", Number((e.target as HTMLInputElement).value))}
                  onMouseUp={(e) => saveSlider("maxSectorPct", Number((e.target as HTMLInputElement).value))}
                  className="w-full accent-violet-500" />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                  <span>Off</span>
                  <span>40% cap</span>
                </div>
              </div>
            </div>

            {/* Auto-start toggle */}
            <div className="border-t border-border pt-4 flex items-center justify-between">
              <div>
                <span className="text-sm text-foreground">Auto-start at market open</span>
                <p className="text-[11px] text-muted-foreground mt-0.5">Bot starts at 9:30 AM ET and stops at 4:00 PM ET automatically</p>
              </div>
              <button onClick={() => patchSafe({ autoStartStop: !merged.autoStartStop })}
                className={`ml-4 flex-shrink-0 w-9 h-5 rounded-full relative transition-colors ${merged.autoStartStop ? "bg-emerald-500" : "bg-muted"}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${merged.autoStartStop ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>

          </div>
          {!status?.configured && (
            <p className="text-[11px] text-amber-400/80 mt-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Settings save normally, but trading stays paused until the broker is connected.
            </p>
          )}
        </section>

      </div>
    </StocksShell>
  );
}

// ── Decision row ─────────────────────────────────────────────────────────────

function DecisionRow({
  d, expanded, onToggle,
}: {
  d: BotDecision;
  expanded: boolean;
  onToggle?: () => void;
}) {
  const badge =
    d.action === "ENTER"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
      : d.action === "EXIT"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-400"
        : "border-border bg-muted/30 text-muted-foreground";

  const detail = d.claudeReasoning || (d.action === "ENTER" ? d.reason : null);

  return (
    <div data-testid={`decision-${d.ticker}-${d.ts}`}>
      <div
        className={`flex items-center gap-3 px-4 py-2 text-xs ${onToggle ? "cursor-pointer hover:bg-muted/20 transition-colors" : ""}`}
        onClick={onToggle}
      >
        <span className="text-muted-foreground w-16 flex-shrink-0 font-mono" title={new Date(d.ts).toLocaleString()}>
          {relTime(d.ts)}
        </span>
        <span className={`font-bold px-1.5 py-0.5 rounded border w-14 text-center flex-shrink-0 ${badge}`}>
          {d.action}
        </span>
        <span className="font-bold text-foreground w-14 flex-shrink-0">{d.ticker}</span>
        {d.horizon && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-400 flex-shrink-0">
            {d.horizon}
          </span>
        )}
        {d.confidence != null && (
          <span className="text-[10px] font-semibold text-muted-foreground flex-shrink-0">{d.confidence}%</span>
        )}
        <span className="text-muted-foreground truncate flex-1" title={d.reason}>{d.reason}</span>
        {onToggle && (
          <span className="text-muted-foreground flex-shrink-0">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </span>
        )}
      </div>
      {expanded && detail && (
        <div className="px-4 pb-3 pt-0 ml-[4.5rem] text-[11px] text-muted-foreground border-t border-border/40 bg-muted/10">
          <p className="text-[10px] font-semibold text-emerald-400/70 mb-1 mt-2">Claude Research Summary</p>
          <p className="leading-relaxed">{detail}</p>
        </div>
      )}
    </div>
  );
}

// ── Position progress bar ─────────────────────────────────────────────────────

function PositionProgressBar({
  gainPct, stopPct, targetPct,
}: {
  gainPct: number;
  stopPct: number;
  targetPct: number;
}) {
  const isPos = gainPct >= 0;
  const posProgress = targetPct > 0 ? Math.min(gainPct / targetPct, 1) : 0;
  const negProgress = stopPct > 0 ? Math.min((-gainPct) / stopPct, 1) : 0;

  return (
    <div className="flex items-center gap-1.5 min-w-[90px]">
      <div className="w-20 h-2 bg-muted rounded-full overflow-hidden relative flex-shrink-0">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border/80 z-10" />
        {isPos ? (
          <div
            className="absolute left-1/2 top-0 bottom-0 bg-emerald-500 rounded-r"
            style={{ width: `${posProgress * 50}%` }}
          />
        ) : (
          <div
            className="absolute right-1/2 top-0 bottom-0 bg-red-500 rounded-l"
            style={{ width: `${negProgress * 50}%` }}
          />
        )}
      </div>
      <span className={`text-[10px] font-mono tabular-nums w-9 ${isPos ? "text-emerald-400" : "text-red-400"}`}>
        {isPos ? `+${(posProgress * 100).toFixed(0)}%` : `-${(negProgress * 100).toFixed(0)}%`}
      </span>
    </div>
  );
}

// ── NumField ──────────────────────────────────────────────────────────────────

function NumField({ label, value, min, max, step, onChange }: {
  label: string; value: number | undefined; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input type="number" value={value ?? ""} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="px-3 py-2 text-sm rounded-lg bg-background border border-border focus:border-emerald-500/50 outline-none" />
    </label>
  );
}
