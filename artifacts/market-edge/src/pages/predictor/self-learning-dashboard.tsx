import { useState } from "react";
import { BarChart3, Bot, Power, Minus, ChevronDown, ChevronUp, CheckCircle2, XCircle, TrendingUp, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import type { CoinAnalytics, AiSettings, AutoPilotDecision, PromptRegime, SourceMetrics } from "./types";
import { COIN_STYLE } from "./utils";

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

export function SelfLearningDashboard({
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
              {activeCount}/{autoPilot.maxActive} coins prefer Claude
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
                ? "Auto-pilot is ON — evaluates Claude vs stat accuracy per coin. Where Claude has the edge the Auto-Pilot consensus signal uses Claude's direction. Click to turn off."
                : "Turn on auto-pilot — the system tracks which model is winning per coin and routes the Auto-Pilot consensus signal through the better-performing model automatically."
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
          <span className="text-violet-300 font-semibold">BTC · ETH · XRP · HYPE · BNB · DOGE</span> are training coins — all 4 models (Stat, Claude, Ensemble, ML) are recorded every window so accuracy can be compared fairly.
          {" "}New coins enter an <span className="text-sky-300/80 font-medium">Exploring</span> phase to gather enough data before the comparison is made.
          {" "}The <span className="text-foreground/70 font-medium">Auto-Pilot</span> live signal is then routed through whichever model is winning per coin.
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
              // Auto-pilot decision drives the badge for all coins (including training
              // coins). "Training" is no longer special-cased — the actual decision
              // (exploring, Claude on, or paused/stat-only) is shown for every coin.
              const statusBadge = !autoPilot.enabled ? (
                <span className="text-[10px] text-muted-foreground/50">Auto-pilot off</span>
              ) : decision?.active && decision.exploring ? (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 bg-sky-500/15 text-sky-300 ring-sky-500/30" title={decision.reason}>
                  <Bot className="w-3 h-3" /> Exploring
                </span>
              ) : decision?.active ? (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" title={decision.reason}>
                  <Bot className="w-3 h-3" /> Claude on
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted/30 ring-1 ring-border" title={decision?.reason ?? "Stat only"}>
                  <Minus className="w-3 h-3" />{trainingCoins.has(a.symbol) ? "Paused" : "Stat only"}
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

                    {autoPilot.enabled && decision?.reason && (
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
                      {autoPilot.enabled && decision?.reason && (
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
