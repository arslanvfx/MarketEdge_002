import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Brain, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { ConditionsPanel } from "./conditions-panel";
import { ConvictionThresholdPanel } from "./conviction-threshold-panel";
import { GapAnalyticsPanel } from "./gap-analytics-panel";
import { BotEntryTimingPanel, type BotEntryTimingRow } from "./bot-entry-timing-panel";
import { PerformanceInsights } from "./performance-insights";
import { PerfByCoin } from "./perf-by-coin";
import { TimingAnalytics, type TimeAnalyticsRow } from "./timing-analytics";
import { TransactionLog } from "./transaction-log";
import { normalizeScalpOrders } from "./scalper-ledger";
import { API_BASE } from "./utils";
import type {
  BotConditionsSnapshot,
  BotStats,
  BotStatus,
  ConvictionThresholdData,
  GapAnalyticsResult,
  HistoryRecord,
  PerformanceReport,
  ScalpOrder,
  WindowEval,
} from "./types";

type Mode = "paper" | "live";
type SourceFilter = "all" | "bot" | "manual" | "scalper" | "skips";

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return body;
}

function DataState({ label, error }: { label: string; error?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-4 py-5 text-sm flex items-center gap-2 ${
        error
          ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
          : "border-border bg-card text-muted-foreground"
      }`}
      role={error ? "alert" : "status"}
    >
      {error
        ? <AlertTriangle className="w-4 h-4 shrink-0" />
        : <Loader2 className="w-4 h-4 shrink-0 animate-spin text-sky-400" />}
      {error ? `${label} is temporarily unavailable.` : `Loading ${label.toLowerCase()}…`}
    </div>
  );
}

export function SharedBotIntelligence({ mode }: { mode: Mode }) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [historyMode, setHistoryMode] = useState<Mode>(mode);
  const [histSourceFilter, setHistSourceFilter] = useState<SourceFilter>("all");
  const [histPage, setHistPage] = useState(0);
  const [reEval, setReEval] = useState<{
    loading: boolean;
    result: { checked: number; corrected: number; errors: number } | null;
    error: string | null;
  }>({ loading: false, result: null, error: null });

  useEffect(() => {
    setHistoryMode(mode);
    setHistPage(0);
  }, [mode]);

  const statusQuery = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: () => fetchJson("/crypto/bot/status"),
    refetchInterval: 5_000,
  });
  const conditionsQuery = useQuery<BotConditionsSnapshot>({
    queryKey: ["bot-conditions"],
    queryFn: () => fetchJson("/crypto/bot/conditions"),
    refetchInterval: 5_000,
  });
  const evaluationQuery = useQuery<{ evaluation: WindowEval[] }>({
    queryKey: ["bot-window-eval"],
    queryFn: () => fetchJson("/crypto/bot/window-eval"),
    refetchInterval: 3_000,
  });
  const statsQuery = useQuery<BotStats>({
    queryKey: ["bot-stats", mode],
    queryFn: () => fetchJson(`/crypto/bot/stats?mode=${mode}`),
    refetchInterval: 30_000,
  });
  const convictionQuery = useQuery<ConvictionThresholdData>({
    queryKey: ["bot-conviction-threshold", mode],
    queryFn: () => fetchJson(`/crypto/bot/conviction-threshold-analysis?mode=${mode}`),
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
  });
  const gapQuery = useQuery<GapAnalyticsResult>({
    queryKey: ["bot-gap-analytics", mode],
    queryFn: () => fetchJson(`/crypto/bot/gap-analytics?mode=${mode}`),
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
  });
  const performanceQuery = useQuery<{ report: PerformanceReport | null; pausedCoins: Record<string, number> }>({
    queryKey: ["bot-performance-report", mode],
    queryFn: () => fetchJson(`/crypto/bot/performance-report?mode=${mode}`),
    refetchInterval: 5 * 60_000,
  });
  const timingQuery = useQuery<{ rows: TimeAnalyticsRow[]; totalBets: number; lastUpdated: string }>({
    queryKey: ["bot-time-analytics"],
    queryFn: () => fetchJson("/crypto/bot/time-analytics"),
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
  });
  const entryTimingQuery = useQuery<BotEntryTimingRow[]>({
    queryKey: ["bot-entry-timing"],
    queryFn: () => fetchJson("/crypto/bot/entry-timing"),
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
  });

  const historyKind = histSourceFilter === "skips" ? "skips" : "transactions";
  const historyQuery = useQuery<{ history: HistoryRecord[] }>({
    queryKey: ["bot-all-history", historyMode, historyKind],
    queryFn: () => fetchJson(`/crypto/bot/all-history?limit=500&mode=${historyMode}&kind=${historyKind}`),
    refetchInterval: 15_000,
  });
  const scalperHistoryQuery = useQuery<{ orders: ScalpOrder[] }>({
    queryKey: ["bot-scalper-history", "all"],
    queryFn: () => fetchJson("/crypto/scalper/history?limit=500"),
    refetchInterval: 15_000,
  });

  const filteredHistory = useMemo(() => {
    const normalizedScalps = normalizeScalpOrders(scalperHistoryQuery.data?.orders ?? []);
    const combined = [
      ...(historyQuery.data?.history ?? []),
      ...normalizedScalps.history.filter(record => record.mode === historyMode),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return combined.filter(record => {
      if (histSourceFilter === "skips") return record.action === "skip";
      if (!["bet", "exit", "late_recovery_exit", "expired"].includes(record.action)) return false;
      const manual = record.source === "manual"
        || (record.signals as Record<string, unknown> | null)?.manual === true;
      if (histSourceFilter === "manual") return manual;
      if (histSourceFilter === "scalper") return record.source === "scalper";
      if (histSourceFilter === "bot") return !manual && record.source !== "scalper";
      return true;
    });
  }, [histSourceFilter, historyMode, historyQuery.data, scalperHistoryQuery.data]);

  const pageSize = 20;
  const totalHistPages = Math.max(1, Math.ceil(filteredHistory.length / pageSize));
  const clampedHistPage = Math.min(histPage, totalHistPages - 1);
  const pagedBets = filteredHistory.slice(clampedHistPage * pageSize, (clampedHistPage + 1) * pageSize);

  async function runReEvaluation() {
    if (reEval.loading) return;
    setReEval({ loading: true, result: null, error: null });
    try {
      const token = await getToken();
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
      const response = await fetch(
        `${API_BASE}/crypto/bot/re-evaluate-bets?since=${encodeURIComponent(since)}&limit=500`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({}),
        },
      );
      const data = await response.json() as {
        ok?: boolean;
        checked?: number;
        corrected?: number;
        errors?: number;
        error?: string;
      };
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? `Request failed (${response.status})`);
      }
      setReEval({
        loading: false,
        result: {
          checked: data.checked ?? 0,
          corrected: data.corrected ?? 0,
          errors: data.errors ?? 0,
        },
        error: null,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bot-all-history"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-stats"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-performance-report"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-gap-analytics"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-conviction-threshold"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-time-analytics"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-entry-timing"] }),
      ]);
    } catch (error) {
      setReEval({
        loading: false,
        result: null,
        error: error instanceof Error ? error.message : "Re-evaluation failed",
      });
    }
  }

  const status = statusQuery.data;
  const usesConviction = status?.config?.decisionMode === "conviction";

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="shared-bot-intelligence-heading">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Brain className="w-4 h-4 text-violet-400" />
        <h2 id="shared-bot-intelligence-heading" className="text-sm font-bold uppercase tracking-widest">
          Shared Bot 1 Intelligence & History
        </h2>
        <span className="text-[10px] text-muted-foreground">
          Canonical Bot 1 analytics · {mode} mode
        </span>
      </div>

      {conditionsQuery.isPending || evaluationQuery.isPending || statusQuery.isPending ? (
        <DataState label="Current market conditions" />
      ) : conditionsQuery.isError || evaluationQuery.isError || statusQuery.isError ? (
        <DataState label="Current market conditions" error />
      ) : (
        <ConditionsPanel
          conditions={conditionsQuery.data}
          evaluation={evaluationQuery.data?.evaluation ?? []}
          status={status}
        />
      )}

      {convictionQuery.isPending ? (
        <DataState label="Conviction threshold analysis" />
      ) : convictionQuery.isError ? (
        <DataState label="Conviction threshold analysis" error />
      ) : (
        <ConvictionThresholdPanel
          data={convictionQuery.data}
          currentLockPrice={status?.config?.kalshiLockPrice}
          activeMode={mode}
          maxBetStats={performanceQuery.data?.report?.maxBetStats}
          convictionPollerRunning={usesConviction ? status?.convictionPollerRunning : undefined}
          convictionPriceAgeMs={usesConviction ? status?.convictionPriceAgeMs : undefined}
        />
      )}

      {statsQuery.isPending ? (
        <DataState label="Performance by coin" />
      ) : statsQuery.isError ? (
        <DataState label="Performance by coin" error />
      ) : (
        <PerfByCoin stats={statsQuery.data} activeMode={mode} />
      )}

      {gapQuery.isPending ? (
        <DataState label="Gap analytics" />
      ) : gapQuery.isError ? (
        <DataState label="Gap analytics" error />
      ) : (
        <GapAnalyticsPanel data={gapQuery.data} activeMode={mode} />
      )}

      <div className="flex flex-wrap items-center gap-3 px-1">
        <button
          type="button"
          onClick={runReEvaluation}
          disabled={reEval.loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-sky-500/40 hover:bg-sky-500/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {reEval.loading
            ? <RefreshCw className="w-3 h-3 animate-spin" />
            : <RotateCcw className="w-3 h-3" />}
          Re-evaluate Settled Bets
        </button>
        {reEval.result && (
          <span className={`text-xs ${reEval.result.errors > 0 ? "text-amber-400" : "text-emerald-400"}`} role="status">
            Checked {reEval.result.checked} · corrected {reEval.result.corrected} · errors {reEval.result.errors}
          </span>
        )}
        {reEval.error && (
          <span className="text-xs text-amber-400" role="alert">⚠ {reEval.error}</span>
        )}
      </div>

      <TransactionLog
        pagedBets={pagedBets}
        histPage={clampedHistPage}
        setHistPage={setHistPage}
        totalHistPages={totalHistPages}
        totalBets={filteredHistory.length}
        historyMode={historyMode}
        setHistoryMode={setHistoryMode}
        histSourceFilter={histSourceFilter}
        setHistSourceFilter={setHistSourceFilter}
        activeMode={mode}
        modeLocked
        loading={historyQuery.isPending || scalperHistoryQuery.isPending}
        error={historyQuery.isError || scalperHistoryQuery.isError}
      />

      {performanceQuery.isPending ? (
        <DataState label="Performance insights" />
      ) : performanceQuery.isError ? (
        <DataState label="Performance insights" error />
      ) : (
        <PerformanceInsights
          perfReportData={performanceQuery.data}
          statsData={statsQuery.data}
          activeMode={mode}
        />
      )}

      {timingQuery.isPending ? (
        <DataState label="Timing analytics" />
      ) : timingQuery.isError ? (
        <DataState label="Timing analytics" error />
      ) : (
        <TimingAnalytics
          rows={timingQuery.data.rows}
          totalBets={timingQuery.data.totalBets}
          lastUpdated={timingQuery.data.lastUpdated}
        />
      )}

      {entryTimingQuery.isError ? (
        <DataState label="Entry timing analytics" error />
      ) : (
        <BotEntryTimingPanel
          rows={entryTimingQuery.data ?? []}
          isLoading={entryTimingQuery.isPending}
        />
      )}
    </section>
  );
}