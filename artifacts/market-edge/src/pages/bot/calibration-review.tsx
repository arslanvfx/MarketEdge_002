import { useState } from "react";
import { AlertTriangle, ChevronRight, Target } from "lucide-react";
import { fmt$, fmtDateTime } from "./utils";
import type {
  ScalpCalibrationRecommendation,
  ScalpCalibrationReport,
  ScalpCalibrationTimingSummary,
} from "./types";

interface CalibrationReviewProps {
  report: ScalpCalibrationReport | null;
  isLoading: boolean;
  isError: boolean;
  canManage: boolean;
  mutationBusy: string | null;
  onRefresh: () => void;
  onApply: (id: string, symbol: string) => void;
  onRevert: (id: string, symbol: string) => void;
  symbols: string[];
}

export function ScalperCalibrationReview({
  report,
  isLoading,
  isError,
  canManage,
  mutationBusy,
  onRefresh,
  onApply,
  onRevert,
  symbols,
}: CalibrationReviewProps) {
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const getSymbolData = (sym: string) => {
    if (!report) return null;
    const active = report.activeApplications.find(a => a.symbol === sym);
    const rec = report.recommendations.find(r => r.symbol === sym);
    return { active, rec };
  };

  const getStatusColor = (status: string | undefined) => {
    switch (status) {
      case "recommended": return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
      case "no_change": return "text-blue-400 bg-blue-500/10 border-blue-500/30";
      case "applied": return "text-purple-400 bg-purple-500/10 border-purple-500/30";
      case "insufficient_data": return "text-muted-foreground bg-muted/10 border-border";
      case "reverted": return "text-slate-300 bg-slate-500/10 border-slate-500/30";
      default: return "text-muted-foreground bg-muted/10 border-border";
    }
  };
  
  const getStatusLabel = (status: string | undefined) => {
    switch (status) {
      case "recommended": return "Move Earlier";
      case "no_change": return "Keep Timing";
      case "applied": return "Applied";
      case "insufficient_data": return "Collecting";
      case "superseded": return "Superseded";
      case "reverted": return "Reverted";
      default: return "Not Analyzed";
    }
  };

  const formatBand = (min: number, max: number) =>
    `${(min * 100).toFixed(0)}–${(max * 100).toFixed(0)}¢`;

  const formatTiming = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")} left`;
  };

  const getTimingOptions = (
    rec: ScalpCalibrationRecommendation,
  ): ScalpCalibrationTimingSummary[] => {
    if (rec.timingOptions?.length) {
      return [...rec.timingOptions].sort(
        (left, right) => right.variantSeconds - left.variantSeconds,
      );
    }
    const legacy = [
      rec.chronologicalHoldout.current,
      rec.chronologicalHoldout.proposed,
    ].filter((row): row is ScalpCalibrationTimingSummary => row != null);
    return [...new Map(
      legacy.map((row) => [row.variantSeconds, row]),
    ).values()].sort((left, right) => right.variantSeconds - left.variantSeconds);
  };

  const timingSettlements = (timing: ScalpCalibrationTimingSummary) =>
    timing.totalSettlements
      ?? timing.trainingSettlements + timing.holdoutSettlements;
  const timingWins = (timing: ScalpCalibrationTimingSummary) =>
    timing.totalWins ?? null;
  const timingLosses = (timing: ScalpCalibrationTimingSummary) =>
    timing.totalLosses ?? null;
  const timingPnl = (timing: ScalpCalibrationTimingSummary) =>
    timing.totalPnl ?? timing.trainingPnl + timing.holdoutPnl;
  const timingWinRate = (timing: ScalpCalibrationTimingSummary) =>
    timing.totalWinRate
      ?? (timingWins(timing) != null
        && timingSettlements(timing) > 0
        ? (timingWins(timing)! / timingSettlements(timing)) * 100
        : null);
  const timingReady = (timing: ScalpCalibrationTimingSummary) =>
    timing.ready
      ?? (
        timing.trainingSettlements >= 8
        && timing.holdoutSettlements >= 4
      );
  const timingProfitable = (timing: ScalpCalibrationTimingSummary) =>
    timing.profitable
      ?? (
        timingReady(timing)
        && timing.trainingPnl >= 0
        && timing.holdoutPnl >= 0
      );

  const collectingSummary = (rec: ScalpCalibrationRecommendation) => {
    if (rec.evidence.attemptedUniqueWindows < 12) {
      return `${rec.evidence.attemptedUniqueWindows}/12 market windows collected`;
    }
    if (rec.evidence.settledRealFills < 8) {
      return `${rec.evidence.settledRealFills}/8 real fills settled`;
    }
    const earlier = getTimingOptions(rec)
      .filter((row) => row.variantSeconds > rec.currentSettings.windowSeconds)
      .sort((left, right) => {
        const leftProgress = Math.min(left.trainingSettlements / 8, 1)
          + Math.min(left.holdoutSettlements / 4, 1);
        const rightProgress = Math.min(right.trainingSettlements / 8, 1)
          + Math.min(right.holdoutSettlements / 4, 1);
        return rightProgress - leftProgress;
      })[0];
    if (!earlier) return "No earlier timing observations recorded yet";
    return `${formatTiming(earlier.variantSeconds)}: `
      + `${earlier.trainingSettlements}/8 training · `
      + `${earlier.holdoutSettlements}/4 recent outcomes`;
  };

  return (
    <div className="mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-3">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-emerald-500/70" />
          <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">All-Market Calibration Review</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground font-mono">
            {report?.generatedAt ? `Last review: ${fmtDateTime(report.generatedAt)}` : "Not reviewed yet"}
            {report?.mode ? ` (${report.mode} mode)` : ""}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={mutationBusy !== null || !canManage}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-md text-[10px] font-bold uppercase tracking-widest transition-colors disabled:opacity-50"
          >
            {mutationBusy === "calibration-refresh" ? "Analyzing..." : "Analyze all 12 markets"}
          </button>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground mb-3 leading-relaxed max-w-3xl">
        Evidence is isolated to the selected <strong className="text-foreground uppercase tracking-widest">{report?.mode || "paper"}</strong> ledger. Analysis never clears the raw history—it creates a new saved review from the latest 60 days of retained evidence. Entry timing changes remain operator-controlled.
      </div>

      <div className="bg-background/50 border border-border rounded-lg overflow-hidden">
        {isError && !report ? (
          <div className="p-8 text-center text-xs text-red-300">
            Calibration evidence could not be loaded. No settings were changed.
          </div>
        ) : isLoading && !report ? (
          <div className="p-8 text-center text-xs text-muted-foreground">Loading calibration data...</div>
        ) : (
          <div className="flex flex-col">
            {symbols.map(sym => {
              const data = getSymbolData(sym);
              const rec = data?.rec;
              const active = data?.active;
              
               // The latest review and the last still-revertible application are
               // intentionally separate audit records.
              const isRecommended = rec?.status === "recommended";
              const isNoChange = rec?.status === "no_change";
               const displayStatus = rec?.status ?? active?.status;
               const statusColor = getStatusColor(displayStatus);
               const statusLabel = getStatusLabel(displayStatus);
              const isExpanded = expandedSymbol === sym;

              return (
                <div key={sym} className="border-b border-border/40 last:border-0">
                  <button
                    onClick={() => setExpandedSymbol(isExpanded ? null : sym)}
                    className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-muted/10 transition-colors"
                  >
                    <div className="w-16 font-bold text-xs">{sym}</div>
                    <div className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest border ${statusColor}`}>
                      {statusLabel}
                    </div>
                    <div className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
                      {isRecommended && rec.confidence ? (
                        <span>
                          Start at <strong className="text-emerald-300">
                            {formatTiming(rec.proposedSettings.windowSeconds)}
                          </strong>
                          {rec.chronologicalHoldout.proposed
                            ? timingWins(rec.chronologicalHoldout.proposed) != null
                              ? ` · ${timingWins(rec.chronologicalHoldout.proposed)}W–${timingLosses(rec.chronologicalHoldout.proposed)}L · ${fmt$(timingPnl(rec.chronologicalHoldout.proposed))}`
                              : ` · ${timingSettlements(rec.chronologicalHoldout.proposed)} settled · ${fmt$(timingPnl(rec.chronologicalHoldout.proposed))}`
                            : ""}
                        </span>
                      ) : isNoChange ? (
                         <span>No earlier timing passed both training and recent holdout checks</span>
                       ) : rec?.status === "insufficient_data" ? (
                         <span>{collectingSummary(rec)}</span>
                       ) : active ? (
                        <span>Optimized settings running</span>
                       ) : rec ? (
                         <span>Latest review is no longer active</span>
                      ) : (
                         <span>Run the first evidence review for this market</span>
                      )}
                    </div>
                    <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </button>
                  
                  {isExpanded && (
                    <div className="px-4 py-4 bg-muted/5 border-t border-border/20 text-xs">
                      {rec ? (
                        <div className="flex flex-col gap-4">
                          {/* Main Comparison */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-background/80 border border-border p-3 rounded-lg flex flex-col gap-2">
                              <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest mb-1">Current Settings</div>
                              <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                                <div>
                                  <div className="text-muted-foreground/60 text-[9px]">Start Watching</div>
                                  <div className="text-foreground">{formatTiming(rec.currentSettings.windowSeconds)}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground/60 text-[9px]">Direct Cost Band</div>
                                  <div className="text-foreground">{formatBand(rec.currentSettings.bandMin, rec.currentSettings.bandMax)}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground/60 text-[9px]">Per-Order Budget</div>
                                  <div className="text-foreground">{fmt$(rec.currentSettings.budgetDollars)}</div>
                                </div>
                              </div>
                            </div>
                            
                            {(isRecommended || isNoChange) && (
                              <div className={`bg-background/80 border p-3 rounded-lg flex flex-col gap-2 ${isRecommended ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border'}`}>
                                <div className="text-[10px] uppercase font-bold text-emerald-500/70 tracking-widest mb-1">
                                   {isNoChange ? "Current Settings Retained" : "Proposed Settings"}
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                                  <div>
                                     <div className="text-muted-foreground/60 text-[9px]">Start Watching</div>
                                     <div className={rec.currentSettings.windowSeconds !== rec.proposedSettings.windowSeconds ? "text-emerald-400 font-bold" : "text-foreground"}>
                                       {formatTiming(rec.proposedSettings.windowSeconds)}
                                    </div>
                                  </div>
                                  <div>
                                     <div className="text-muted-foreground/60 text-[9px]">Direct Cost Band</div>
                                     <div className={(rec.currentSettings.bandMin !== rec.proposedSettings.bandMin || rec.currentSettings.bandMax !== rec.proposedSettings.bandMax) ? "text-emerald-400 font-bold" : "text-foreground"}>
                                       {formatBand(rec.proposedSettings.bandMin, rec.proposedSettings.bandMax)}
                                    </div>
                                  </div>
                                  <div>
                                     <div className="text-muted-foreground/60 text-[9px]">Per-Order Budget</div>
                                     <div className={(rec.currentSettings.budgetDollars !== rec.proposedSettings.budgetDollars) ? "text-emerald-400 font-bold" : "text-foreground"}>
                                       {fmt$(rec.proposedSettings.budgetDollars)}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>

                           <div className="bg-background/50 border border-border rounded-lg overflow-hidden">
                             <div className="px-3 py-2 border-b border-border/60">
                               <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-widest">
                                 Entry timing results
                               </div>
                               <div className="text-[10px] text-muted-foreground mt-1">
                                 Earlier entries have more time left. Ready requires 8 training and 4 recent holdout settlements.
                               </div>
                             </div>
                             <div className="overflow-x-auto">
                               <div className="min-w-[650px]">
                                 <div className="grid grid-cols-[120px_80px_80px_90px_90px_1fr] gap-2 px-3 py-2 text-[9px] uppercase tracking-widest text-muted-foreground border-b border-border/40">
                                   <div>Entry point</div>
                                   <div className="text-right">Settled</div>
                                   <div className="text-right">W–L</div>
                                   <div className="text-right">Win rate</div>
                                   <div className="text-right">Hyp. P&amp;L</div>
                                   <div className="text-right">Validation</div>
                                 </div>
                                 {getTimingOptions(rec).map((timing) => {
                                   const isCurrent = timing.variantSeconds === rec.currentSettings.windowSeconds;
                                   const isProposedTiming = isRecommended
                                     && timing.variantSeconds === rec.proposedSettings.windowSeconds;
                                   const ready = timingReady(timing);
                                   const profitable = timingProfitable(timing);
                                   const winRate = timingWinRate(timing);
                                   const pnl = timingPnl(timing);
                                   const wins = timingWins(timing);
                                   const losses = timingLosses(timing);
                                   return (
                                     <div
                                       key={timing.variantSeconds}
                                       className={`grid grid-cols-[120px_80px_80px_90px_90px_1fr] gap-2 px-3 py-2.5 text-[10px] font-mono border-b border-border/30 last:border-0 ${
                                         isProposedTiming ? "bg-emerald-500/10" : isCurrent ? "bg-blue-500/5" : ""
                                       }`}
                                     >
                                       <div className="font-bold text-foreground">
                                         {formatTiming(timing.variantSeconds)}
                                         <div className="font-sans font-normal text-[8px] uppercase tracking-wider mt-0.5">
                                           {isProposedTiming
                                             ? <span className="text-emerald-400">Recommended</span>
                                             : isCurrent
                                               ? <span className="text-blue-400">Current</span>
                                               : <span className="text-muted-foreground">{timing.observedWindows ?? 0} observed</span>}
                                         </div>
                                       </div>
                                       <div className="text-right text-foreground">{timingSettlements(timing)}</div>
                                       <div className="text-right">
                                         {wins == null || losses == null ? (
                                           <span className="text-muted-foreground">—</span>
                                         ) : (
                                           <>
                                             <span className="text-emerald-400">{wins}</span>
                                             <span className="text-muted-foreground">–</span>
                                             <span className="text-red-400">{losses}</span>
                                           </>
                                         )}
                                       </div>
                                       <div className="text-right text-foreground">
                                         {winRate == null ? "—" : `${winRate.toFixed(1)}%`}
                                       </div>
                                       <div className={`text-right font-bold ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                         {fmt$(pnl)}
                                       </div>
                                       <div className="text-right font-sans">
                                         {ready ? (
                                           <span className={profitable ? "text-emerald-400" : "text-red-300"}>
                                             {profitable ? "Passed holdout" : "Failed profitability"}
                                           </span>
                                         ) : (
                                           <span className="text-amber-300">
                                             {timing.trainingSettlements}/8 train · {timing.holdoutSettlements}/4 recent
                                           </span>
                                         )}
                                       </div>
                                     </div>
                                   );
                                 })}
                               </div>
                             </div>
                           </div>

                          {/* Evidence & Rationale */}
                          <div className="bg-background/40 border border-border/50 p-3 rounded-lg text-xs">
                              <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-widest mb-2">Sample Evidence (Recent)</div>
                              <div className="flex flex-wrap gap-4 text-muted-foreground/80 font-mono">
                                <div>
                                  <span className="text-foreground">{rec.evidence.attemptedUniqueWindows}</span> windows
                                </div>
                                <div>
                                  <span className="text-foreground">{rec.evidence.settledRealFills}</span> real fills
                                </div>
                                <div>
                                  <span className="text-foreground">{rec.evidence.shadowSettlements}</span> shadow samples
                                </div>
                                <div>
                                  <span className="text-foreground">{rec.evidence.funnelEvents}</span> funnel checks
                                </div>
                              </div>
                              {rec.dominantBlockers.length > 0 && (
                                <div className="mt-2 border-t border-border/40 pt-2 text-[9px] text-muted-foreground">
                                  Most common blocks: {rec.dominantBlockers
                                    .slice(0, 3)
                                    .map((entry) => `${entry.blocker.replaceAll("_", " ")} (${entry.count})`)
                                    .join(" · ")}
                                </div>
                              )}
                            </div>

                          {rec.rationale && rec.rationale.length > 0 && (
                            <div className="text-muted-foreground/90 space-y-1">
                              {rec.rationale.map((line, i) => (
                                <p key={i}>• {line.replaceAll("_", " ")}</p>
                              ))}
                            </div>
                          )}
                          
                          {/* Holdout Outcomes */}
                          {rec.chronologicalHoldout.current && (
                            <div className="bg-background/50 border border-border p-3 rounded-lg text-[10px] sm:text-xs">
                              <div className="font-bold text-muted-foreground uppercase tracking-widest mb-3 text-[9px]">Chronological Holdout (Recent Events)</div>
                              <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono mb-2">
                                <div className="text-left text-muted-foreground">Scenario</div>
                                <div className="text-muted-foreground">Settlements</div>
                                <div className="text-muted-foreground text-right">Hypothetical P&L</div>
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-center py-1">
                                <div className="text-left">Current</div>
                                <div>{rec.chronologicalHoldout.current.holdoutSettlements}</div>
                                <div className={`text-right font-bold ${rec.chronologicalHoldout.current.holdoutPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                  {fmt$(rec.chronologicalHoldout.current.holdoutPnl)}
                                </div>
                              </div>
                              {rec.chronologicalHoldout.proposed && (
                                <div className="grid grid-cols-3 gap-2 text-center py-1 bg-muted/20 -mx-3 px-3">
                                  <div className="text-left text-emerald-400 font-medium">Proposed</div>
                                  <div>{rec.chronologicalHoldout.proposed.holdoutSettlements}</div>
                                  <div className={`text-right font-bold ${rec.chronologicalHoldout.proposed.holdoutPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                    {fmt$(rec.chronologicalHoldout.proposed.holdoutPnl)}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Disclaimer */}
                          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-lg text-amber-200/90 text-[10px] leading-relaxed">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-70" />
                            <p>
                              {rec.shadowDisclaimer} Cached/public quotes are not authenticated final re-quotes and are not confirmed IOC fills.
                            </p>
                          </div>
                          
                          {/* Actions */}
                          <div className="flex justify-end gap-3 pt-2">
                            {active && (
                              <button
                                onClick={() => onRevert(active.id, sym)}
                                disabled={mutationBusy !== null || !canManage}
                                className="px-4 py-2 bg-muted/50 hover:bg-muted text-foreground border border-border rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                              >
                                Revert Active
                              </button>
                            )}
                            {isRecommended && (
                              <button
                                onClick={() => onApply(rec.id, sym)}
                                disabled={mutationBusy !== null || !canManage}
                                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-bold transition-colors shadow-sm disabled:opacity-50"
                              >
                                {mutationBusy === `calibration-apply-${rec.id}` ? "Applying..." : "Apply Recommendation"}
                              </button>
                            )}
                          </div>
                        </div>
                      ) : active ? (
                        <div className="flex flex-col gap-4">
                           <div className="text-muted-foreground/80">
                             An optimized configuration was previously applied, but there isn't enough new evidence to generate a new recommendation yet.
                           </div>
                           <div className="bg-background/80 border border-border p-3 rounded-lg">
                              <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest mb-1">Applied Settings</div>
                              <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                                <div>
                                  <div className="text-muted-foreground/60 text-[9px]">Timing Window</div>
                                  <div className="text-foreground">{formatTiming(active.proposedSettings.windowSeconds)}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground/60 text-[9px]">Pricing Band</div>
                                  <div className="text-foreground">{formatBand(active.proposedSettings.bandMin, active.proposedSettings.bandMax)}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground/60 text-[9px]">Order Budget</div>
                                  <div className="text-foreground">{fmt$(active.proposedSettings.budgetDollars)}</div>
                                </div>
                              </div>
                           </div>
                           <div className="flex justify-end pt-2">
                             <button
                                onClick={() => onRevert(active.id, sym)}
                                disabled={mutationBusy !== null || !canManage}
                                className="px-4 py-2 bg-muted/50 hover:bg-muted text-foreground border border-border rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                              >
                                {mutationBusy === `calibration-revert-${active.id}` ? "Reverting..." : "Revert Application"}
                              </button>
                           </div>
                        </div>
                      ) : (
                        <div className="text-muted-foreground italic p-4 text-center border border-dashed border-border/50 rounded-lg">
                          Run the all-market review to evaluate this market. No settings change automatically.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
