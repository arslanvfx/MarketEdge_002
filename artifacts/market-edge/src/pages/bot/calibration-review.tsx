import { useState } from "react";
import { AlertTriangle, ChevronRight, Target } from "lucide-react";
import { fmt$, fmtDateTime } from "./utils";
import type {
  ScalpCalibrationReport,
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
      case "recommended": return "Recommended";
      case "no_change": return "No Change";
      case "applied": return "Applied";
      case "insufficient_data": return "Need Data";
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
            {mutationBusy === "calibration-refresh" ? "Reviewing..." : "Refresh all 12 markets"}
          </button>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground mb-3 leading-relaxed max-w-3xl">
        Evidence is isolated to the selected <strong className="text-foreground uppercase tracking-widest">{report?.mode || "paper"}</strong> ledger. Approved per-market settings are shared execution configuration, so every change requires an explicit operator review.
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
                        <span><strong className="text-foreground capitalize">{rec.confidence} confidence</strong>: Found better timing</span>
                      ) : isNoChange ? (
                         <span>No earlier timing passed both training and holdout checks</span>
                       ) : rec?.status === "insufficient_data" ? (
                         <span>
                           {rec.evidence.attemptedUniqueWindows} windows and {rec.evidence.settledRealFills} settled fills recorded
                         </span>
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
                                <p key={i}>• {line}</p>
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
