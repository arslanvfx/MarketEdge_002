import { Target, TrendingUp, AlertTriangle, Lightbulb, ChevronDown, ChevronUp, Zap, Activity, WifiOff } from "lucide-react";
import { useState } from "react";
import type { ConvictionThresholdData, MaxBetStats } from "./types";

interface ConvictionThresholdPanelProps {
  data: ConvictionThresholdData | undefined;
  currentLockPrice: number | undefined;
  activeMode: "paper" | "live";
  maxBetStats?: MaxBetStats | null;
  convictionPollerRunning?: boolean;
  convictionPriceAgeMs?: Record<string, number>;
}

function fmtAge(ms: number): string {
  if (ms < 1000) return `${ms}ms ago`;
  return `${(ms / 1000).toFixed(1)}s ago`;
}

export function ConvictionThresholdPanel({ data, currentLockPrice, activeMode, maxBetStats, convictionPollerRunning, convictionPriceAgeMs }: ConvictionThresholdPanelProps) {
  const [open, setOpen] = useState(false);

  const pollerKnown = convictionPollerRunning !== undefined;
  const pollerLive = convictionPollerRunning === true;
  const priceEntries = convictionPriceAgeMs ? Object.entries(convictionPriceAgeMs) : [];

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
          {pollerKnown && (
            <span className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
              pollerLive
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400"
            }`}>
              {pollerLive
                ? <Activity className="w-3 h-3" />
                : <WifiOff className="w-3 h-3" />}
              {pollerLive ? "Poller: live" : "Poller: stopped"}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">{totalBets} settled bets</span>
          {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div className="p-5 space-y-4">
          {pollerKnown && (
            <div className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 border text-[10px] ${
              pollerLive
                ? "bg-emerald-500/5 border-emerald-500/20"
                : "bg-red-500/5 border-red-500/20"
            }`}>
              <div className="flex items-center gap-1.5 font-semibold">
                {pollerLive
                  ? <Activity className="w-3 h-3 text-emerald-400" />
                  : <WifiOff className="w-3 h-3 text-red-400" />}
                <span className={pollerLive ? "text-emerald-300" : "text-red-300"}>
                  {pollerLive ? "1 s price poller running" : "Price poller stopped — falling back to 2 s cache"}
                </span>
              </div>
              {priceEntries.length > 0 && (
                <div className="flex flex-wrap gap-2 ml-1">
                  {priceEntries.map(([sym, ageMs]) => (
                    <span key={sym} className={`font-mono px-1.5 py-0.5 rounded ${
                      ageMs < 1500
                        ? "bg-emerald-500/10 text-emerald-300"
                        : ageMs < 3000
                        ? "bg-amber-500/10 text-amber-300"
                        : "bg-red-500/10 text-red-300"
                    }`}>
                      {sym} {fmtAge(ageMs)}
                    </span>
                  ))}
                </div>
              )}
              {pollerLive && priceEntries.length === 0 && (
                <span className="text-muted-foreground/60 italic">waiting for first poll…</span>
              )}
            </div>
          )}

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

          {/* Max bet vs regular bet breakdown — always visible when data exists */}
          {maxBetStats && (maxBetStats.total > 0 || maxBetStats.regularTotal > 0) && (() => {
            const mb = maxBetStats;
            const fmt$mb = (v: number) => (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(2);
            const fmtPct = (v: number | null) => v == null ? "—" : `${Math.round(v * 100)}%`;
            const wrColor = (v: number | null) => v == null ? "text-muted-foreground"
              : v >= 0.60 ? "text-emerald-400"
              : v >= 0.45 ? "text-amber-400"
              : "text-red-400";
            const pnlColor = (v: number) => v >= 0 ? "text-emerald-400" : "text-red-400";
            const diff = mb.total > 0 && mb.regularTotal > 0 && mb.winRate != null && mb.regularWinRate != null
              ? mb.winRate - mb.regularWinRate : null;
            return (
              <div className={totalBets > 0 ? "border-t border-border/50 pt-4" : ""}>
                <div className="flex items-center gap-1.5 mb-3">
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-xs font-semibold text-foreground">Max Bet vs Regular Bet</span>
                  {mb.total === 0 && (
                    <span className="text-[10px] text-muted-foreground/50 italic ml-1">no max bets yet — accumulating history</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 flex flex-col gap-1">
                    <div className="flex items-center gap-1 mb-0.5">
                      <Zap className="w-3 h-3 text-emerald-400" />
                      <span className="text-[10px] font-semibold text-emerald-300">Max Bets</span>
                      <span className="ml-auto text-[9px] text-muted-foreground font-mono">{mb.total}</span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className={`text-lg font-bold ${mb.total === 0 ? "text-muted-foreground/40" : wrColor(mb.winRate)}`}>
                        {mb.total === 0 ? "—" : fmtPct(mb.winRate)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">WR</span>
                    </div>
                    <div className="flex gap-2 text-[10px]">
                      <span className="text-emerald-400">{mb.wins}W</span>
                      <span className="text-muted-foreground/40">/</span>
                      <span className="text-red-400">{mb.losses}L</span>
                    </div>
                    <div className={`text-[10px] font-mono font-semibold ${pnlColor(mb.totalPnl)}`}>{fmt$mb(mb.totalPnl)}</div>
                  </div>
                  <div className="rounded-lg border border-border/40 bg-muted/20 p-3 flex flex-col gap-1">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-[10px] font-semibold text-muted-foreground">Regular Bets</span>
                      <span className="ml-auto text-[9px] text-muted-foreground font-mono">{mb.regularTotal}</span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className={`text-lg font-bold ${wrColor(mb.regularWinRate)}`}>{fmtPct(mb.regularWinRate)}</span>
                      <span className="text-[10px] text-muted-foreground">WR</span>
                    </div>
                    <div className="flex gap-2 text-[10px]">
                      <span className="text-emerald-400">{mb.regularWins}W</span>
                      <span className="text-muted-foreground/40">/</span>
                      <span className="text-red-400">{mb.regularLosses}L</span>
                    </div>
                    <div className={`text-[10px] font-mono font-semibold ${pnlColor(mb.regularTotalPnl)}`}>{fmt$mb(mb.regularTotalPnl)}</div>
                  </div>
                </div>
                {diff != null && (
                  <p className={`text-[10px] mt-1.5 ${Math.abs(diff) <= 0.02 ? "text-muted-foreground" : diff > 0 ? "text-emerald-400" : "text-amber-400"}`}>
                    {diff > 0.02 ? `Max bets outperforming by ${Math.round(diff * 100)}pp`
                      : diff < -0.02 ? `Regular bets outperforming by ${Math.round(Math.abs(diff) * 100)}pp`
                      : "Max and regular bets performing similarly"}
                  </p>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
