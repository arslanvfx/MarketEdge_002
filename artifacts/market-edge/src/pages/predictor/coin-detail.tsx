import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ComposedChart, Area, Line, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip, ReferenceLine } from "recharts";
import { Activity, TrendingUp, TrendingDown, Minus, Zap, Sparkles, Loader2, CheckCircle2, Clock, ExternalLink, ArrowUp, ArrowDown, RefreshCw, Check, AlertTriangle, Bot, Lock, ChevronDown, ChevronUp, Radio, Gauge, Waves } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { CoinPrediction, AiEntry, AutoPilotDecision, KalshiTarget, TrackerWindowCall, WindowBetSignal, WMAccuracyStats, LiveDirectionResult, LiveDirectionHistoryEntry, MLPredResponse, EnsembleWeights, Prediction, DriftAlert, BetSignal } from "./types";
import { computeBetSignal } from "./types";
import { COIN_STYLE, KALSHI_COINS, DIR, formatPrice, formatPct, estCandleLabel } from "./utils";
import { Sparkline, LivePrice } from "./sparkline";

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

export function CoinDetail({
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
  windowBetSignal,
  wmAccuracy,
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
  windowBetSignal?: WindowBetSignal | null;
  wmAccuracy?: WMAccuracyStats | null;
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

  // Live-direction history — ring buffer from server (max 5 per window, clears on new window).
  // Only poll when Claude is active for this coin; mirrors the same condition as liveDirectionQuery.
  const liveDirectionHistoryQuery = useQuery<{ symbol: string; history: LiveDirectionHistoryEntry[] }>({
    queryKey: ["live-direction-history", coin.symbol],
    queryFn: () => fetch(`/api/crypto/live-direction-history/${coin.symbol}`).then((r) => r.json()),
    refetchInterval: 30_000,
    enabled: isTrainingCoin || claudeActive,
    staleTime: 25_000,
  });
  const liveDirectionHistoryEntries = liveDirectionHistoryQuery.data?.history ?? [];
  // Show last 3 entries in the UI.
  const dirHistoryTail = liveDirectionHistoryEntries.slice(-3);

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

  // ── Opening-call snapshots ───────────────────────────────────────────────
  // Capture each model's initial ABOVE/BELOW call at window open (when
  // trackerSnapshot.snappedAt changes). These are locked for the full window
  // so the "At open" row never flip-flops mid-window, and they match what the
  // accuracy log records (DB uses onConflictDoNothing — first write wins).
  // ── AT OPEN opening-call architecture ─────────────────────────────────────
  //
  // ALL opening calls are gated on statSnapshot existing (~30s into window).
  // Kalshi sometimes delays publishing the new window's target price; models
  // that lock before 30s may read a stale target and record the wrong direction.
  // statSnapshot is computed server-side at :30s against the confirmed target,
  // so using it as the gate gives every model time to catch up before we freeze
  // the AT OPEN row.  While waiting, the AT OPEN area shows "calculating…".
  //
  //   • Stat     → statSnapshot.aboveKalshi  (server-locked at snap time, no client recompute)
  //   • Claude   → first liveDirection.aboveKalshi AFTER statSnapshot exists
  //   • ML       → first mlPred.above AFTER statSnapshot exists
  //   • AutoPilot → derived from above (no separate lock needed)
  //
  // The gate key is eventTicker (Kalshi's own stable window ID), NOT snappedAt.
  // snappedAt resets on every server restart, causing mid-window false re-locks.

  const openingStatAbove: boolean | null = statSnapshot?.aboveKalshi ?? null;

  const [openingMlAbove,     setOpeningMlAbove]     = useState<boolean | null>(null);
  const [openingClaudeAbove, setOpeningClaudeAbove] = useState<boolean | null>(null);
  const mlLockedRef     = useRef<boolean>(false);
  const claudeLockedRef = useRef<boolean>(false);
  const prevTickerRef   = useRef<string | undefined>(undefined);

  const eventTicker = ktd?.eventTicker;

  // New window → reset all opening-call locks immediately.
  useEffect(() => {
    if (!eventTicker) return;
    if (eventTicker === prevTickerRef.current) return;
    prevTickerRef.current  = eventTicker;
    mlLockedRef.current    = false;
    claudeLockedRef.current = false;
    setOpeningMlAbove(null);
    setOpeningClaudeAbove(null);
  }, [eventTicker]);

  // Once statSnapshot arrives (≈30s gate), lock Claude and ML to whatever they
  // read at that moment.  If either hasn't produced data yet, re-run each time
  // that model's value updates until both are captured.
  const snapKey = statSnapshot?.snappedAt;   // stable per-window scalar dep
  useEffect(() => {
    if (!snapKey) return;   // stat snap not yet available — stay in "calculating"
    if (!claudeLockedRef.current) {
      const abv = liveDirection?.aboveKalshi;
      if (abv !== null && abv !== undefined) {
        setOpeningClaudeAbove(abv);
        claudeLockedRef.current = true;
      }
    }
    if (!mlLockedRef.current) {
      if (mlPred?.ready && mlPred.above !== null && mlPred.above !== undefined) {
        setOpeningMlAbove(mlPred.above);
        mlLockedRef.current = true;
      }
    }
  }, [snapKey, liveDirection?.aboveKalshi, mlPred?.ready, mlPred?.above]);

  // ── Force-refresh confirmation ────────────────────────────────────────────
  const [statJustRefreshed, setStatJustRefreshed] = useState(false);
  const statRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleRefreshStat() {
    onRefreshStat();
    setStatJustRefreshed(true);
    if (statRefreshTimerRef.current) clearTimeout(statRefreshTimerRef.current);
    statRefreshTimerRef.current = setTimeout(() => setStatJustRefreshed(false), 2000);
  }

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
  // When inactive (stat wins or insufficient data) → uses stat direction ONLY.
  // The confidence weight is the winning model's historical accuracy %.
  const autoPilotAbove: boolean | null = (() => {
    if (!autoPilotDecision || kalshiTarget === null) return null;
    if (autoPilotDecision.active) {
      // Priority: live mid-window Claude direction → opening Claude call →
      // live price position (never fall back to a stale window-open snapshot).
      return liveDirection?.aboveKalshi ?? claudeAbove ?? (livePrice > 0 ? livePrice >= kalshiTarget : null);
    }
    // Stat mode: stat was chosen because it outperforms Claude, so never use
    // liveDirection (a Claude call) here.  Follow the stat model's live
    // prediction; fall back to live-price position only if stat hasn't run yet.
    return statHead
      ? statHead.predictedPrice >= kalshiTarget
      : (livePrice > 0 ? livePrice >= kalshiTarget : null);
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

          {/* ── Window Monitor — below the 3-col stats row ──────────── */}
          {kalshiTarget !== null && (() => {
            const wbs: WindowBetSignal | null = windowBetSignal ?? null;
            if (!wbs) return null;

            const rec = wbs.recommendation;

            // ── Client-side time tracking ─────────────────────────────────
            // Use ktd timestamps + the 1s `now` ticker so everything ticks
            // every second without waiting for the 15s server poll.
            //
            // The monitoring period is the FIRST 5 min of the Kalshi window.
            // Kalshi windows are 15 min long, so the fallback open time is
            // closeTime - 15 min (NOT 5 min).
            const KALSHI_WINDOW_MS  = 15 * 60_000;
            const MONITOR_PERIOD_MS =  5 * 60_000;
            const winOpenMs  = ktd?.openTime  ? new Date(ktd.openTime).getTime()  : null;
            const winCloseMs = ktd?.closeTime ? new Date(ktd.closeTime).getTime() : null;
            // Best-effort open: prefer explicit openTime, fall back to closeTime − 15 min.
            const effectiveOpenMs = winOpenMs ?? (winCloseMs ? winCloseMs - KALSHI_WINDOW_MS : null);
            // End of the 5-min monitoring period.
            const monitorEndMs = effectiveOpenMs != null ? effectiveOpenMs + MONITOR_PERIOD_MS : null;
            // Seconds until monitoring ends (counts to monitorEndMs, NOT winCloseMs).
            const secsUntilReady = monitorEndMs != null
              ? Math.max(0, Math.round((monitorEndMs - now.getTime()) / 1000))
              : null;
            // Progress bar: 0→100% over the 5-min monitoring window.
            const clientElapsedMs = effectiveOpenMs != null
              ? Math.max(0, now.getTime() - effectiveOpenMs)
              : null;
            const clientProgressPct = monitorEndMs != null && clientElapsedMs != null
              ? Math.min(100, (clientElapsedMs / MONITOR_PERIOD_MS) * 100)
              : Math.min(100, (wbs.minutesElapsed / 5) * 100);
            // isReady: server OR client clock says ≥5 min elapsed.
            // Client override handles server restarts mid-window (openedAt resets
            // → minutesElapsed drops to 0 → wbs.ready stays false indefinitely).
            const clientIsReady = monitorEndMs != null && now.getTime() >= monitorEndMs;
            const isReady = wbs.ready || clientIsReady;

            const badge = isReady
              ? rec === "bet"
                ? { label: "✓ BET", cls: "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30" }
                : rec === "stay_away"
                ? { label: "✕ STAY AWAY", cls: "bg-red-500/15 text-red-400 ring-1 ring-red-500/30" }
                : { label: "⚠ CAUTION", cls: "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30" }
              : { label: "MONITORING…", cls: "bg-muted/30 text-muted-foreground ring-1 ring-border/30" };

            const factorColor = isReady
              ? rec === "bet" ? "text-emerald-400/80"
              : rec === "stay_away" ? "text-red-400/80"
              : "text-amber-400/80"
              : "text-muted-foreground/60";

            // Time-left label counts to the end of the 5-min monitoring period.
            const timeLeftLabel = (() => {
              if (secsUntilReady === null) return null;
              if (secsUntilReady <= 0) return "almost ready";
              if (secsUntilReady < 60) return `${secsUntilReady}s left`;
              const m = Math.floor(secsUntilReady / 60);
              const s = secsUntilReady % 60;
              return s === 0 ? `${m}m left` : `${m}m ${s}s left`;
            })();
            // Elapsed counter: capped at 5:00 once monitoring is done.
            const elapsedSecs = Math.min(
              Math.round((clientElapsedMs ?? 0) / 1000),
              5 * 60,
            );
            const elapsedLabel = `${Math.floor(elapsedSecs / 60)}:${String(elapsedSecs % 60).padStart(2, "0")} / 5:00`;

            return (
              <div className="px-5 py-3 border-t border-[#00C805]/15">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
                    <Activity className="w-3 h-3" />
                    Window Monitor
                    <span className="text-muted-foreground/40 font-normal normal-case tracking-normal">· first 5 min</span>
                  </div>
                  <div className={`px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${badge.cls}`}>
                    {badge.label}
                  </div>
                </div>

                {!isReady ? (
                  <>
                    <div className="text-[11px] text-muted-foreground/70 mb-2">
                      Watching first 5 min for flip-flopping…{" "}
                      <span className="text-muted-foreground/50">{timeLeftLabel ?? "calculating…"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary/50"
                          style={{ width: `${clientProgressPct}%`, transition: "width 0.9s linear" }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
                        {elapsedLabel}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className={`text-[11px] mb-2 ${rec === "bet" ? "text-emerald-400/80" : rec === "stay_away" ? "text-red-400/80" : "text-amber-400/80"}`}>
                    {wbs.reason}
                  </div>
                )}

                <div className={`flex items-center gap-3 text-[10px] mt-1.5 flex-wrap ${factorColor}`}>
                  {wbs.preWindowER !== null && (
                    <>
                      <span className="flex items-center gap-1">
                        <span className="opacity-60 font-medium">pre-window ER</span>{" "}
                        <span className="font-bold tabular-nums">{wbs.preWindowER.toFixed(2)}</span>
                        <span className={`ml-0.5 px-1 py-px rounded text-[9px] font-semibold ${
                          wbs.preWindowER >= 0.30
                            ? "bg-emerald-500/15 text-emerald-400"
                            : wbs.preWindowER >= 0.25
                            ? "bg-amber-500/15 text-amber-400"
                            : "bg-red-500/15 text-red-400"
                        }`}>
                          {wbs.preWindowER >= 0.30 ? "trending" : wbs.preWindowER >= 0.25 ? "borderline" : "choppy"}
                        </span>
                      </span>
                      <span className="opacity-40">·</span>
                    </>
                  )}
                  <span className="opacity-70">window ER <span className="font-bold tabular-nums">{wbs.factors.efficiencyRatio.toFixed(2)}</span></span>
                  <span className="opacity-40">·</span>
                  <span><span className="font-bold tabular-nums">{wbs.factors.oscillationCount}</span> reversals</span>
                  <span className="opacity-40">·</span>
                  <span>{wbs.factors.spikeFlag ? "⚠ spike" : "no spike"}</span>
                </div>

                {wmAccuracy && (() => {
                  const betAcc = wmAccuracy.bet.accuracy;
                  const saAcc  = wmAccuracy.stay_away.accuracy;
                  const betTotal = wmAccuracy.bet.total;
                  const saTotal  = wmAccuracy.stay_away.total;
                  if (betTotal === 0 && saTotal === 0) return null;
                  return (
                    <div className="flex items-center gap-3 text-[10px] mt-2 pt-2 border-t border-[#00C805]/10 text-muted-foreground/60">
                      <span className="uppercase tracking-wide font-semibold text-muted-foreground/40">7d accuracy</span>
                      {betTotal > 0 && (
                        <span className={`${betAcc !== null && betAcc >= 0.55 ? "text-emerald-400/70" : "text-amber-400/60"}`}>
                          BET <span className="font-bold tabular-nums">{betAcc !== null ? `${Math.round(betAcc * 100)}%` : "—"}</span>
                          <span className="opacity-60"> ({betTotal})</span>
                        </span>
                      )}
                      {betTotal > 0 && saTotal > 0 && <span className="opacity-40">·</span>}
                      {saTotal > 0 && (
                        <span className={`${saAcc !== null && saAcc >= 0.55 ? "text-emerald-400/70" : "text-amber-400/60"}`}>
                          STAY AWAY <span className="font-bold tabular-nums">{saAcc !== null ? `${Math.round(saAcc * 100)}%` : "—"}</span>
                          <span className="opacity-60"> ({saTotal})</span>
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

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
                    {/* Live-direction confidence timeline — last 3 Claude re-checks this window */}
                    {dirHistoryTail.length > 0 && (
                      <div className="mt-2.5 flex items-center justify-center gap-1" title="Claude live re-check history this window (oldest → newest)">
                        {dirHistoryTail.map((h, i) => {
                          const isAbove = h.aboveKalshi !== null ? h.aboveKalshi : h.direction === "up";
                          const isLast = i === dirHistoryTail.length - 1;
                          const timeStr = new Date(h.at).toLocaleTimeString("en-US", {
                            hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
                          });
                          return (
                            <span key={h.at} title={`${timeStr} ET — ${isAbove ? "ABOVE" : "BELOW"} ${h.confidence}% conf`}
                              className={`inline-flex flex-col items-center gap-0.5 rounded px-1 py-0.5 ${
                                isAbove
                                  ? isLast ? "bg-emerald-500/20 text-emerald-400" : "bg-emerald-500/8 text-emerald-400/50"
                                  : isLast ? "bg-red-500/20 text-red-400" : "bg-red-500/8 text-red-400/50"
                              }`}>
                              <span className="text-[8px] font-black leading-none">{isAbove ? "▲" : "▼"}</span>
                              <span className="text-[7px] font-semibold tabular-nums leading-none">{h.confidence}%</span>
                            </span>
                          );
                        })}
                        <span className="text-[7px] text-muted-foreground/30 ml-0.5">pulse</span>
                      </div>
                    )}
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
                      ) : mlPred.ready ? (
                        // Model is trained but window is expired or prediction not yet available
                        <div className="text-[11px] text-muted-foreground/50 italic mt-1">
                          Awaiting window…
                          <div className="text-[10px] text-sky-400/40 mt-1 not-italic tabular-nums">
                            {mlPred.windows}w collected
                          </div>
                        </div>
                      ) : (
                        // Still accumulating training data
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
                {/* Always render the footer when we have live signals or a Kalshi
                    window — AT OPEN shows a "calculating" placeholder until the
                    first snap arrives rather than popping in out of nowhere. */}
                {(consensusSignals.length > 0 || kalshiTarget !== null) && (
                  <div className="px-5 py-4 border-t border-[#00C805]/20 bg-background/10 space-y-3">

                    {/* Live signal bubbles */}
                    {consensusSignals.length > 0 && (
                      <div className="space-y-2">

                        {/* Header: LIVE chip left, Refresh right — always on one line */}
                        <div className="flex items-center justify-between">
                          <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 border border-border/50 px-2 py-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60">Live</span>
                          </div>
                          <button
                            onClick={handleRefreshStat}
                            disabled={statLoading}
                            title="Force-refresh all models"
                            className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1.5 rounded-lg border transition-all ${
                              statJustRefreshed
                                ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/30 border-border/40"
                            } disabled:opacity-40`}
                          >
                            {statJustRefreshed ? (
                              <><Check className="w-3 h-3" /> Refreshed</>
                            ) : (
                              <><RefreshCw className={`w-3 h-3 ${statLoading ? "animate-spin" : ""}`} /> Refresh</>
                            )}
                          </button>
                        </div>

                        {/* Signal pills + agree badge — free to wrap */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {consensusSignals.map((sig) => {
                            const isAP = sig.name === "Auto-Pilot";
                            const isML = sig.name === "ML Model";
                            const bubbleCls = sig.above
                              ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/25"
                              : "bg-red-500/10 text-red-400 ring-red-500/25";
                            const nameCls = isAP ? "text-violet-300" : isML ? "text-sky-300" : "";
                            return (
                              <div
                                key={sig.name}
                                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ring-1 ${bubbleCls}`}
                                title={isAP
                                  ? `Auto-Pilot · via ${sig.modelUsed === "claude" ? "Claude" : "Stat"} · ${sig.conf.toFixed(0)}% historical acc`
                                  : isML
                                  ? `ML Model · logistic regression · ${sig.conf}% confidence`
                                  : sig.name === "Stat"
                                  ? `Stat model · ${sig.conf}% conf`
                                  : `Claude AI · ${sig.conf}% conf`}
                              >
                                {sig.above ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />}
                                <span className={nameCls}>{sig.name}</span>
                                {isAP && sig.modelUsed && (
                                  <span className="text-[9px] font-medium text-violet-300/60">({sig.modelUsed === "claude" ? "C" : "S"})</span>
                                )}
                                {isML && mlPred?.valAccuracy != null && (
                                  <span className="text-[9px] font-medium text-sky-300/60">({mlPred.valAccuracy}%)</span>
                                )}
                              </div>
                            );
                          })}
                          {consensusSignals.length > 1 && (
                            <div className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold ring-1 ${
                              allConsensusAgree
                                ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
                                : "bg-amber-500/15 text-amber-400 ring-amber-500/30"
                            }`}>
                              {consensusAgreement}/{consensusSignals.length} agree
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* At-open historical bubbles — always visible; "calculating" until snap */}
                    {kalshiTarget !== null && (() => {
                      // No stat snapshot yet (first ~30 s of window) — show placeholder.
                      // statSnapshot is the gate because it's always available regardless
                      // of whether Claude is running; trackerSnapshot (Claude-only) is null
                      // when Claude is paused by auto-pilot and must never be the gate.
                      if (!statSnapshot) {
                        return (
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/30 border border-border/30 px-2 py-1 shrink-0">
                              <Clock className="w-2.5 h-2.5 text-muted-foreground/50" />
                              <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">At open</span>
                            </div>
                            <span className="text-[9px] text-muted-foreground/35 italic animate-pulse">calculating…</span>
                          </div>
                        );
                      }
                      const statAboveNow = statHead ? statHead.predictedPrice >= kalshiTarget : null;
                      const statFlippedMid = openingStatAbove !== null && statAboveNow !== null && openingStatAbove !== statAboveNow;
                      // Claude's opening call: locked to the first liveDirection.aboveKalshi
                      // for this window (same signal Auto-Pilot uses live). Falls back to
                      // trackerSnapshot if liveDirection hasn't arrived yet.
                      const claudeAboveOpen = openingClaudeAbove ?? (trackerSnapshot?.aboveKalshi ?? null);
                      // Flip detection: compare opening liveDirection vs. current liveDirection
                      // (same method on both sides — price-prediction mapping not involved).
                      const claudeFlippedMid = claudeAboveOpen !== null
                        && liveDirection?.aboveKalshi !== null && liveDirection?.aboveKalshi !== undefined
                        && claudeAboveOpen !== liveDirection.aboveKalshi;
                      // Auto-Pilot opening call: same routing logic as the live autoPilotAbove
                      // but using locked opening values for stat and Claude.
                      const openingAutoPilotAbove: boolean | null = (() => {
                        if (!autoPilotDecision) return null;
                        if (autoPilotDecision.active) {
                          return claudeAboveOpen ?? openingStatAbove;
                        }
                        return openingStatAbove;
                      })();
                      const apFlippedMid = openingAutoPilotAbove !== null && autoPilotAbove !== null
                        && openingAutoPilotAbove !== autoPilotAbove;
                      // ML opening call: prefer locked state, fall back to current mlPred if
                      // the lock somehow missed (e.g. mlPred arrived before eventTicker).
                      const mlAboveOpen = openingMlAbove
                        ?? (mlPred?.ready && mlPred.above !== null && mlPred.above !== undefined
                          ? mlPred.above : null);
                      const mlFlippedMid = mlAboveOpen !== null && mlPred?.above !== null && mlPred?.above !== undefined
                        && mlAboveOpen !== mlPred.above;
                      // Combined at-open: majority vote of all locked opening signals (stat + auto-pilot + claude + ML)
                      const atOpenSignals: boolean[] = [
                        ...(openingStatAbove       !== null ? [openingStatAbove]       : []),
                        ...(openingAutoPilotAbove  !== null ? [openingAutoPilotAbove]  : []),
                        ...(claudeAboveOpen        !== null ? [claudeAboveOpen]        : []),
                        ...(mlAboveOpen             !== null ? [mlAboveOpen]             : []),
                      ];
                      const atOpenAbove = atOpenSignals.filter(Boolean).length;
                      const atOpenBelow = atOpenSignals.length - atOpenAbove;
                      const openingSplit = atOpenAbove > 0 && atOpenBelow > 0;
                      const openingEnsembleAbove = !openingSplit && atOpenSignals.length > 1 ? atOpenAbove > atOpenBelow : null;
                      const ensembleFlippedMid = openingEnsembleAbove !== null && combinedHead?.above != null
                        ? openingEnsembleAbove !== combinedHead.above : false;
                      const anyFlipped = statFlippedMid || apFlippedMid || claudeFlippedMid || mlFlippedMid || ensembleFlippedMid;
                      return (
                        <div className="flex items-center gap-2 flex-wrap">

                          {/* At open label chip */}
                          <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/30 border border-border/30 px-2 py-1 shrink-0">
                            <Clock className="w-2.5 h-2.5 text-muted-foreground/50" />
                            <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">At open</span>
                            <span className="text-[9px] text-muted-foreground/40">·</span>
                            <span className="text-[9px] text-muted-foreground/55 font-medium tabular-nums">
                              {new Date(statSnapshot.snappedAt).toLocaleTimeString("en-US", {
                                hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
                              })} ET
                            </span>
                          </div>

                          {/* Strike proximity chip — green=clear edge (>0.1%), amber=moderate (0.03-0.1%), red=on the line (<0.03%) */}
                          {statSnapshot.strikeProximityPct != null && (() => {
                            const p = statSnapshot.strikeProximityPct!;
                            const isEdge = p >= 0.1;
                            const isMod  = p >= 0.03 && p < 0.1;
                            const cls = isEdge
                              ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/25"
                              : isMod
                              ? "bg-amber-500/10 text-amber-400 ring-amber-500/25"
                              : "bg-red-500/10 text-red-400/80 ring-red-500/20";
                            const label = isEdge
                              ? `${p.toFixed(2)}% from strike — clear edge`
                              : isMod
                              ? `${p.toFixed(2)}% from strike — moderate`
                              : `${p.toFixed(2)}% from strike — on the line`;
                            return (
                              <div className={`inline-flex items-center rounded-md ring-1 px-2 py-1 text-[9px] font-medium shrink-0 ${cls}`}>
                                {label}
                              </div>
                            );
                          })()}

                          {openingStatAbove !== null && (
                            <div className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${
                              openingStatAbove
                                ? "bg-emerald-500/6 text-emerald-400/70 ring-emerald-500/15"
                                : "bg-red-500/6 text-red-400/70 ring-red-500/15"
                            }`}>
                              {openingStatAbove ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span>Stat</span>
                              {statFlippedMid && (
                                <span className="ml-0.5 text-[9px] font-bold text-amber-400 bg-amber-500/15 rounded px-1">
                                  → {statAboveNow ? "↑" : "↓"} now
                                </span>
                              )}
                            </div>
                          )}

                          {openingAutoPilotAbove !== null && (
                            <div className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${
                              openingAutoPilotAbove
                                ? "bg-emerald-500/6 text-emerald-400/70 ring-emerald-500/15"
                                : "bg-red-500/6 text-red-400/70 ring-red-500/15"
                            }`}>
                              {openingAutoPilotAbove ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span className="text-blue-300/80">Auto-Pilot</span>
                              {apFlippedMid && (
                                <span className="ml-0.5 text-[9px] font-bold text-amber-400 bg-amber-500/15 rounded px-1">
                                  → {autoPilotAbove ? "↑" : "↓"} now
                                </span>
                              )}
                            </div>
                          )}

                          {claudeAboveOpen !== null && (
                            <div className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${
                              claudeAboveOpen
                                ? "bg-emerald-500/6 text-emerald-400/70 ring-emerald-500/15"
                                : "bg-red-500/6 text-red-400/70 ring-red-500/15"
                            }`}>
                              {claudeAboveOpen ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span className="text-violet-300/80">Claude</span>
                              {claudeFlippedMid && liveDirection && (
                                <span className="ml-0.5 text-[9px] font-bold text-amber-400 bg-amber-500/15 rounded px-1">
                                  → {liveDirection.aboveKalshi ? "↑" : "↓"} now
                                </span>
                              )}
                            </div>
                          )}

                          {mlAboveOpen !== null && (
                            <div className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${
                              mlAboveOpen
                                ? "bg-emerald-500/6 text-emerald-400/70 ring-emerald-500/15"
                                : "bg-red-500/6 text-red-400/70 ring-red-500/15"
                            }`}>
                              {mlAboveOpen ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                              <span className="text-sky-300/80">ML</span>
                              {mlFlippedMid && (
                                <span className="ml-0.5 text-[9px] font-bold text-amber-400 bg-amber-500/15 rounded px-1">
                                  → {mlPred!.above ? "↑" : "↓"} now
                                </span>
                              )}
                            </div>
                          )}

                          {(openingEnsembleAbove !== null || openingSplit) && (
                            <div className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${
                              openingSplit
                                ? "bg-amber-500/6 text-amber-400/70 ring-amber-500/15"
                                : openingEnsembleAbove
                                ? "bg-emerald-500/6 text-emerald-400/70 ring-emerald-500/15"
                                : "bg-red-500/6 text-red-400/70 ring-red-500/15"
                            }`}>
                              {!openingSplit && (openingEnsembleAbove ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />)}
                              <span className="text-primary/70">Combined</span>
                              {openingSplit && <span className="ml-0.5 text-[9px] font-bold">split</span>}
                              {ensembleFlippedMid && (
                                <span className="ml-0.5 text-[9px] font-bold text-amber-400 bg-amber-500/15 rounded px-1">
                                  → {combinedHead!.above ? "↑" : "↓"} now
                                </span>
                              )}
                            </div>
                          )}

                          {!anyFlipped && (
                            <span className="text-[9px] text-muted-foreground/40 italic">no change since open</span>
                          )}
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
            <div className="flex items-center gap-2 flex-wrap">
              {consensusSignals.map((sig) => {
                const isAP = sig.name === "Auto-Pilot";
                const isML = sig.name === "ML Model";
                const bubbleCls = sig.above
                  ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/25"
                  : "bg-red-500/10 text-red-400 ring-red-500/25";
                const nameCls = isAP ? "text-violet-300" : isML ? "text-sky-300" : "";
                return (
                  <div key={sig.name} className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ring-1 ${bubbleCls}`}>
                    {sig.above ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />}
                    <span className={nameCls}>{sig.name}</span>
                    {isAP && sig.modelUsed && (
                      <span className="text-[9px] font-medium text-violet-300/60">({sig.modelUsed === "claude" ? "C" : "S"})</span>
                    )}
                    {isML && mlPred?.valAccuracy != null && (
                      <span className="text-[9px] font-medium text-sky-300/60">({mlPred.valAccuracy}%)</span>
                    )}
                  </div>
                );
              })}
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
