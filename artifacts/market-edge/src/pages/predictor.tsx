import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Radio } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

import type {
  CoinPrediction, CoinPrice, AiEntry, AiSettings, AutoPilotDecision,
  KalshiTarget, TrackerWindowCall, WindowBetSignal, WMAccuracyStats,
  LiveDirectionResult, MLPredResponse, EnsembleWeights, DriftAlert,
  TimingAnalysisRow, CoinAnalytics, AIPredictionItem,
} from "./predictor/types";
import { KALSHI_COINS, API_BASE, fetchJson, estClock, etAbbrev, formatPct } from "./predictor/utils";
import { Sparkline, LivePrice } from "./predictor/sparkline";
import { KalshiBtcCard } from "./predictor/kalshi-btc-card";
import { SelfLearningDashboard } from "./predictor/self-learning-dashboard";
import { TradingWindowsPanel } from "./predictor/trading-windows-panel";
import { PredictionHistory } from "./predictor/prediction-history";
import { KalshiBotPanel } from "./predictor/kalshi-bot-panel";
import { CoinDetail } from "./predictor/coin-detail";
import { CoinGrid } from "./predictor/coin-grid";
import { EntryTimingPanel } from "./predictor/entry-timing-panel";

export default function Predictor() {
  const [selected, setSelected] = useState("BTC");
  const [timingAnalysisOpen, setTimingAnalysisOpen] = useState(false);
  const [now, setNow] = useState(new Date());
  const [aiData, setAiData] = useState<Record<string, AiEntry>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [autoTriggerReason, setAutoTriggerReason] = useState<string | null>(null);
  const [driftAlerts, setDriftAlerts] = useState<Record<string, DriftAlert>>({});
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
    trainingCoins: ["BTC", "ETH", "XRP", "HYPE", "BNB", "DOGE"],
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
  // Free (in-memory lookup on the server), safe to poll every 15s.
  const trackerSnapshotQuery = useQuery({
    queryKey: ["tracker-snapshot", selected],
    queryFn: () => fetchJson<{ snapshot: TrackerWindowCall | null; statSnapshot: TrackerWindowCall | null; windowBetSignal: WindowBetSignal | null }>(`/crypto/tracker-snapshot/${selected}`),
    refetchInterval: 15_000,
    // Also enable for any coin with an active Kalshi window so the Window Monitor card works.
    enabled: trainingCoinsSet.has(selected) || claudeEnabledSet.has(selected) || (autoPilotMap.get(selected)?.active ?? false) || kalshiAvailableTop,
  });

  // When the Kalshi event ticker changes (new window), immediately re-fetch
  // the tracker snapshot so the Window Monitor resets to "MONITORING…" without
  // waiting up to 15 s for the next scheduled poll to arrive.
  // Also auto-trigger Claude Enhanced Analysis for the displayed coin so the
  // enhanced panel populates without manual clicking.
  const prevKalshiTickerRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!kalshiEventTicker) return;
    if (kalshiEventTicker !== prevKalshiTickerRef.current) {
      const isNewWindow = prevKalshiTickerRef.current !== undefined;
      prevKalshiTickerRef.current = kalshiEventTicker;
      void trackerSnapshotQuery.refetch();
      if (isNewWindow) {
        // Clear stale enhance result from the previous window.
        setAiData((prev) => {
          const n = { ...prev };
          delete n[selected];
          return n;
        });
        // Auto-run Claude Enhanced Analysis for the currently displayed coin.
        setAutoTriggerReason("New window — Kalshi strike updated");
        void handleEnhance();
      }
    }
  // handleEnhance and trackerSnapshotQuery are stable for the window lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kalshiEventTicker]);

  // Restore a manual re-analysis result that survived a hard refresh.
  // sessionStorage is preserved across hard refreshes (Ctrl+Shift+R) but
  // cleared when the tab closes.  The key includes eventTicker so a stored
  // result from the previous window is silently ignored.
  useEffect(() => {
    if (!kalshiEventTicker || !selected) return;
    // Only restore if we don't already have a result for this coin.
    if (aiData[selected]) return;
    const key = `ai-enhance:${selected.toUpperCase()}:${kalshiEventTicker}`;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AiEntry & { at: string };
      setAiData((prev) => {
        if (prev[selected]) return prev; // raced — already set
        return {
          ...prev,
          [selected]: {
            preds: parsed.preds,
            at: new Date(parsed.at),
            priceAtRun: parsed.priceAtRun,
            eventTickerAtRun: parsed.eventTickerAtRun,
            ensembleWeights: parsed.ensembleWeights,
            abstainMinConf: parsed.abstainMinConf,
          },
        };
      });
    } catch { /* corrupt entry — ignore */ }
  // aiData intentionally excluded — we only want to restore once (on first
  // load / ticker arrival), not re-run every time aiData changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kalshiEventTicker, selected]);

  const wmAccuracyQuery = useQuery({
    queryKey: ["wm-accuracy", selected],
    queryFn: () => fetchJson<WMAccuracyStats>(`/crypto/window-monitor-accuracy/${selected}`),
    refetchInterval: 5 * 60_000,
    enabled: kalshiAvailableTop || trainingCoinsSet.has(selected),
    staleTime: 4 * 60_000,
  });

  const timingAnalysisQuery = useQuery({
    queryKey: ["timing-analysis", selected],
    queryFn: () => fetchJson<TimingAnalysisRow[]>(`/crypto/timing-analysis?symbol=${selected}`),
    refetchInterval: 15 * 60_000,
    enabled: kalshiAvailableTop,
    staleTime: 10 * 60_000,
  });

  const timingAnalysis7dQuery = useQuery({
    queryKey: ["timing-analysis-7d", selected],
    queryFn: () => fetchJson<TimingAnalysisRow[]>(`/crypto/timing-analysis?symbol=${selected}&days=7`),
    refetchInterval: 15 * 60_000,
    enabled: kalshiAvailableTop,
    staleTime: 10 * 60_000,
  });
  const trackerSnapshot = trackerSnapshotQuery.data?.snapshot ?? null;
  const statSnapshot = trackerSnapshotQuery.data?.statSnapshot ?? null;
  const windowBetSignal = trackerSnapshotQuery.data?.windowBetSignal ?? null;

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
    // Also enable for coins auto-pilot is actively running Claude on.
    enabled: trainingCoinsSet.has(selected) || claudeEnabledSet.has(selected) || (autoPilotMap.get(selected)?.active ?? false),
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
    // are stat-only (no API cost). For training coins auto-pilot decides whether
    // Claude is actually running; the toggle here only records user intent.
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
      const res = await fetch(`${API_BASE}/crypto/ai-predict?symbol=${sym}&force=1`, { signal: abort.signal });
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
      const newEntry: AiEntry = {
        preds: data.predictions,
        at: new Date(data.generatedAt),
        priceAtRun: priceSnapshot,
        eventTickerAtRun: tickerSnapshot,
        ensembleWeights: data.ensembleWeights,
        abstainMinConf: data.abstainMinConf,
      };
      setAiData((prev) => ({ ...prev, [sym]: newEntry }));
      // Persist across hard refreshes — keyed by (symbol, eventTicker) so
      // the stored result is automatically ignored for a different window.
      if (tickerSnapshot) {
        try {
          sessionStorage.setItem(
            `ai-enhance:${sym}:${tickerSnapshot}`,
            JSON.stringify({ ...newEntry, at: data.generatedAt }),
          );
        } catch { /* quota exceeded — silently skip */ }
      }
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
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

        <CoinGrid
          coins={coins}
          priceMap={priceMap}
          accuracyMap={accuracyMap}
          trainingCoinsSet={trainingCoinsSet}
          autoPilotMap={autoPilotMap}
          autoPilot={autoPilot}
          claudeEnabledSet={claudeEnabledSet}
          selected={selected}
          onSelect={setSelected}
          livePrice={livePrice}
          tz={tz}
          isLoading={predQuery.isLoading}
        />

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
            windowBetSignal={windowBetSignal}
            wmAccuracy={wmAccuracyQuery.data ?? null}
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


        {kalshiAvailableTop && (
          <EntryTimingPanel
            open={timingAnalysisOpen}
            onToggle={() => setTimingAnalysisOpen((v) => !v)}
            timingRows={timingAnalysisQuery.data ?? []}
            timing7dRows={timingAnalysis7dQuery.data ?? []}
            selected={selected}
            isLoading={timingAnalysisQuery.isLoading}
          />
        )}

        <KalshiBotPanel />

        <PredictionHistory symbol={selected} tz={tz} />
      </div>
    </div>
  );
}
