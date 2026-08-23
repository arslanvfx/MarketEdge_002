import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save, Thermometer, Waves, Crosshair, Timer, Users, Link2 } from "lucide-react";
import React from "react";
import type { HistoryRecord } from "./types";
import { fmt$, fmtPct, fmtDateTime, fmtCrypto, fmtContracts, fmtDuration, wkToEst } from "./utils";

const HIST_PAGE_SIZE = 20;
const SCALPER_CARD_CLASS = "border-amber-400/40 bg-[linear-gradient(135deg,#0c0f12_0%,#171716_52%,#634515_100%)] text-amber-50 ring-1 ring-inset ring-amber-500/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_22px_rgba(245,158,11,0.16),0_14px_38px_rgba(0,0,0,0.35)]";
const REGULAR_CARD_CLASS = "border-sky-400/35 bg-[linear-gradient(135deg,#07111f_0%,#0a1d35_52%,#12385a_100%)] text-slate-50 ring-1 ring-inset ring-sky-500/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_0_22px_rgba(56,189,248,0.12),0_14px_38px_rgba(0,0,0,0.30)]";
const SCALPER_METRIC_CLASS = "border border-amber-400/30 bg-black/45";
const REGULAR_METRIC_CLASS = "border border-sky-400/25 bg-slate-950/45";

function layeredRegularPositionId(record: HistoryRecord): string | null {
  if (record.source !== "scalper") return null;
  const signals = record.signals as Record<string, unknown> | null;
  const id = signals?.layeredRegularPositionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

interface TransactionLogProps {
  pagedBets: HistoryRecord[];
  histPage: number;
  setHistPage: React.Dispatch<React.SetStateAction<number>>;
  totalHistPages: number;
  totalBets: number;
  historyMode: "paper" | "live";
  setHistoryMode: React.Dispatch<React.SetStateAction<"paper" | "live">>;
  histSourceFilter: "all" | "bot" | "manual" | "scalper" | "skips";
  setHistSourceFilter: React.Dispatch<React.SetStateAction<"all" | "bot" | "manual" | "scalper" | "skips">>;
  activeMode: "paper" | "live";
}

export function TransactionLog({ pagedBets, histPage, setHistPage, totalHistPages, totalBets, historyMode, setHistoryMode, histSourceFilter, setHistSourceFilter, activeMode }: TransactionLogProps) {
  const clampedHistPage = Math.min(histPage, Math.max(0, totalHistPages - 1));
  const regularRecordsById = React.useMemo(
    () => new Map(
      pagedBets
        .filter((record) => record.source !== "scalper")
        .map((record) => [record.id, record]),
    ),
    [pagedBets],
  );
  const regularIdsShownInLayeredCards = React.useMemo(
    () => new Set(
      pagedBets
        .map(layeredRegularPositionId)
        .filter((id): id is string => id != null && regularRecordsById.has(id)),
    ),
    [pagedBets, regularRecordsById],
  );
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
            {/* Source filter — All / Bot / Manual / Scalper / Skips */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-medium ml-1">
              {(["all", "bot", "manual", "scalper", "skips"] as const).map(s => (
                <button
                  key={s}
                  onClick={() => { setHistSourceFilter(s); setHistPage(0); }}
                  className={`px-2.5 py-1 transition-colors capitalize ${
                    histSourceFilter === s
                      ? s === "manual"  ? "bg-purple-500/20 text-purple-300"
                      : s === "scalper" ? "bg-amber-500/20 text-amber-300"
                      : s === "skips"   ? "bg-orange-500/20 text-orange-300"
                      : "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                  }`}
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
              <p className="text-sm text-muted-foreground">
                {histSourceFilter === "skips"
                  ? "No gate skips recorded yet."
                  : "No bets placed yet. The bot is watching the markets."}
              </p>
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
                const isScalper = r.source === "scalper";
                 const linkedRegular = isScalper
                   ? regularRecordsById.get(layeredRegularPositionId(r) ?? "")
                   : null;
                 if (!isScalper && regularIdsShownInLayeredCards.has(r.id)) {
                   return null;
                 }
                 const isRegularMarketBet = !isScalper && !isShadow && !isSkip;
                const isEmergencyClose = r.exitReason === "conviction_catastrophic_fill";
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

                 const cardBg = isScalper
                   ? SCALPER_CARD_CLASS
                   : isRegularMarketBet
                     ? REGULAR_CARD_CLASS
                   : isShadow
                   ? "border-violet-500/20 bg-violet-950/5"
                  : isSkip
                    ? "border-orange-500/20 bg-orange-950/5"
                    : isOpen
                      ? "border-sky-500/30 bg-sky-950/10"
                      : isEmergencyClose
                        ? "border-amber-500/40 bg-amber-950/15"
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
                       <span className={`text-base font-black tracking-tight ${isScalper ? "text-amber-50" : isRegularMarketBet ? "text-slate-50" : "text-foreground"}`}>{r.symbol}</span>

                      {r.direction && (
                        <span className={`flex items-center gap-0.5 text-xs font-bold px-2 py-0.5 rounded-full ${isScalper ? "border border-amber-400/35 bg-amber-500/15 text-amber-100" : r.direction === "yes" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
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
                            "pipeline-not-ready":         { label: "Pipeline pending",    icon: <Timer className="w-3 h-3" />,       detail: "Window signal pipeline not yet complete" },
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
                      ) : isEmergencyClose ? (
                        <>
                          <span
                            className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/25 text-amber-300"
                            title="Fill price deviated catastrophically from the conviction zone — position was unwound immediately"
                          >
                            <AlertTriangle className="w-3 h-3 shrink-0" /> Emergency Close
                          </span>
                          {isWin ? (
                            <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                              <Trophy className="w-3 h-3" /> WIN
                            </span>
                          ) : isLoss ? (
                            <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">
                              <XCircle className="w-3 h-3" /> LOSS
                            </span>
                          ) : null}
                        </>
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

                       <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isScalper ? "bg-gradient-to-br from-yellow-200 to-amber-500 text-[#2b1b0d] shadow-[0_0_10px_rgba(245,158,11,0.3)]" : r.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-500"}`}>
                        {r.mode?.toUpperCase()}
                      </span>

                      {/* Manual badge — shown when the bet was placed via the dashboard button */}
                      {(r.source === "manual" || (r.signals as Record<string, unknown> | null)?.manual === true) && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                          MANUAL
                        </span>
                      )}
                      {isScalper && (
                        <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/30 text-amber-100 border border-amber-300/35">
                          <Zap className="w-2.5 h-2.5" /> SCALPER
                        </span>
                      )}
                       {isRegularMarketBet && (
                         <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border border-sky-300/30 bg-sky-400/10 text-sky-100">
                           <Bot className="w-2.5 h-2.5" /> REGULAR
                         </span>
                       )}

                      {/* Decision mode badge */}
                      {!isScalper && (() => {
                        const dm = r.decisionMode ?? "classic";
                        const meta: Record<string, { label: string; cls: string }> = {
                          classic:          { label: "Classic",      cls: "bg-sky-500/10 text-sky-400/80" },
                          ml_gate:          { label: "ML Gate",      cls: "bg-violet-500/10 text-violet-400/80" },
                          consensus:        { label: "Consensus",    cls: "bg-amber-500/10 text-amber-400/80" },
                          unanimous:        { label: "Unanimous",    cls: "bg-emerald-500/10 text-emerald-400/80" },

                          conviction:       { label: "Conviction",   cls: "bg-yellow-500/20 text-yellow-300 font-bold" },
                        };
                        const { label, cls } = meta[dm] ?? { label: dm, cls: "bg-muted/30 text-muted-foreground" };
                        const convictionYesPrice = dm === "conviction"
                          ? (sigs?.yesPrice as number | null ?? null)
                          : null;
                        return (
                          <span className={`flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded ${cls}`}>
                            {dm === "conviction" && <Zap className="w-2.5 h-2.5 shrink-0" />}
                            {label}
                            {convictionYesPrice != null && (
                              <span className="opacity-80 ml-0.5">· YES {Math.round(convictionYesPrice * 100)}¢</span>
                            )}
                          </span>
                        );
                      })()}

                      <span className="ml-auto text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                    </div>

                    {/* Key metrics grid */}
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
                        <div className={`rounded-lg p-2.5 col-span-1 ${isScalper ? SCALPER_METRIC_CLASS : isRegularMarketBet ? REGULAR_METRIC_CLASS : "bg-background/40"}`}>
                          <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-300/90" : isRegularMarketBet ? "text-sky-200/80" : "text-muted-foreground"}`}>{isScalper && <ShoppingCart className="h-3 w-3 text-amber-300" />}{isRegularMarketBet && <Target className="h-3 w-3 text-sky-300" />}{isScalper ? "Order" : "Strike"}</div>
                          <div className={`text-xs font-semibold font-mono ${isScalper ? "text-amber-50" : isRegularMarketBet ? "text-slate-100" : ""}`}>{isScalper ? r.ticker ?? "—" : fmtCrypto(r.kalshiTarget)}</div>
                      </div>

                        <div className={`rounded-lg p-2.5 col-span-1 ${isScalper ? SCALPER_METRIC_CLASS : isRegularMarketBet ? REGULAR_METRIC_CLASS : "bg-background/40"}`}>
                          <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-300/90" : isRegularMarketBet ? "text-sky-200/80" : "text-muted-foreground"}`}>
                           {isScalper && <CheckCircle2 className="h-3 w-3 text-amber-300" />}{isRegularMarketBet && <CheckCircle2 className="h-3 w-3 text-sky-300" />}{isScalper ? "Settlement" : closePx != null ? "Close Price" : isOpen ? "Entry Price" : "End Price"}
                        </div>
                        <div className="text-xs font-semibold font-mono flex items-center gap-1">
                          {isScalper ? (
                            <span className={isOpen ? "text-amber-50" : isWin ? "text-emerald-400" : "text-red-400"}>
                              {isOpen ? "Pending" : isWin ? "Won" : "Lost"}
                            </span>
                          ) : endPx != null ? (
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

                        <div className={`rounded-lg p-2.5 col-span-1 ${isScalper ? SCALPER_METRIC_CLASS : isRegularMarketBet ? REGULAR_METRIC_CLASS : "bg-background/40"}`}>
                          <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-300/90" : isRegularMarketBet ? "text-sky-200/80" : "text-muted-foreground"}`}>{isScalper ? <ArrowUp className="h-3 w-3 text-amber-300" /> : isRegularMarketBet ? <ArrowUp className="h-3 w-3 text-sky-300" /> : null}Entry</div>
                        <div className="text-xs font-mono">
                          {ep != null ? (
                            <span>{(ep * 100).toFixed(0)}¢ YES · {((1 - ep) * 100).toFixed(0)}¢ NO</span>
                          ) : "—"}
                        </div>
                      </div>

                        <div className={`rounded-lg p-2.5 col-span-1 ${isScalper ? SCALPER_METRIC_CLASS : isRegularMarketBet ? REGULAR_METRIC_CLASS : "bg-background/40"}`}>
                          <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-300/90" : isRegularMarketBet ? "text-sky-200/80" : "text-muted-foreground"}`}>{isScalper ? <Trophy className="h-3 w-3 text-amber-300" /> : isRegularMarketBet ? <Trophy className="h-3 w-3 text-sky-300" /> : null}{isScalper ? "Result" : "Exit"}</div>
                        <div className="text-xs font-mono">
                          {isScalper
                             ? (sigs?.settlementResult as string | null ?? (isOpen ? <span className="text-amber-50 text-[9px]">in play…</span> : "—"))
                            : xp != null
                              ? `${(xp * 100).toFixed(0)}¢ YES`
                              : isOpen
                                ? <span className="text-sky-400 text-[9px]">in play…</span>
                                : "—"}
                        </div>
                      </div>

                        <div className={`rounded-lg p-2.5 col-span-1 ${isScalper ? SCALPER_METRIC_CLASS : isRegularMarketBet ? REGULAR_METRIC_CLASS : "bg-background/40"}`}>
                          <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-300/90" : isRegularMarketBet ? "text-sky-200/80" : "text-muted-foreground"}`}>{isScalper ? <Users className="h-3 w-3 text-amber-300" /> : isRegularMarketBet ? <Users className="h-3 w-3 text-sky-300" /> : null}Size</div>
                        <div className="text-xs font-semibold">
                          {fmtContracts(r.contractCount)} @ {(() => {
                            const ep = r.entryPrice != null ? parseFloat(r.entryPrice) : null;
                            if (ep == null) return r.betAmount ? fmt$(parseFloat(r.betAmount)) : "—";
                            const costPerContract = r.direction === "no" ? 1 - ep : ep;
                            return `${(costPerContract * 100).toFixed(0)}¢`;
                          })()}
                        </div>
                      </div>

                      <div className={`rounded-lg p-2.5 col-span-1 ${pnlNum == null ? "bg-background/40" : pnlNum > 0 ? "bg-emerald-500/10" : pnlNum < 0 ? "bg-red-500/10" : "bg-background/40"}`}>
                        <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-100" : "text-muted-foreground"}`}>{isScalper && <BarChart3 className="h-3 w-3 text-amber-300" />}P&L</div>
                        <div className={`text-sm font-bold font-mono ${pnlNum == null ? "text-foreground" : pnlNum >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pnlNum != null ? (pnlNum >= 0 ? "+" : "") + fmt$(pnlNum) : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Footer row */}
                     <div className={`flex items-center gap-3 text-[11px] flex-wrap ${isScalper ? "text-amber-100/65" : isRegularMarketBet ? "text-sky-100/65" : "text-muted-foreground"}`}>
                      {!isOpen && r.exitedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {fmtDuration(r.createdAt, r.exitedAt)}
                        </span>
                      )}
                      <span className={isScalper ? "font-mono text-amber-100/70" : "font-mono"}>{wkToEst(r.windowKey)} EST</span>
                      {(() => {
                        const conf = sigs?.confidence as number | null ?? sigs?.statConfidence as number | null ?? null;
                        return conf != null ? (
                          <span className={`font-semibold ${conf >= 60 ? "text-emerald-400" : conf >= 52 ? "text-amber-400" : "text-muted-foreground"}`}>
                            {Math.round(conf)}% conf
                          </span>
                        ) : null;
                      })()}
                      {r.exitReason && !isEmergencyClose && (
                        <span className="truncate max-w-[220px]" title={r.exitReason}>
                          · {r.exitReason.replace(/_/g, " ")}
                        </span>
                      )}
                      {isEmergencyClose && ep != null && (() => {
                        const decisionYesPrice = sigs?.yesPrice as number | null ?? null;
                        const fillCost = r.direction === "no" ? 1 - ep : ep;
                        const expectedCost = decisionYesPrice != null
                          ? (r.direction === "no" ? 1 - decisionYesPrice : decisionYesPrice)
                          : null;
                        const deviationCents = expectedCost != null
                          ? Math.abs(expectedCost - fillCost) * 100
                          : null;
                        return (
                          <span
                            className="flex items-center gap-1 text-amber-400/80 font-medium"
                            title="Fill price deviated catastrophically from the conviction zone — position was unwound immediately"
                          >
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            Filled {Math.round(fillCost * 100)}¢
                            {expectedCost != null && (
                              <span className="text-muted-foreground font-normal">
                                vs zone ~{Math.round(expectedCost * 100)}¢
                                {deviationCents != null && ` (${deviationCents.toFixed(0)}¢ off)`}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                      {r.phase2Activated && (
                        <span className="text-amber-400 font-medium">· Phase 2</span>
                      )}
                      {isPendingEval && (
                        <span className="text-amber-400/70">· awaiting window close price</span>
                      )}
                      {isScalper && (
                        <span className="text-amber-100/80">
                          · confirmed fill{typeof sigs?.status === "string" ? ` · ${sigs.status}` : ""}
                          {sigs?.layeredRegularSide === "yes" || sigs?.layeredRegularSide === "no"
                            ? ` · layered on regular ${String(sigs.layeredRegularSide).toUpperCase()}`
                            : ""}
                        </span>
                      )}
                      {/* Strike-proximity gap — how far the crypto price was from the Kalshi strike when the bet was placed */}
                      {!isSkip && !isShadow && (() => {
                        const entryPx  = r.cryptoPriceAtEntry != null ? parseFloat(r.cryptoPriceAtEntry) : null;
                        const strikePx = r.kalshiTarget != null ? parseFloat(r.kalshiTarget) : null;
                        if (entryPx == null || strikePx == null || strikePx === 0) return null;
                        const gapPct     = Math.abs(entryPx - strikePx) / strikePx * 100;
                        const aboveStrike = entryPx >= strikePx;
                        const gapColor   = gapPct < 0.01  ? "text-red-400/70"
                                         : gapPct < 0.02  ? "text-orange-400/70"
                                         : gapPct < 0.05  ? "text-amber-400/70"
                                         : gapPct < 0.1   ? "text-sky-400/70"
                                         : gapPct < 0.5   ? "text-emerald-400/70"
                                         : "text-emerald-300/90";
                        const gapDisplay = gapPct < 0.1
                          ? gapPct.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
                          : gapPct.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
                        return (
                          <span
                            className={`flex items-center gap-1 font-mono ${gapColor}`}
                            title={`${fmtCrypto(entryPx)} was ${gapPct.toFixed(4)}% ${aboveStrike ? "above" : "below"} the ${fmtCrypto(strikePx)} strike at entry`}
                          >
                            <Crosshair className="w-3 h-3 shrink-0" />
                            {gapDisplay}% gap
                          </span>
                        );
                      })()}
                      {r.decisionMode === "conviction" && (() => {
                        const yp       = sigs?.yesPrice as number | null ?? null;
                        const agreeing = sigs?.signalsAgreeing as number | null ?? null;
                        const total    = sigs?.signalsTotal    as number | null ?? null;
                        const reasoning = sigs?.reasoning as string | null ?? null;
                        if (yp == null) return null;
                        // Always show the Kalshi YES price — it's the trigger threshold.
                        // For YES bets the payout return = 1/yp; for NO bets it's 1/(1-yp).
                        const sideCost = r.direction === "no" ? 1 - yp : yp;
                        const ret = sideCost > 0 ? (1 / sideCost).toFixed(2) : null;
                        return (
                          <span className="flex items-center gap-1 flex-wrap text-yellow-400/80 font-medium">
                            <Zap className="w-3 h-3 shrink-0" />
                            YES at {Math.round(yp * 100)}¢
                            {ret && <span className="text-muted-foreground font-normal">· {ret}× {r.direction === "no" ? "NO" : "YES"} return</span>}
                            {agreeing != null && total != null && total > 0 && (
                              <span className="text-muted-foreground font-normal">· {agreeing}/{total} models agree</span>
                            )}
                            {reasoning && (
                              <span className="text-muted-foreground/70 font-normal text-[10px] w-full mt-0.5 truncate" title={reasoning}>
                                {reasoning}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                     </div>

                     {isScalper && linkedRegular && (() => {
                       const regularSignals = linkedRegular.signals as Record<string, unknown> | null;
                       const regularEntry = linkedRegular.entryPrice != null ? parseFloat(linkedRegular.entryPrice) : null;
                       const regularPnl = linkedRegular.pnl != null ? parseFloat(linkedRegular.pnl) : null;
                       const regularConfidence = regularSignals?.confidence as number | null
                         ?? regularSignals?.statConfidence as number | null
                         ?? null;
                       return (
                         <div
                           data-testid={`history-layered-bet-${r.id}`}
                           className="mt-4 rounded-xl border border-sky-400/40 bg-[linear-gradient(135deg,rgba(7,17,31,0.92),rgba(10,29,53,0.92),rgba(18,56,90,0.88))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                         >
                           <div className="mb-3 flex items-center gap-2 text-sky-100">
                             <span className="flex h-6 w-6 items-center justify-center rounded-md border border-sky-300/30 bg-sky-400/10">
                               <Link2 className="h-3.5 w-3.5 text-sky-300" />
                             </span>
                             <div>
                               <div className="text-[10px] font-black uppercase tracking-[0.16em] text-sky-200">Layered regular bet</div>
                               <div className="text-[11px] text-sky-100/65">Same market · linked before this Scalper fill</div>
                             </div>
                             <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold ${
                               linkedRegular.direction === "yes"
                                 ? "bg-emerald-400/15 text-emerald-200"
                                 : "bg-rose-400/15 text-rose-200"
                             }`}>
                               {linkedRegular.direction === "yes" ? "↑ ABOVE" : "↓ BELOW"}
                             </span>
                           </div>
                           <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                             <div className="rounded-lg border border-sky-400/20 bg-slate-950/45 p-2">
                               <div className="text-[9px] uppercase tracking-wide text-sky-200/75">Strike</div>
                               <div className="mt-0.5 font-mono text-xs font-semibold text-slate-100">{fmtCrypto(linkedRegular.kalshiTarget)}</div>
                             </div>
                             <div className="rounded-lg border border-sky-400/20 bg-slate-950/45 p-2">
                               <div className="text-[9px] uppercase tracking-wide text-sky-200/75">Entry</div>
                               <div className="mt-0.5 font-mono text-xs text-slate-100">{regularEntry == null ? "—" : `${Math.round(regularEntry * 100)}¢ YES · ${Math.round((1 - regularEntry) * 100)}¢ NO`}</div>
                             </div>
                             <div className="rounded-lg border border-sky-400/20 bg-slate-950/45 p-2">
                               <div className="text-[9px] uppercase tracking-wide text-sky-200/75">Size</div>
                               <div className="mt-0.5 text-xs font-semibold text-slate-100">{fmtContracts(linkedRegular.contractCount)}</div>
                             </div>
                             <div className={`rounded-lg border p-2 ${regularPnl == null ? "border-sky-400/20 bg-slate-950/45" : regularPnl >= 0 ? "border-emerald-400/25 bg-emerald-500/10" : "border-red-400/25 bg-red-500/10"}`}>
                               <div className="text-[9px] uppercase tracking-wide text-sky-200/75">Regular P&amp;L</div>
                               <div className={`mt-0.5 font-mono text-xs font-bold ${regularPnl == null ? "text-slate-100" : regularPnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>{regularPnl == null ? "—" : `${regularPnl >= 0 ? "+" : ""}${fmt$(regularPnl)}`}</div>
                             </div>
                           </div>
                           <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-sky-100/60">
                             <span>{wkToEst(linkedRegular.windowKey)} EST</span>
                             {regularConfidence != null && <span>{Math.round(regularConfidence)}% confidence</span>}
                             {linkedRegular.decisionMode && <span>{linkedRegular.decisionMode.replace(/_/g, " ")}</span>}
                           </div>
                         </div>
                       );
                     })()}
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
