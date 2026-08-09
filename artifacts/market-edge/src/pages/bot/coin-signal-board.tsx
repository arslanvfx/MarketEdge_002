import { useRef, useState, useEffect } from "react";
import { ArrowUp, ArrowDown, Brain, Cpu, BarChart2, Activity, Zap, TrendingUp, Clock } from "lucide-react";
import type { CoinSignals, CoinStabilityResult, TrajectoryGateResult } from "./types";
import { wkToEstRange, ET_LABEL } from "./utils";

interface StabilityThresholds {
  minER?: number;
  maxOsc?: number;
  maxVolPct?: number;
  minMLConf?: number;
  strikeProximityMinPct?: number;                          // global minimum gap% before conviction FOK fires
  strikeProximityAtrScale?: boolean;                       // when true, effective threshold is ATR-scaled
  strikeProximityMinPctOverrides?: Record<string, number>; // per-coin overrides (priority over global)
}

interface TrajectoryThresholds {
  dangerBandPct?: number;
}

interface CoinSignalBoardProps {
  liveSignals: Record<string, CoinSignals>;
  kalshiTargets: Record<string, number | null>;
  windowKey?: string | null;
  decisionMode?: string | null;
  coinStability?: Record<string, CoinStabilityResult>;
  coinTrajectory?: Record<string, TrajectoryGateResult>;
  stabilityConfig?: StabilityThresholds | null;
  trajectoryConfig?: TrajectoryThresholds | null;
  maxBetMinWindowEntryMinutes?: number | null;
  extremeCautionAborted?: string[];
  /** Per-coin direction block info when the conviction guard is actively blocking entry. Cleared when guard passes. */
  convictionDirectionBlocked?: Record<string, { direction: "yes" | "no"; gate: "tick" | "candle-decline" | "candle-rise"; slopePct?: number; effectiveThreshold?: number; lookback?: number; fromPrice?: number; toPrice?: number }>;
  activeScheduleBracket?: { minutesElapsed: number; betAmount: number } | null;
}

function Dir({ above, confidence }: { above: boolean | null; confidence: number | null }) {
  if (above === null) {
    return <span className="text-muted-foreground/40 text-xs font-mono">—</span>;
  }
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold text-xs tabular-nums ${above ? "text-emerald-400" : "text-red-400"}`}>
      {above ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {confidence != null ? `${confidence.toFixed(0)}%` : above ? "YES" : "NO"}
    </span>
  );
}

function AgreementBadge({ signals }: { signals: CoinSignals }) {
  const votes = [signals.statAbove, signals.claudeAbove, signals.mlAbove].filter((v) => v !== null);
  if (votes.length === 0) return <span className="text-muted-foreground/40 text-xs">—</span>;
  const upVotes = votes.filter(Boolean).length;
  const downVotes = votes.filter((v) => !v).length;
  if (upVotes === votes.length) {
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">↑ All agree</span>;
  }
  if (downVotes === votes.length) {
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/25">↓ All agree</span>;
  }
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">{upVotes}↑ {downVotes}↓ Split</span>;
}

function fmtStrike(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

function MetricPill({ value, ok }: { value: string; ok: boolean }) {
  return (
    <span className={`inline-flex text-[10px] font-mono px-1.5 py-0.5 rounded border tabular-nums ${ok ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"}`}>
      {value}
    </span>
  );
}

const COIN_ORDER = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "HYPE", "NEAR", "ZEC"];

export function CoinSignalBoard({ liveSignals, kalshiTargets, windowKey, decisionMode, coinStability, coinTrajectory, stabilityConfig, trajectoryConfig, maxBetMinWindowEntryMinutes, extremeCautionAborted, convictionDirectionBlocked, activeScheduleBracket }: CoinSignalBoardProps) {
  const isConviction = decisionMode === "conviction";
  const pinnedStrikes = useRef<Record<string, number>>({});
  for (const [sym, val] of Object.entries(kalshiTargets)) {
    if (val != null) pinnedStrikes.current[sym] = val;
  }
  const syms = COIN_ORDER.filter((s) => s in liveSignals);
  if (syms.length === 0) return null;

  if (isConviction) {
    return (
      <MarketConditionsBoard
        syms={syms}
        pinnedStrikes={pinnedStrikes.current}
        liveSignals={liveSignals}
        coinStability={coinStability}
        coinTrajectory={coinTrajectory}
        windowKey={windowKey}
        stabilityConfig={stabilityConfig}
        trajectoryConfig={trajectoryConfig}
        maxBetMinWindowEntryMinutes={maxBetMinWindowEntryMinutes}
        extremeCautionAborted={extremeCautionAborted}
        convictionDirectionBlocked={convictionDirectionBlocked}
        activeScheduleBracket={activeScheduleBracket}
      />
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border">
        <Activity className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm text-foreground">Live Signals</h2>
        {windowKey && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/25 font-mono">
            Window {wkToEstRange(windowKey)} {ET_LABEL}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-1">mirrored from predictor · updates every 5 s</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left px-5 py-2 font-medium w-16">Coin</th>
              <th className="text-left px-3 py-2 font-medium">Strike</th>
              <th className="text-left px-3 py-2 font-medium"><span className="inline-flex items-center gap-1"><BarChart2 className="w-3 h-3" />Stat</span></th>
              <th className="text-left px-3 py-2 font-medium"><span className="inline-flex items-center gap-1"><Brain className="w-3 h-3" />Claude</span></th>
              <th className="text-left px-3 py-2 font-medium"><span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3" />ML</span></th>
              <th className="text-left px-3 py-2 font-medium">Agreement</th>
            </tr>
          </thead>
          <tbody>
            {syms.map((sym) => {
              const s = liveSignals[sym];
              const strike = pinnedStrikes.current[sym] ?? null;
              return (
                <tr key={sym} className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-5 py-2.5 font-bold text-foreground">{sym}</td>
                  <td className="px-3 py-2.5 font-mono text-foreground/60 text-[11px]">{fmtStrike(strike)}</td>
                  <td className="px-3 py-2.5"><Dir above={s.statAbove} confidence={s.statConfidence} /></td>
                  <td className="px-3 py-2.5">
                    {s.claudeAbove !== null ? (
                      <span className={s.claudeEnabled ? "" : "opacity-60"} title={s.claudeEnabled ? undefined : "Claude running (passive)"}>
                        <Dir above={s.claudeAbove} confidence={s.claudeConfidence} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs font-mono">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5"><Dir above={s.mlAbove} confidence={s.mlConfidence} /></td>
                  <td className="px-3 py-2.5"><AgreementBadge signals={s} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface MarketConditionsBoardProps {
  syms: string[];
  pinnedStrikes: Record<string, number>;
  liveSignals: Record<string, CoinSignals>;
  coinStability?: Record<string, CoinStabilityResult>;
  coinTrajectory?: Record<string, TrajectoryGateResult>;
  windowKey?: string | null;
  stabilityConfig?: StabilityThresholds | null;
  trajectoryConfig?: TrajectoryThresholds | null;
  maxBetMinWindowEntryMinutes?: number | null;
  extremeCautionAborted?: string[];
  convictionDirectionBlocked?: Record<string, { direction: "yes" | "no"; gate: "tick" | "candle-decline" | "candle-rise"; slopePct?: number; effectiveThreshold?: number; lookback?: number; fromPrice?: number; toPrice?: number }>;
  activeScheduleBracket?: { minutesElapsed: number; betAmount: number } | null;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function MarketConditionsBoard({ syms, pinnedStrikes, liveSignals, coinStability, coinTrajectory, windowKey, stabilityConfig, trajectoryConfig, maxBetMinWindowEntryMinutes, extremeCautionAborted, convictionDirectionBlocked, activeScheduleBracket }: MarketConditionsBoardProps) {
  const minER                 = stabilityConfig?.minER                 ?? 0.30;
  const maxOsc                = stabilityConfig?.maxOsc                ?? 8;
  const maxVolPct             = stabilityConfig?.maxVolPct             ?? 3.0;
  const minMLConf             = stabilityConfig?.minMLConf             ?? 52;
  const proximityMinPct       = stabilityConfig?.strikeProximityMinPct ?? 0.30;
  const proximityAtrScale     = stabilityConfig?.strikeProximityAtrScale ?? true;
  const proximityOverrides    = stabilityConfig?.strikeProximityMinPctOverrides ?? {};
  // Priority: per-coin override → global threshold (matches getEffectiveProximityThreshold backend)
  const getProximityThreshold = (sym: string) => proximityOverrides[sym] ?? proximityMinPct;
  const dangerBand            = trajectoryConfig?.dangerBandPct         ?? 0.15;

  const now = useNow(10_000);
  const maxBetGateS = (maxBetMinWindowEntryMinutes ?? 0) * 60;
  const windowStartMs = windowKey ? new Date(windowKey + ":00Z").getTime() : null;
  const clockElapsedS = windowStartMs != null && Number.isFinite(windowStartMs) ? Math.max(0, (now - windowStartMs) / 1000) : null;
  const gateActive = maxBetGateS > 0 && clockElapsedS != null && clockElapsedS < maxBetGateS;
  const gateSecondsLeft = gateActive && clockElapsedS != null ? maxBetGateS - clockElapsedS : 0;
  const gateMinsLeft = Math.ceil(gateSecondsLeft / 60);

  const hasStability = coinStability && Object.keys(coinStability).length > 0;
  const stableCount = hasStability ? syms.filter(s => coinStability![s]?.stable === true).length : 0;
  const hasTrajectory = coinTrajectory && Object.keys(coinTrajectory).length > 0;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border">
        <TrendingUp className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm text-foreground">Market Conditions</h2>
        {windowKey && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/25 font-mono">
            Window {wkToEstRange(windowKey)} {ET_LABEL}
          </span>
        )}
        {hasStability && (
          <span className="text-xs text-muted-foreground ml-auto">
            <span className="text-emerald-400 font-medium">{stableCount}</span>
            <span className="text-muted-foreground/60">/{syms.length} stable · max bet</span>
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left px-5 py-2 font-medium w-16">Coin</th>
              <th className="text-left px-3 py-2 font-medium">Strike</th>
              <th className="text-left px-3 py-2 font-medium">Condition</th>
              <th className="text-left px-3 py-2 font-medium">
                <span className="inline-flex items-center gap-1" title="Efficiency ratio — how directional recent price action is (0=pure chop, 1=clean trend)">
                  <BarChart2 className="w-3 h-3" />ER
                </span>
              </th>
              <th className="text-left px-3 py-2 font-medium" title="Close-to-close direction reversals in last 15 min">Osc</th>
              <th className="text-left px-3 py-2 font-medium" title="1-min log-return standard deviation (annualised × 100)">Vol%</th>
              <th className="text-left px-3 py-2 font-medium">
                <span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3" />ML</span>
              </th>
              <th className="text-left px-3 py-2 font-medium">Bet Size</th>
              <th className="text-left px-3 py-2 font-medium" title="Trajectory gate: ATR-adaptive thresholds per coin — actual danger band = max(fixed floor, ATR% × multiplier)">
                <span className="inline-flex items-center gap-1"><TrendingUp className="w-3 h-3" />Trajectory</span>
              </th>
              <th className="text-left px-3 py-2 font-medium" title="Strike proximity gate: |livePrice−strike|/strike×100 — must exceed configured threshold before a FOK fires; ATR-scaled when enabled">
                Gap%
              </th>
            </tr>
          </thead>
          <tbody>
            {syms.map((sym) => {
              const s = liveSignals[sym];
              const stab = coinStability?.[sym] ?? null;
              const traj = coinTrajectory?.[sym] ?? null;
              const strike = pinnedStrikes[sym] ?? null;
              const isStale = stab !== null && windowKey != null && stab.windowKey !== windowKey;
              const isStable = stab?.stable === true;
              const hasData = stab !== null && !isStale;
              const isAborted = (extremeCautionAborted ?? []).includes(sym);
              const dirBlockInfo = convictionDirectionBlocked?.[sym] ?? null;

              return (
                <tr key={sym} className={`border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors${isStale ? " opacity-40" : ""}`}>
                  <td className="px-5 py-2.5 font-bold text-foreground">{sym}</td>
                  <td className="px-3 py-2.5 font-mono text-foreground/60 text-[11px]">{fmtStrike(strike)}</td>

                  <td className="px-3 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      {isStale ? (
                        <span className="text-muted-foreground/40 text-xs font-mono">stale</span>
                      ) : !hasData ? (
                        <span className="text-muted-foreground/40 text-xs font-mono">—</span>
                      ) : isStable ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                          <Zap className="w-2.5 h-2.5" />Stable
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <Activity className="w-2.5 h-2.5" />Volatile
                        </span>
                      )}
                      {isAborted && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25"
                          title="Extreme Caution: YES re-entry blocked this window — YES bid fell below zone floor after fill"
                        >
                          ⚠ YES blocked
                        </span>
                      )}
                      {dirBlockInfo != null && (() => {
                        const { direction: blockedDir, gate, slopePct, effectiveThreshold, lookback, fromPrice, toPrice } = dirBlockInfo;
                        const isTickGate = gate === "tick";
                        const isCandleGate = gate === "candle-decline" || gate === "candle-rise";

                        let tooltipText: string;
                        if (isTickGate) {
                          const from = fromPrice != null ? `$${fromPrice.toFixed(2)}` : "?";
                          const to   = toPrice   != null ? `$${toPrice.toFixed(2)}`   : "?";
                          tooltipText = blockedDir === "yes"
                            ? `Tick gate: price moving DOWN toward strike over last ${lookback ?? "?"} seconds (${from} → ${to}) — YES entry held back until price resumes rising`
                            : `Tick gate: price moving UP toward strike over last ${lookback ?? "?"} seconds (${from} → ${to}) — NO entry held back until price resumes falling`;
                        } else {
                          const slope  = slopePct       != null ? `slope ${slopePct >= 0 ? "+" : ""}${slopePct.toFixed(3)}%` : "";
                          const thresh = effectiveThreshold != null ? ` (threshold ${effectiveThreshold.toFixed(3)}%)` : "";
                          tooltipText = blockedDir === "yes"
                            ? `Candle-trend gate: ${lookback ?? "?"}-candle declining slope ${slope}${thresh} — YES entry held back until trend stabilises`
                            : `Candle-trend gate: ${lookback ?? "?"}-candle rising slope ${slope}${thresh} — NO entry held back until trend stabilises`;
                        }

                        const label = isTickGate
                          ? (blockedDir === "yes" ? "Tick ↓" : "Tick ↑")
                          : (blockedDir === "yes" ? "Trend ↓" : "Trend ↑");

                        return (
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                              isCandleGate
                                ? "bg-red-500/15 text-red-300 border-red-500/25"
                                : "bg-orange-500/15 text-orange-300 border-orange-500/25"
                            }`}
                            title={tooltipText}
                          >
                            {blockedDir === "yes" ? <ArrowDown className="w-2.5 h-2.5" /> : <ArrowUp className="w-2.5 h-2.5" />}
                            {label}
                          </span>
                        );
                      })()}
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    {stab != null && !isStale ? <MetricPill value={stab.er.toFixed(2)} ok={stab.er >= minER} /> : <span className="text-muted-foreground/40 font-mono">—</span>}
                  </td>

                  <td className="px-3 py-2.5">
                    {stab != null && !isStale ? <MetricPill value={String(stab.osc)} ok={stab.osc <= maxOsc} /> : <span className="text-muted-foreground/40 font-mono">—</span>}
                  </td>

                  <td className="px-3 py-2.5">
                    {stab != null && !isStale ? <MetricPill value={stab.volPct.toFixed(2) + "%"} ok={stab.volPct <= maxVolPct} /> : <span className="text-muted-foreground/40 font-mono">—</span>}
                  </td>

                  <td className="px-3 py-2.5">
                    {!isStale && (stab?.mlConf ?? s.mlConfidence) != null ? (
                      <MetricPill value={(stab?.mlConf ?? s.mlConfidence)!.toFixed(0) + "%"} ok={(stab?.mlConf ?? s.mlConfidence)! >= minMLConf} />
                    ) : (
                      <span className="text-muted-foreground/40 font-mono">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      {!hasData ? (
                        <span className="text-muted-foreground/40 text-xs">—</span>
                      ) : isStable && gateActive ? (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300"
                          title={`Max-bet gate active — clears in ${gateMinsLeft}m (maxBetMinWindowEntryMinutes=${maxBetMinWindowEntryMinutes})`}
                        >
                          <Clock className="w-2.5 h-2.5 shrink-0" />
                          Max bet in {gateMinsLeft}m
                        </span>
                      ) : isStable ? (
                        <span className="text-[10px] font-semibold text-emerald-400">Max</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-amber-400">Regular</span>
                      )}
                      {activeScheduleBracket != null && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-mono text-violet-300/80"
                          title={`Time-bet schedule active: bracket ≥${activeScheduleBracket.minutesElapsed}m overrides bet size to $${activeScheduleBracket.betAmount.toFixed(2)}`}
                        >
                          <Clock className="w-2.5 h-2.5 shrink-0" />
                          ≥{activeScheduleBracket.minutesElapsed}m → ${activeScheduleBracket.betAmount.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    {traj == null || traj.reason === "insufficient_data" ? (
                      <span className="text-muted-foreground/40 font-mono">—</span>
                    ) : traj.reason === "gate_inactive" ? (
                      <div className="flex flex-col gap-0.5">
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-slate-500/10 text-slate-400 border-slate-500/20"
                          title={`Freefall gate activates in final ${(+traj.minutesRemaining).toFixed(1)} min`}
                        >
                          ⏳ Watching
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 font-mono tabular-nums">
                          {(+traj.minutesRemaining).toFixed(1)} min left
                        </span>
                      </div>
                    ) : traj.reason === "adverse_momentum_to_cross" ? (
                      <div className="flex flex-col gap-0.5">
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-amber-500/15 text-amber-400 border-amber-500/25"
                          title="Adverse momentum gate: price trending toward strike fast enough to cross before window closes"
                        >
                          ⚡ Momentum ↓
                        </span>
                        <span
                          className="text-[10px] text-muted-foreground/70 font-mono tabular-nums"
                          title={[
                            `vel: ${traj.velocity >= 0 ? "+" : ""}${(+traj.velocity).toFixed(2)}/min (toward strike)`,
                            `proj close: ${(+traj.projectedMarginPct).toFixed(3)}% vs strike`,
                            `${(+traj.minutesRemaining).toFixed(1)} min left`,
                          ].join(" · ")}
                        >
                          {traj.velocity >= 0 ? "+" : ""}{(+traj.velocity).toFixed(1)}/m · {(+traj.minutesRemaining).toFixed(1)}m left
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${
                            traj.blocked
                              ? "bg-red-500/15 text-red-400 border-red-500/25"
                              : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          }`}
                          title={traj.blocked ? "Freefall projected to cross strike — max bet blocked" : "No freefall detected — max bet allowed"}
                        >
                          {traj.blocked ? "⚠ Freefall" : "✓ Safe"}
                        </span>
                        <span
                          className="text-[10px] text-muted-foreground/70 font-mono tabular-nums"
                          title={[
                            `vel: ${traj.velocity >= 0 ? "+" : ""}${(+traj.velocity).toFixed(2)}/min (${traj.adverseVelocity ? "toward strike ⚠" : "away ✓"})`,
                            `proj close: ${(+traj.projectedMarginPct).toFixed(3)}% vs strike`,
                            `ATR: ${traj.atrPct != null ? (+traj.atrPct).toFixed(3) : "?"}%`,
                            `${(+traj.minutesRemaining).toFixed(1)} min left`,
                          ].join(" · ")}
                        >
                          {traj.velocity >= 0 ? "+" : ""}{(+traj.velocity).toFixed(1)}/m · proj {(+traj.projectedMarginPct).toFixed(2)}%
                          {traj.atrPct != null && traj.atrPct > 0 && <span className="text-violet-400/70"> · {(+traj.atrPct).toFixed(2)}%ATR</span>}
                          {traj.adverseVelocity && <span className="text-orange-400/70"> ↓</span>}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {(() => {
                      const gapPct = stab?.strikeGapPct ?? null;
                      if (gapPct == null) return <span className="text-muted-foreground/40 font-mono">—</span>;
                      const coinThreshold = getProximityThreshold(sym);
                      const hasOverride = proximityOverrides[sym] != null;
                      // Cap matches backend conviction re-check: atrMultiplierCap=1.2
                      const atrMultiplier = (proximityAtrScale && stab?.volPct != null && stab.volPct > 0)
                        ? Math.min(1.2, Math.max(1, stab.volPct / 0.20))
                        : 1;
                      const effectiveThreshold = coinThreshold * atrMultiplier;
                      const ok = gapPct >= effectiveThreshold;
                      const tooltipParts = [
                        `gap: ${gapPct.toFixed(3)}%`,
                        `threshold: ${effectiveThreshold.toFixed(3)}%`,
                        hasOverride ? `per-coin override ${coinThreshold.toFixed(3)}%` : `global ${proximityMinPct.toFixed(2)}%`,
                        proximityAtrScale && atrMultiplier > 1 ? `ATR ×${atrMultiplier.toFixed(2)} (cap 1.2×)` : "no ATR scale",
                      ];
                      return (
                        <span
                          className={`font-mono text-[11px] tabular-nums ${ok ? "text-emerald-400" : "text-red-400"}`}
                          title={tooltipParts.join(" · ")}
                        >
                          {gapPct.toFixed(2)}%
                          {!ok && <span className="ml-0.5 text-[9px]">⚠</span>}
                        </span>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-5 py-2 border-t border-border/40">
        <span className="text-[10px] text-muted-foreground/50">
          Stable = ER ≥ {minER.toFixed(2)} · Osc ≤ {maxOsc} · Vol ≤ {maxVolPct}% · ML ≥ {minMLConf}% · no spike candle → max bet size
        </span>
      </div>
    </div>
  );
}
