import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save, Thermometer, Waves, Crosshair, Timer, Users } from "lucide-react";
import React from "react";
import type { HistoryRecord } from "./types";
import { fmt$, fmtPct, fmtDateTime, fmtCrypto, fmtDuration, wkToEst } from "./utils";

const HIST_PAGE_SIZE = 20;

interface TransactionLogProps {
  pagedBets: HistoryRecord[];
  histPage: number;
  setHistPage: React.Dispatch<React.SetStateAction<number>>;
  totalHistPages: number;
  totalBets: number;
  historyMode: "paper" | "live";
  setHistoryMode: React.Dispatch<React.SetStateAction<"paper" | "live">>;
  histSourceFilter: "all" | "bot" | "manual";
  setHistSourceFilter: React.Dispatch<React.SetStateAction<"all" | "bot" | "manual">>;
  activeMode: "paper" | "live";
}

export function TransactionLog({ pagedBets, histPage, setHistPage, totalHistPages, totalBets, historyMode, setHistoryMode, histSourceFilter, setHistSourceFilter, activeMode }: TransactionLogProps) {
  const clampedHistPage = Math.min(histPage, Math.max(0, totalHistPages - 1));
  return (
    <>
        {/* ── Transaction Log ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Transaction History</h2>
            {/* Paper / Live tab — independent of the bot's active mode so the user
                can always browse either log regardless of which mode the bot is in. */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-medium ml-1">
              {(["paper", "live"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => { setHistoryMode(m); setHistPage(0); }}
                  className={`px-2.5 py-1 transition-colors capitalize ${historyMode === m ? (m === "live" ? "bg-red-500/20 text-red-300" : "bg-yellow-500/15 text-yellow-300") : "text-muted-foreground hover:text-foreground"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            {/* Source filter — All / Bot / Manual */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-medium ml-1">
              {(["all", "bot", "manual"] as const).map(s => (
                <button
                  key={s}
                  onClick={() => { setHistSourceFilter(s); setHistPage(0); }}
                  className={`px-2.5 py-1 transition-colors capitalize ${histSourceFilter === s ? (s === "manual" ? "bg-purple-500/20 text-purple-300" : "bg-muted text-foreground") : "text-muted-foreground hover:text-foreground"}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{totalBets} record{totalBets !== 1 ? "s" : ""}</span>
            {totalHistPages > 1 && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setHistPage(p => Math.max(0, p - 1))}
                  disabled={clampedHistPage === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-muted-foreground tabular-nums px-1">
                  {clampedHistPage + 1} / {totalHistPages}
                </span>
                <button
                  onClick={() => setHistPage(p => Math.min(totalHistPages - 1, p + 1))}
                  disabled={clampedHistPage === totalHistPages - 1}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {totalBets === 0 ? (
            <div className="px-5 py-12 text-center">
              <Bot className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No bets placed yet. The bot is watching the markets.</p>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {totalHistPages > 1 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground pb-1">
                  <span>Showing {clampedHistPage * HIST_PAGE_SIZE + 1}–{Math.min((clampedHistPage + 1) * HIST_PAGE_SIZE, totalBets)} of {totalBets}</span>
                </div>
              )}
              {pagedBets.map((r) => {
                const pnlNum = r.pnl != null ? parseFloat(r.pnl) : null;
                const ep = r.entryPrice != null ? parseFloat(r.entryPrice) : null;
                const xp = r.exitPrice != null ? parseFloat(r.exitPrice) : null;
                const isShadow = r.action === "shadow";
                const isSkip = r.action === "skip";
                const isOpen = r.action === "bet";
                const isPendingEval = !isOpen && !isShadow && !isSkip && r.outcome == null;
                const isWin = r.outcome === "win";
                const isLoss = r.outcome === "loss";
                const sigs = r.signals as Record<string, unknown> | null;
                const closePx = sigs?.closePriceAtEval as number | null ?? null;
                const endPx = closePx ?? (r.cryptoPriceAtExit != null ? parseFloat(r.cryptoPriceAtExit) : null);
                const strike = r.kalshiTarget != null ? parseFloat(r.kalshiTarget) : null;
                const endAboveStrike = endPx != null && strike != null ? endPx >= strike : null;

                const statAbove = sigs?.statAbove as boolean | null ?? null;
                const claudeAbove = sigs?.claudeAbove as boolean | null ?? null;
                const mlAbove = sigs?.mlAbove as boolean | null ?? null;
                const agreementTarget = sigs?.agreementTarget as string | null ?? null;

                const cardBg = isShadow
                  ? "border-violet-500/20 bg-violet-950/5"
                  : isSkip
                    ? "border-orange-500/20 bg-orange-950/5"
                    : isOpen
                      ? "border-sky-500/30 bg-sky-950/10"
                      : isWin
                        ? "border-emerald-500/30 bg-emerald-950/10"
                        : isLoss
                          ? "border-red-500/30 bg-red-950/10"
                          : isPendingEval
                            ? "border-amber-500/20 bg-amber-950/5"
                            : "border-border bg-card/60";

                return (
                  <div key={r.id} className={`border rounded-xl p-4 transition-colors ${cardBg}`}>
                    {/* Card header */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-base font-black tracking-tight text-foreground">{r.symbol}</span>

                      {r.direction && (
                        <span className={`flex items-center gap-0.5 text-xs font-bold px-2 py-0.5 rounded-full ${r.direction === "yes" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                          {r.direction === "yes" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                          {r.direction === "yes" ? "ABOVE" : "BELOW"}
                        </span>
                      )}

                      {isShadow ? (
                        <>
                          <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300"
                            title="Probe bet — recorded during doubt-penalty lockout. No real order placed.">
                            PROBE
                          </span>
                          {r.outcome === "win" ? (
                            <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
                              <Trophy className="w-3 h-3" /> WOULD WIN
                            </span>
                          ) : r.outcome === "loss" ? (
                            <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">
                              <XCircle className="w-3 h-3" /> WOULD LOSE
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400/70 animate-pulse">
                              <Activity className="w-3 h-3" /> PENDING
                            </span>
                          )}
                        </>
                      ) : isSkip ? (
                        (() => {
                          const reason = sigs?.reason as string | null ?? null;
                          type SkipMeta = { label: string; icon: React.ReactNode; detail?: string };
                          const SKIP_META: Record<string, SkipMeta> = {
                            "market-consensus-gate":      { label: "Consensus gate",      icon: <Users className="w-3 h-3" />,       detail: "YES price below 25¢ floor" },
                            "live-signal-stale-hard-stop":{ label: "Stale signal",        icon: <Timer className="w-3 h-3" />,       detail: "Live signal too old to trust" },
                            "candle-cache-not-warm":      { label: "Candles not ready",   icon: <Thermometer className="w-3 h-3" />, detail: "Candle cache still warming up" },
                            "candle-momentum-reversal":   { label: "Momentum reversal",   icon: <Waves className="w-3 h-3" />,       detail: "Last candles show counter-trend move" },
                            "strike-proximity":           { label: "Near strike",         icon: <Crosshair className="w-3 h-3" />,   detail: "Price too close to strike" },
                            "strike-oscillation":         { label: "Strike oscillation",  icon: <Waves className="w-3 h-3" />,       detail: "Price crossing strike repeatedly" },
                            "warmup-buffer":              { label: "Warmup buffer",       icon: <Timer className="w-3 h-3" />,       detail: "Bot still in window warmup period" },
                          };
                          const meta = reason ? SKIP_META[reason] : null;
                          const label = meta?.label ?? (reason ? reason.replace(/-/g, " ") : "Gated");
                          const icon  = meta?.icon ?? <Shield className="w-3 h-3" />;
                          const tooltip = meta?.detail
                            ? `${reason} — ${meta.detail}`
                            : (reason ?? "Entry gate fired");
                          return (
                            <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300"
                              title={tooltip}>
                              {icon} SKIP — {label}
                            </span>
                          );
                        })()
                      ) : isOpen ? (
                        <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 animate-pulse">
                          <Activity className="w-3 h-3" /> ACTIVE
                        </span>
                      ) : isWin ? (
                        <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                          <Trophy className="w-3 h-3" /> WIN
                        </span>
                      ) : isLoss ? (
                        <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">
                          <XCircle className="w-3 h-3" /> LOSS
                        </span>
                      ) : isPendingEval ? (
                        <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 animate-pulse">
                          <Activity className="w-3 h-3" /> EVALUATING
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {r.action.replace(/_/g, " ").toUpperCase()}
                        </span>
                      )}

                      {/* Signal agreement pills */}
                      {agreementTarget != null && (
                        <div className="flex items-center gap-1 ml-1">
                          {([["S", statAbove], ["C", claudeAbove], ["ML", mlAbove]] as [string, boolean | null][]).map(([label, val]) => (
                            val != null ? (
                              <span key={label} className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                (agreementTarget === "BET_YES" ? val === true : val === false)
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-red-500/15 text-red-400"
                              }`}>{label}</span>
                            ) : null
                          ))}
                        </div>
                      )}

                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-500"}`}>
                        {r.mode?.toUpperCase()}
                      </span>

                      {/* Manual badge — shown when the bet was placed via the dashboard button */}
                      {(r.source === "manual" || (r.signals as Record<string, unknown> | null)?.manual === true) && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                          MANUAL
                        </span>
                      )}

                      {/* Decision mode badge */}
                      {(() => {
                        const dm = r.decisionMode ?? "classic";
                        const meta: Record<string, { label: string; cls: string }> = {
                          classic:   { label: "Classic",   cls: "bg-sky-500/10 text-sky-400/80" },
                          ml_gate:   { label: "ML Gate",   cls: "bg-violet-500/10 text-violet-400/80" },
                          consensus: { label: "Consensus", cls: "bg-amber-500/10 text-amber-400/80" },
                          unanimous: { label: "Unanimous", cls: "bg-emerald-500/10 text-emerald-400/80" },
                        };
                        const { label, cls } = meta[dm] ?? { label: dm, cls: "bg-muted/30 text-muted-foreground" };
                        return (
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>
                            {label}
                          </span>
                        );
                      })()}

                      <span className="ml-auto text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                    </div>

                    {/* Key metrics grid */}
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Strike</div>
                        <div className="text-xs font-semibold font-mono">{fmtCrypto(r.kalshiTarget)}</div>
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">
                          {closePx != null ? "Close Price" : isOpen ? "Entry Price" : "End Price"}
                        </div>
                        <div className="text-xs font-semibold font-mono flex items-center gap-1">
                          {endPx != null ? (
                            <>
                              {fmtCrypto(endPx)}
                              {endAboveStrike !== null && (
                                <span className={endAboveStrike ? "text-emerald-400" : "text-red-400"}>
                                  {endAboveStrike ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />}
                                </span>
                              )}
                            </>
                          ) : "—"}
                        </div>
                        {closePx == null && endPx != null && (
                          <div className="text-[9px] text-muted-foreground mt-0.5">at exit</div>
                        )}
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Entry</div>
                        <div className="text-xs font-mono">
                          {ep != null ? (
                            <span>{(ep * 100).toFixed(0)}¢ YES · {((1 - ep) * 100).toFixed(0)}¢ NO</span>
                          ) : "—"}
                        </div>
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Exit</div>
                        <div className="text-xs font-mono">
                          {xp != null ? `${(xp * 100).toFixed(0)}¢ YES` : isOpen ? <span className="text-sky-400 text-[9px]">in play…</span> : "—"}
                        </div>
                      </div>

                      <div className="bg-background/40 rounded-lg p-2.5 col-span-1">
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Size</div>
                        <div className="text-xs font-semibold">
                          {r.contractCount ?? "—"} @ {(() => {
                            const ep = r.entryPrice != null ? parseFloat(r.entryPrice) : null;
                            if (ep == null) return r.betAmount ? fmt$(parseFloat(r.betAmount)) : "—";
                            const costPerContract = r.direction === "no" ? 1 - ep : ep;
                            return `${(costPerContract * 100).toFixed(0)}¢`;
                          })()}
                        </div>
                      </div>

                      <div className={`rounded-lg p-2.5 col-span-1 ${pnlNum == null ? "bg-background/40" : pnlNum > 0 ? "bg-emerald-500/10" : pnlNum < 0 ? "bg-red-500/10" : "bg-background/40"}`}>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">P&L</div>
                        <div className={`text-sm font-bold font-mono ${pnlNum == null ? "text-foreground" : pnlNum >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pnlNum != null ? (pnlNum >= 0 ? "+" : "") + fmt$(pnlNum) : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Footer row */}
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                      {!isOpen && r.exitedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {fmtDuration(r.createdAt, r.exitedAt)}
                        </span>
                      )}
                      <span className="font-mono">{wkToEst(r.windowKey)} EST</span>
                      {(() => {
                        const conf = sigs?.confidence as number | null ?? sigs?.statConfidence as number | null ?? null;
                        return conf != null ? (
                          <span className={`font-semibold ${conf >= 60 ? "text-emerald-400" : conf >= 52 ? "text-amber-400" : "text-muted-foreground"}`}>
                            {Math.round(conf)}% conf
                          </span>
                        ) : null;
                      })()}
                      {r.exitReason && (
                        <span className="truncate max-w-[220px]" title={r.exitReason}>
                          · {r.exitReason.replace(/_/g, " ")}
                        </span>
                      )}
                      {r.phase2Activated && (
                        <span className="text-amber-400 font-medium">· Phase 2</span>
                      )}
                      {isPendingEval && (
                        <span className="text-amber-400/70">· awaiting window close price</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {totalHistPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-2 border-t border-border mt-1">
                  <button
                    onClick={() => setHistPage(p => Math.max(0, p - 1))}
                    disabled={clampedHistPage === 0}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page {clampedHistPage + 1} of {totalHistPages}
                  </span>
                  <button
                    onClick={() => setHistPage(p => Math.min(totalHistPages - 1, p + 1))}
                    disabled={clampedHistPage === totalHistPages - 1}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>


    </>
  );
}
