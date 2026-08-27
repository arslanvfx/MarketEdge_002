import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import type { PerformanceReport, BotStats } from "./types";
import { fmt$, fmtPct, bandToEst, EST } from "./utils";

interface PerformanceInsightsProps {
  perfReportData: { report: PerformanceReport | null; pausedCoins: Record<string, number> } | undefined;
  statsData: BotStats | undefined;
  activeMode: "paper" | "live";
}

export function PerformanceInsights({ perfReportData, statsData, activeMode }: PerformanceInsightsProps) {
  const [perfOpen, setPerfOpen] = useState(false);
  return (
    <>
        {/* ── Performance Insights ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setPerfOpen(o => !o)}
          >
            <Brain className="w-4 h-4 text-sky-400" />
            <h2 className="font-semibold text-sm">Performance Insights</h2>
            {perfReportData?.report && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {perfReportData.report.totalBets} bets analysed
              </span>
            )}
            {perfOpen ? <ChevronUp className="w-4 h-4 ml-1 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 ml-1 text-muted-foreground" />}
          </button>
          {perfOpen && (
            <div className="p-5 space-y-5">
              {!perfReportData?.report ? (
                <p className="text-sm text-muted-foreground">
                  No report yet — the first analysis runs 15 minutes after startup.
                </p>
              ) : (() => {
                const r = perfReportData.report;
                const paused = perfReportData.pausedCoins ?? {};
                const pct = (v: number | null) => v == null ? "—" : `${Math.round(v * 100)}%`;

                return (
                  <>
                    {/* Top stats */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Total Bets", value: String(r.totalBets) },
                        { label: "Overall Win Rate", value: pct(r.overallWinRate) },
                        { label: "Last-24h Win Rate", value: pct(r.last24hWinRate) },
                        { label: "CB Triggers", value: String(r.circuitBreakerTriggers),
                          color: r.circuitBreakerTriggers >= 3 ? "text-red-400" : r.circuitBreakerTriggers >= 1 ? "text-amber-400" : "" },
                      ].map(({ label, value, color }) => (
                        <div key={label} className="bg-background/40 rounded-lg p-3 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
                          <div className={`text-base font-bold ${color ?? ""}`}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Win-rate trend sparkline */}
                    {r.totalBets > 0 && (() => {
                      const points = [
                        { label: "Last 10", wr: r.last10WinRate },
                        { label: "Last 30", wr: r.last30WinRate },
                        { label: "Last 24h", wr: r.last24hWinRate },
                        { label: "All-time", wr: r.overallWinRate },
                      ].filter(p => p.wr !== null);
                      if (points.length === 0) return null;
                      return (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win-Rate Trend</div>
                          <div className="flex items-end gap-2 h-16">
                            {points.map(({ label, wr }) => {
                              const pctVal = Math.round((wr ?? 0) * 100);
                              const barH = Math.max(4, Math.round((pctVal / 100) * 64));
                              const color = pctVal >= 60 ? "bg-emerald-500" : pctVal >= 45 ? "bg-yellow-500" : "bg-red-500";
                              return (
                                <div key={label} className="flex flex-col items-center gap-1 flex-1">
                                  <span className="text-[9px] font-medium" style={{ color: pctVal >= 60 ? "#10b981" : pctVal >= 45 ? "#eab308" : "#ef4444" }}>{pctVal}%</span>
                                  <div className={`w-full rounded-t ${color} opacity-80 transition-all`} style={{ height: `${barH}px` }} />
                                  <span className="text-[8px] text-muted-foreground text-center leading-tight">{label}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Direction balance bar */}
                    {(r.byDirection.yes.betCount + r.byDirection.no.betCount) > 0 && (() => {
                      const total = r.byDirection.yes.betCount + r.byDirection.no.betCount;
                      const yesPct = Math.round((r.byDirection.yes.betCount / total) * 100);
                      const noPct = 100 - yesPct;
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Direction Balance</span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              YES {r.byDirection.yes.betCount} · NO {r.byDirection.no.betCount}
                            </span>
                          </div>
                          <div className="flex rounded-full overflow-hidden h-4">
                            <div
                              className="bg-sky-500 flex items-center justify-center text-[9px] font-bold text-white"
                              style={{ width: `${yesPct}%` }}
                            >{yesPct >= 20 ? `${yesPct}%` : ""}</div>
                            <div
                              className="bg-violet-500 flex items-center justify-center text-[9px] font-bold text-white"
                              style={{ width: `${noPct}%` }}
                            >{noPct >= 20 ? `${noPct}%` : ""}</div>
                          </div>
                          <div className="flex justify-between mt-1">
                            <span className="text-[9px] text-sky-400 font-medium">▲ YES · {pct(r.byDirection.yes.winRate)} WR</span>
                            <span className="text-[9px] text-violet-400 font-medium">▼ NO · {pct(r.byDirection.no.winRate)} WR</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Max bet vs regular bet comparison */}
                    {r.maxBetStats && (r.maxBetStats.total > 0 || r.maxBetStats.regularTotal > 0) && (() => {
                      const mb = r.maxBetStats!;
                      const fmt$ = (v: number) => (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(2);
                      const fmtPct = (v: number | null) => v == null ? "—" : `${Math.round(v * 100)}%`;
                      const mbColor = mb.winRate == null ? "text-muted-foreground"
                        : mb.winRate >= 0.60 ? "text-emerald-400"
                        : mb.winRate >= 0.45 ? "text-amber-400"
                        : "text-red-400";
                      const regColor = mb.regularWinRate == null ? "text-muted-foreground"
                        : mb.regularWinRate >= 0.60 ? "text-emerald-400"
                        : mb.regularWinRate >= 0.45 ? "text-amber-400"
                        : "text-red-400";
                      const pnlColor = (v: number) => v >= 0 ? "text-emerald-400" : "text-red-400";
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                              <Zap className="w-3 h-3 text-emerald-400" />
                              Max Bet vs Regular Bet
                            </span>
                            {mb.total === 0 && (
                              <span className="text-[9px] text-muted-foreground/50 italic">No max bets recorded yet</span>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {/* Max bets card */}
                            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 flex flex-col gap-1">
                              <div className="flex items-center gap-1 mb-0.5">
                                <Zap className="w-3 h-3 text-emerald-400" />
                                <span className="text-[10px] font-semibold text-emerald-300">Max Bets</span>
                                <span className="ml-auto text-[9px] text-muted-foreground font-mono">{mb.total} bets</span>
                              </div>
                              <div className="flex items-baseline gap-1.5">
                                <span className={`text-xl font-bold ${mbColor}`}>{fmtPct(mb.winRate)}</span>
                                <span className="text-[10px] text-muted-foreground">win rate</span>
                              </div>
                              <div className="flex gap-2 text-[10px]">
                                <span className="text-emerald-400">{mb.wins}W</span>
                                <span className="text-muted-foreground/50">/</span>
                                <span className="text-red-400">{mb.losses}L</span>
                              </div>
                              <div className={`text-[10px] font-mono font-semibold ${pnlColor(mb.totalPnl)}`}>
                                {fmt$(mb.totalPnl)} P&L
                              </div>
                            </div>
                            {/* Regular bets card */}
                            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 flex flex-col gap-1">
                              <div className="flex items-center gap-1 mb-0.5">
                                <span className="text-[10px] font-semibold text-muted-foreground">Regular Bets</span>
                                <span className="ml-auto text-[9px] text-muted-foreground font-mono">{mb.regularTotal} bets</span>
                              </div>
                              <div className="flex items-baseline gap-1.5">
                                <span className={`text-xl font-bold ${regColor}`}>{fmtPct(mb.regularWinRate)}</span>
                                <span className="text-[10px] text-muted-foreground">win rate</span>
                              </div>
                              <div className="flex gap-2 text-[10px]">
                                <span className="text-emerald-400">{mb.regularWins}W</span>
                                <span className="text-muted-foreground/50">/</span>
                                <span className="text-red-400">{mb.regularLosses}L</span>
                              </div>
                              <div className={`text-[10px] font-mono font-semibold ${pnlColor(mb.regularTotalPnl)}`}>
                                {fmt$(mb.regularTotalPnl)} P&L
                              </div>
                            </div>
                          </div>
                          {mb.total > 0 && mb.regularTotal > 0 && mb.winRate != null && mb.regularWinRate != null && (() => {
                            const diff = mb.winRate - mb.regularWinRate;
                            const absDiff = Math.abs(Math.round(diff * 100));
                            const better = diff > 0.02 ? "Max bets outperforming" : diff < -0.02 ? "Regular bets outperforming" : "Max and regular bets performing";
                            const color = diff > 0.02 ? "text-emerald-400" : diff < -0.02 ? "text-amber-400" : "text-muted-foreground";
                            return (
                              <div className={`text-[9px] ${color} mt-1`}>
                                {better} by {absDiff}pp {diff <= 0.02 && diff >= -0.02 ? "(similar)" : ""}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}

                    {/* Confidence avg W vs L */}
                    {(r.avgConfidenceWinners != null || r.avgConfidenceLosers != null) && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-emerald-400 mb-1">Avg Confidence — Winners</div>
                          <div className="text-base font-bold text-emerald-400">{r.avgConfidenceWinners != null ? `${r.avgConfidenceWinners.toFixed(0)}%` : "—"}</div>
                        </div>
                        <div className="bg-red-500/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-red-400 mb-1">Avg Confidence — Losers</div>
                          <div className="text-base font-bold text-red-400">{r.avgConfidenceLosers != null ? `${r.avgConfidenceLosers.toFixed(0)}%` : "—"}</div>
                        </div>
                      </div>
                    )}

                    {/* Confidence-band win-rate breakdown */}
                    {(() => {
                      const bands = r.byConfidenceBand
                        ? Object.values(r.byConfidenceBand).filter(b => b.betCount > 0)
                        : [];
                      if (bands.length === 0) return null;
                      const maxBets = Math.max(...bands.map(b => b.betCount));
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Confidence Level</span>
                            {r.optimalConfidenceThreshold != null && (
                              <span className="text-[10px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                Optimal floor: {r.optimalConfidenceThreshold}%
                              </span>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            {Object.values(r.byConfidenceBand ?? {})
                              .sort((a, b) => a.lowerBound - b.lowerBound)
                              .map(b => {
                                const wr = b.winRate ?? 0;
                                const isOptimal = r.optimalConfidenceThreshold === b.lowerBound;
                                const barColor = b.betCount < 5 ? "bg-muted/50"
                                  : wr >= 0.65 ? "bg-emerald-500"
                                  : wr >= 0.50 ? "bg-yellow-500"
                                  : "bg-red-500";
                                const textColor = b.betCount < 5 ? "text-muted-foreground"
                                  : wr >= 0.65 ? "text-emerald-400"
                                  : wr >= 0.50 ? "text-yellow-400"
                                  : "text-red-400";
                                const barWidth = maxBets > 0 ? Math.max(4, Math.round((b.betCount / maxBets) * 100)) : 4;
                                return (
                                  <div key={b.band} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${isOptimal ? "bg-emerald-500/10 ring-1 ring-emerald-500/40" : "bg-background/30"}`}>
                                    <span className="text-[10px] font-mono w-12 flex-shrink-0 text-muted-foreground">{b.band}%</span>
                                    <div className="flex-1 h-3 bg-muted/30 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full transition-all ${barColor} opacity-70`} style={{ width: `${barWidth}%` }} />
                                    </div>
                                    <span className={`text-[10px] font-bold w-8 text-right ${textColor}`}>
                                      {b.betCount < 5 ? "—" : `${Math.round(wr * 100)}%`}
                                    </span>
                                    <span className="text-[9px] text-muted-foreground w-12 text-right">{b.betCount} bet{b.betCount !== 1 ? "s" : ""}</span>
                                    {isOptimal && <span className="text-[9px] text-emerald-400 font-bold">★</span>}
                                  </div>
                                );
                              })}
                          </div>
                          {Object.values(r.byConfidenceBand ?? {}).every(b => b.betCount < 5) && (
                            <p className="text-[10px] text-muted-foreground mt-1.5">Need ≥ 5 bets per band to show reliable win rates</p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Signal agreement breakdown */}
                    {(() => {
                      const levels = r.byAgreementLevel
                        ? Object.values(r.byAgreementLevel).filter(l => l.betCount > 0)
                        : [];
                      if (levels.length === 0) return null;
                      return (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win Rate by Signal Agreement</div>
                          <div className="grid grid-cols-3 gap-2">
                            {levels
                              .sort((a, b) => b.agreeing - a.agreeing)
                              .map(l => {
                                const wr = l.winRate ?? 0;
                                const color = l.betCount < 3 ? "text-muted-foreground"
                                  : wr >= 0.60 ? "text-emerald-400"
                                  : wr >= 0.45 ? "text-yellow-400"
                                  : "text-red-400";
                                const bg = l.betCount < 3 ? "bg-muted/20"
                                  : wr >= 0.60 ? "bg-emerald-500/10"
                                  : wr >= 0.45 ? "bg-yellow-500/10"
                                  : "bg-red-500/10";
                                return (
                                  <div key={l.level} className={`rounded-lg p-3 text-center ${bg}`}>
                                    <div className="text-xs font-bold mb-0.5">{l.level} signals</div>
                                    <div className={`text-base font-bold ${color}`}>
                                      {l.betCount < 3 ? "—" : `${Math.round(wr * 100)}%`}
                                    </div>
                                    <div className="text-[9px] text-muted-foreground">{l.wins}W / {l.losses}L</div>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Per-symbol breakdown */}
                    {Object.keys(r.bySymbol).length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">By Coin</div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {Object.entries(r.bySymbol).map(([sym, s]) => {
                            const isPaused = paused[sym] != null;
                            return (
                              <div key={sym} className={`rounded-lg p-3 bg-background/40 border ${isPaused ? "border-amber-500/50" : "border-transparent"}`}>
                                <div className="flex items-center gap-1 mb-1">
                                  <span className="text-xs font-bold">{sym}</span>
                                  {isPaused && (
                                    <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1 rounded">
                                      paused {paused[sym]}w
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {s.wins}W / {s.losses}L · {pct(s.winRate)} WR
                                </div>
                                {s.currentConsecutiveLosses >= 3 && (
                                  <div className="text-[9px] text-red-400 mt-0.5">
                                    {s.currentConsecutiveLosses} consecutive losses
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Hour band heatmap */}
                    {Object.keys(r.byHourBand).length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Win Rate by Hour Band (EST)</div>
                        <div className="flex flex-wrap gap-2">
                          {Object.values(r.byHourBand)
                            .sort((a, b) => a.band.localeCompare(b.band))
                            .map(b => {
                              const wr = b.winRate ?? 0;
                              const color = b.betCount < 5 ? "bg-muted/40 text-muted-foreground"
                                : wr >= 0.6 ? "bg-emerald-500/20 text-emerald-400"
                                : wr >= 0.4 ? "bg-yellow-500/20 text-yellow-400"
                                : "bg-red-500/20 text-red-400";
                              return (
                                <div key={b.band} className={`rounded-lg px-3 py-2 text-center min-w-[70px] ${color}`}>
                                  <div className="text-[9px] font-mono mb-0.5">{bandToEst(b.band)}</div>
                                  <div className="text-xs font-bold">{pct(b.winRate)}</div>
                                  <div className="text-[9px] opacity-70">{b.betCount} bets</div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}

                    {/* Day of Week win rate */}
                    {r.byDayOfWeek && Object.values(r.byDayOfWeek).some(d => d.betCount > 0) && (() => {
                      const days = [1,2,3,4,5,6,0].map(d => r.byDayOfWeek[d]).filter(Boolean);
                      const maxWR = Math.max(...days.map(d => d.winRate ?? 0));
                      const bestDay = days.reduce((b, d) => (d.betCount >= 3 && (d.winRate ?? 0) > (b.winRate ?? 0)) ? d : b, days[0]);
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Day of Week</div>
                            {bestDay?.betCount >= 3 && bestDay.winRate !== null && (
                              <span className="text-[10px] text-emerald-400 font-medium">
                                Best: {bestDay.dayName} ({Math.round(bestDay.winRate * 100)}% / {bestDay.betCount} bets)
                              </span>
                            )}
                          </div>
                          <div className="flex gap-1.5">
                            {days.map(d => {
                              const wr = d.winRate ?? 0;
                              const barH = d.betCount === 0 ? 4 : Math.max(8, Math.round(wr * 56));
                              const isTop = d.betCount >= 3 && wr === maxWR && maxWR > 0;
                              const color = d.betCount < 3 ? "bg-muted/40"
                                : wr >= 0.65 ? "bg-emerald-500"
                                : wr >= 0.5  ? "bg-sky-500"
                                : wr >= 0.35 ? "bg-yellow-500"
                                : "bg-red-500";
                              return (
                                <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                                  <div className="w-full flex items-end justify-center" style={{ height: 60 }}>
                                    <div
                                      className={`w-full rounded-t transition-all ${color} ${isTop ? "ring-1 ring-emerald-400/60" : ""}`}
                                      style={{ height: barH }}
                                      title={`${d.dayName}: ${d.betCount} bets, ${d.betCount > 0 ? Math.round(wr * 100) : "—"}% WR`}
                                    />
                                  </div>
                                  <div className="text-[9px] font-medium text-muted-foreground">{d.dayName}</div>
                                  <div className={`text-[9px] font-bold ${d.betCount < 3 ? "text-muted-foreground/50" : wr >= 0.6 ? "text-emerald-400" : wr >= 0.4 ? "text-sky-400" : "text-red-400"}`}>
                                    {d.betCount === 0 ? "—" : `${Math.round(wr * 100)}%`}
                                  </div>
                                  <div className="text-[8px] text-muted-foreground/50">{d.betCount}b</div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="text-[9px] text-muted-foreground/50 mt-1">Bars fade when &lt;3 bets — not enough data yet</div>
                        </div>
                      );
                    })()}

                    {/* Hour of Day win rate heatmap */}
                    {r.byHourOfDay && Object.values(r.byHourOfDay).some(h => h.betCount > 0) && (() => {
                      const hours = Array.from({ length: 24 }, (_, i) => r.byHourOfDay[i]).filter(Boolean);
                      const bestHour = hours.reduce((b, h) => (h.betCount >= 3 && (h.winRate ?? 0) > (b.winRate ?? 0)) ? h : b, hours[0]);
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Hour of Day (EST)</div>
                            {bestHour?.betCount >= 3 && bestHour.winRate !== null && (
                              <span className="text-[10px] text-emerald-400 font-medium">
                                Best: {new Date(Date.UTC(2000,0,1,(bestHour.hour))).toLocaleTimeString("en-US",{hour:"numeric",hour12:true,timeZone:EST})} EST ({Math.round(bestHour.winRate * 100)}%)
                              </span>
                            )}
                          </div>
                          <div className="flex gap-px">
                            {hours.map(h => {
                              const wr = h.winRate ?? 0;
                              const barH = h.betCount === 0 ? 3 : Math.max(6, Math.round(wr * 48));
                              const color = h.betCount < 2 ? "bg-muted/30"
                                : wr >= 0.7  ? "bg-emerald-400"
                                : wr >= 0.55 ? "bg-sky-400"
                                : wr >= 0.4  ? "bg-yellow-400"
                                : "bg-red-400";
                              return (
                                <div key={h.hour} className="flex-1 flex flex-col items-center gap-px" title={`${new Date(Date.UTC(2000,0,1,h.hour)).toLocaleTimeString("en-US",{hour:"numeric",hour12:true,timeZone:EST})} EST — ${h.betCount} bets${h.betCount > 0 ? `, ${Math.round(wr*100)}% WR` : ""}`}>
                                  <div className="w-full flex items-end" style={{ height: 52 }}>
                                    <div className={`w-full rounded-sm ${color}`} style={{ height: barH }} />
                                  </div>
                                  {h.hour % 6 === 0 && (
                                    <div className="text-[8px] text-muted-foreground/60">{new Date(Date.UTC(2000,0,1,h.hour)).toLocaleTimeString("en-US",{hour:"numeric",hour12:true,timeZone:EST}).replace(":00","")}</div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex justify-between text-[8px] text-muted-foreground/40 mt-0.5 px-px">
                            <span>7PM</span><span>1AM</span><span>7AM</span><span>1PM</span><span>6PM</span>
                          </div>
                          <div className="text-[9px] text-muted-foreground/50 mt-1">Hover bars for detail · Labels every 6 hours (EST) · Faded = &lt;2 bets</div>
                        </div>
                      );
                    })()}

                    {/* Recommendations */}
                    {r.recommendations.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Recommendations</div>
                        <div className="space-y-1.5">
                          {r.recommendations.map((rec, i) => (
                            <div key={i} className="flex items-start gap-2 text-sm bg-sky-500/10 text-sky-300 rounded-lg px-3 py-2">
                              <Zap className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                              {rec}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="text-[10px] text-muted-foreground">
                      Last computed: {r.computedAt ? new Date(r.computedAt).toLocaleString("en-US", { timeZone: EST, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>


    </>
  );
}
