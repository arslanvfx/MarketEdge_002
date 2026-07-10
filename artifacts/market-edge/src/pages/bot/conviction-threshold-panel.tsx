import { Target, TrendingUp, AlertTriangle, Lightbulb, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { ConvictionThresholdData } from "./types";

interface ConvictionThresholdPanelProps {
  data: ConvictionThresholdData | undefined;
  currentLockPrice: number | undefined;
  activeMode: "paper" | "live";
}

export function ConvictionThresholdPanel({ data, currentLockPrice, activeMode }: ConvictionThresholdPanelProps) {
  const [open, setOpen] = useState(true);

  const bands = data?.bands ?? [];
  const totalBets = data?.totalBets ?? 0;
  const suggested = data?.suggestedLockPrice ?? null;
  const lockPct = Math.round((currentLockPrice ?? 0.90) * 100);

  const fmt$ = (v: number) =>
    `${v >= 0 ? "+" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const wrColor = (wr: number | null) =>
    wr == null ? "" : wr >= 0.6 ? "text-emerald-400" : wr >= 0.45 ? "text-amber-400" : "text-red-400";

  const isSuggestedDifferent =
    suggested != null && currentLockPrice != null && Math.abs(suggested - currentLockPrice) >= 0.005;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/20 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <Target className="w-4 h-4 text-orange-400 flex-shrink-0" />
        <h2 className="font-semibold text-sm">Conviction Threshold Analysis</h2>
        <span className="text-xs text-muted-foreground">win rate by Kalshi entry price</span>
        <span className={`ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${activeMode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"}`}>
          {activeMode}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{totalBets} settled bets</span>
          {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div className="p-5 space-y-4">
          {totalBets === 0 ? (
            <div className="text-sm text-muted-foreground italic text-center py-4">
              No settled conviction-mode bets yet. Data will appear here once bets are placed and evaluated.
            </div>
          ) : (
            <>
              {/* Current setting badge */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-1.5">
                  <Target className="w-3 h-3 text-orange-400" />
                  <span>Current lock: <span className="font-bold text-foreground">{lockPct}¢</span></span>
                </div>

                {isSuggestedDifferent && (
                  <div className="flex items-center gap-1.5 text-xs bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5 text-emerald-300">
                    <Lightbulb className="w-3 h-3 flex-shrink-0" />
                    <span>
                      Suggested: <span className="font-bold">{Math.round(suggested! * 100)}¢</span>
                      <span className="text-emerald-400/70 ml-1">— best win rate with ≥5 bets</span>
                    </span>
                  </div>
                )}

                {!isSuggestedDifferent && suggested != null && (
                  <div className="flex items-center gap-1.5 text-xs bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-1.5 text-sky-300">
                    <TrendingUp className="w-3 h-3 flex-shrink-0" />
                    <span>Current lock price is the best performing band</span>
                  </div>
                )}

                {suggested == null && totalBets > 0 && (
                  <div className="flex items-center gap-1.5 text-xs bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1.5 text-amber-300">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    <span>Need ≥5 bets per band for a reliable suggestion</span>
                  </div>
                )}
              </div>

              {/* Bands table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                      {["Price Band", "Bets", "Wins", "Losses", "Win Rate", "P&L"].map(h => (
                        <th key={h} className="px-4 py-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bands.map(b => {
                      const wr = b.winRate;
                      const wrPct = wr != null ? Math.round(wr * 100) : null;
                      const isCurrentBand =
                        currentLockPrice != null &&
                        currentLockPrice >= b.lowerBound &&
                        currentLockPrice < b.upperBound;
                      const isBestBand = suggested != null && b.lowerBound === suggested && b.bets >= 5;

                      return (
                        <tr
                          key={b.band}
                          className={`border-b border-border/50 hover:bg-muted/20 ${
                            isCurrentBand ? "bg-orange-500/5 ring-inset ring-1 ring-orange-500/20" : ""
                          }`}
                        >
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs font-semibold">{b.band}</span>
                              {isCurrentBand && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">
                                  ACTIVE
                                </span>
                              )}
                              {isBestBand && !isCurrentBand && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                  BEST
                                </span>
                              )}
                              {isBestBand && isCurrentBand && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                  BEST ✓
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{b.bets}</td>
                          <td className="px-4 py-2.5 text-emerald-400">{b.wins}</td>
                          <td className="px-4 py-2.5 text-red-400">{b.losses}</td>
                          <td className={`px-4 py-2.5 font-bold ${wrColor(wr)}`}>
                            {b.bets === 0 ? (
                              <span className="text-muted-foreground/50 font-normal">—</span>
                            ) : wrPct != null ? (
                              <div className="flex items-center gap-2">
                                <span>{wrPct}%</span>
                                <div className="w-16 h-1.5 bg-muted/30 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${wrPct >= 50 ? "bg-emerald-500" : "bg-red-500"} opacity-70`}
                                    style={{ width: `${wrPct}%` }}
                                  />
                                </div>
                              </div>
                            ) : "—"}
                          </td>
                          <td className={`px-4 py-2.5 font-semibold text-xs ${b.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {b.bets > 0 ? fmt$(b.pnl) : <span className="text-muted-foreground/50 font-normal">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Bands show the effective "locked" side price — YES bets use the yes price, NO bets use (1 − yes price) to match conviction logic.
                Suggestion requires ≥5 bets in a band. Adjust <span className="font-mono">kalshiLockPrice</span> in Bot Configuration to change the trigger.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
