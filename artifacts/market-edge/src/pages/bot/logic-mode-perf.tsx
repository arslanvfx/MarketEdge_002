import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import React from "react";
import type { LogicModeStats, BacktestModeStats } from "./types";
import { fmtPct } from "./utils";

interface LogicModePerfProps {
  logicPerfData: { modes: LogicModeStats[] } | undefined;
  backtestData: { modes: BacktestModeStats[] } | undefined;
  btPerfTab: "live" | "backtest";
  setBtPerfTab: React.Dispatch<React.SetStateAction<"live" | "backtest">>;
  activeMode: "paper" | "live";
}

export function LogicModePerf({ logicPerfData, backtestData, btPerfTab, setBtPerfTab, activeMode }: LogicModePerfProps) {
  return (
    <>
        {/* ── Logic Mode Performance ── */}
        {(() => {
          const modes = logicPerfData?.modes ?? [];
          const totalBets = modes.reduce((s, m) => s + m.bets, 0);
          const MODE_META: Record<string, { label: string; desc: string; color: string; accent: string }> = {
            classic:   { label: "Classic",   desc: "Stat → Claude → ML cascade", color: "border-sky-500/40 bg-sky-950/10",      accent: "text-sky-400" },
            ml_gate:   { label: "ML Gate",   desc: "ML veto on disagreement",    color: "border-violet-500/40 bg-violet-950/10", accent: "text-violet-400" },
            consensus: { label: "Consensus", desc: "2/3 majority vote",          color: "border-amber-500/40 bg-amber-950/10",  accent: "text-amber-400" },
            unanimous: { label: "Unanimous", desc: "All 3 signals must agree",   color: "border-emerald-500/40 bg-emerald-950/10", accent: "text-emerald-400" },
          };

          const btModes = backtestData?.modes ?? [];

          const fmt$ = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          const renderModeCard = (
            m: LogicModeStats | BacktestModeStats,
            isBacktest: boolean,
          ) => {
            const meta = MODE_META[m.mode] ?? { label: m.mode, desc: "", color: "border-border bg-card/60", accent: "text-foreground" };
            const isActive = m.mode === activeMode;
            const wr = m.winRate;
            const wrPct = wr != null ? Math.round(wr * 100) : null;
            const wrColor = wrPct == null ? "" : wrPct >= 60 ? "text-emerald-400" : wrPct >= 45 ? "text-amber-400" : "text-red-400";
            const pnlColor = m.pnl >= 0 ? "text-emerald-400" : "text-red-400";
            const coveragePct = isBacktest ? Math.round((m as BacktestModeStats).coverage * 100) : null;

            return (
              <div key={m.mode} className={`border rounded-xl p-4 relative ${meta.color} ${isActive ? "ring-2 ring-offset-1 ring-offset-card ring-current" : ""}`} style={isActive ? { ["--tw-ring-color" as string]: "rgb(99 102 241 / 0.5)" } : {}}>
                {isActive && (
                  <span className={`absolute top-2.5 right-2.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-current/20 ${meta.accent}`}>
                    ACTIVE
                  </span>
                )}
                <div className={`text-sm font-bold ${meta.accent} mb-0.5`}>{meta.label}</div>
                <div className="text-[10px] text-muted-foreground/70 mb-3 leading-tight">{meta.desc}</div>

                {m.bets === 0 ? (
                  <div className="text-xs text-muted-foreground italic">No bets yet</div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2 mb-2">
                      <span className={`text-2xl font-black ${wrColor}`}>
                        {wrPct != null ? `${wrPct}%` : "—"}
                      </span>
                      <span className="text-[10px] text-muted-foreground">win rate</span>
                    </div>

                    <div className="flex items-center gap-1 mb-2">
                      <div className="flex-1 h-2 bg-muted/30 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${wrPct != null && wrPct >= 50 ? "bg-emerald-500" : "bg-red-500"} opacity-70 transition-all`}
                          style={{ width: `${wrPct ?? 0}%` }}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1 text-center">
                      <div className="bg-background/30 rounded p-1.5">
                        <div className="text-[9px] text-muted-foreground uppercase">Bets</div>
                        <div className="text-xs font-bold">{m.bets}</div>
                      </div>
                      <div className="bg-emerald-500/10 rounded p-1.5">
                        <div className="text-[9px] text-emerald-400 uppercase">Wins</div>
                        <div className="text-xs font-bold text-emerald-400">{m.wins}</div>
                      </div>
                      <div className="bg-red-500/10 rounded p-1.5">
                        <div className="text-[9px] text-red-400 uppercase">Losses</div>
                        <div className="text-xs font-bold text-red-400">{m.losses}</div>
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-between">
                      <div className="text-[10px] text-muted-foreground">Total P&L</div>
                      <div className={`text-xs font-bold ${pnlColor}`}>{m.pnl >= 0 ? "+" : ""}{fmt$(m.pnl)}</div>
                    </div>

                    {!isBacktest && (m as LogicModeStats).avgConfidence != null && (
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-muted-foreground">Avg confidence</div>
                        <div className={`text-xs font-semibold ${
                          (m as LogicModeStats).avgConfidence! >= 60 ? "text-emerald-400/90"
                          : (m as LogicModeStats).avgConfidence! >= 52 ? "text-amber-400/90"
                          : "text-muted-foreground"
                        }`}>
                          {(m as LogicModeStats).avgConfidence!.toFixed(1)}%
                        </div>
                      </div>
                    )}

                    {isBacktest && coveragePct !== null && (
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="text-[10px] text-muted-foreground">Bets taken</div>
                        <div className={`text-xs font-semibold ${coveragePct >= 90 ? "text-muted-foreground" : coveragePct >= 70 ? "text-amber-400/80" : "text-sky-400/80"}`}>
                          {coveragePct}% of all
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          };

          return (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
                <Brain className="w-4 h-4 text-violet-400" />
                <h2 className="font-semibold text-sm">Logic Mode Performance</h2>
                <span className="text-xs text-muted-foreground">win/loss per decision strategy</span>
                <div className="ml-auto flex items-center gap-1">
                  {(["live", "backtest"] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setBtPerfTab(tab)}
                      className={`text-[10px] font-semibold px-2.5 py-1 rounded transition-colors ${
                        btPerfTab === tab
                          ? "bg-violet-500/20 text-violet-300"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                      }`}
                    >
                      {tab === "live" ? "Live" : "Backtest"}
                    </button>
                  ))}
                  <span className="ml-2 text-[10px] text-muted-foreground">{totalBets} settled bets</span>
                </div>
              </div>
              <div className="p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {btPerfTab === "live"
                    ? modes.map(m => renderModeCard(m, false))
                    : btModes.map(m => renderModeCard(m, true))
                  }
                </div>
                {btPerfTab === "live" ? (
                  <p className="text-[10px] text-muted-foreground mt-3">
                    Historical bets placed before this feature was added are attributed to Classic mode. Switch modes in Bot Configuration above and save to start tracking a new strategy.
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground/70 mt-3 italic">
                    Backtest replays your settled bets through each mode's gating rules using the signals recorded at bet time. Classic always approves (baseline). ML Gate rejects when ML was available and disagreed. Consensus requires ≥2 of 3 signals to agree. Results assume the same entries — real live behavior may differ.
                  </p>
                )}
              </div>
            </div>
          );
        })()}


    </>
  );
}
