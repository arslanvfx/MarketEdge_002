import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import type { OpenPosition } from "./types";
import { fmt$, fmtPct, fmtCrypto, wkToEst, GUARD_LABELS } from "./utils";

interface ActivePositionsProps {
  openPosList: OpenPosition[];
  closeManualError: string | null;
  closingManualSym: string | null;
  closeManualPos: (symbol: string) => void;
  openManualOrder: (sym: string) => void;
}

export function ActivePositions({ openPosList, closeManualError, closingManualSym, closeManualPos, openManualOrder }: ActivePositionsProps) {
  if (openPosList.length === 0) return null;
  const scalperCardClass = "border-yellow-200/90 bg-gradient-to-br from-yellow-300 via-amber-300 to-orange-400 text-amber-950 shadow-[inset_0_1px_0_rgba(255,251,235,0.55),0_12px_34px_rgba(245,158,11,0.24)]";
  return (
          <div className="space-y-3">
            {openPosList.length > 1 && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-sm font-semibold text-foreground">Active Positions</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-mono">{openPosList.length}</span>
              </div>
            )}
            {closeManualError && (
              <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">
                <XCircle className="w-4 h-4 flex-shrink-0" />
                <span>{closeManualError}</span>
              </div>
            )}
            {openPosList.map((pos) => {
              const isManual = pos.source === "manual" || pos.id.startsWith("manual:");
              const isScalper = pos.source === "scalper";
              const isClosing = closingManualSym === pos.symbol;
              const winningContractCost = pos.direction === "yes"
                ? pos.entryYesPrice
                : 1 - pos.entryYesPrice;
              return (
              <div key={pos.id} className={`border rounded-xl p-5 ${
                isScalper
                   ? scalperCardClass
                  : pos.direction === "yes"
                    ? "border-emerald-500/40 bg-emerald-950/20"
                    : "border-red-500/40 bg-red-950/20"
              }`}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3 flex-wrap">
                     <div className={`text-2xl font-black ${isScalper ? "text-amber-950" : pos.direction === "yes" ? "text-emerald-400" : "text-red-400"}`}>
                      {pos.symbol}
                    </div>
                     <span className={`text-sm font-bold px-3 py-1 rounded-full ${isScalper ? "bg-amber-950/15 text-amber-950" : pos.direction === "yes" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                      {pos.direction === "yes" ? "▲ YES" : "▼ NO"}
                    </span>
                    {isManual && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30 tracking-wide">
                        MANUAL
                      </span>
                    )}
                    {isScalper && (
                       <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-950/15 text-amber-950 border border-amber-950/25 tracking-wide">
                        SCALPER
                      </span>
                    )}
                    {isScalper && pos.mode && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        pos.mode === "live"
                          ? "bg-red-500/15 text-red-400"
                           : "bg-amber-950/15 text-amber-950"
                      }`}>
                        {pos.mode.toUpperCase()}
                      </span>
                    )}
                     <span className={`text-xs ${isScalper ? "text-amber-950/65" : "text-muted-foreground"}`}>
                      Opened {new Date(pos.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">{isScalper ? "Settlement" : "Unrealized P&L"}</div>
                      {isScalper ? (
                         <div className="text-sm font-bold text-amber-950">Pending</div>
                      ) : (
                        <div className={`text-lg font-bold ${(pos.unrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {fmt$(pos.unrealizedPnl)}
                        </div>
                      )}
                    </div>
                    {isManual && (
                      <button
                        onClick={() => closeManualPos(pos.symbol)}
                        disabled={isClosing}
                        className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="Close this manual position now"
                      >
                        {isClosing ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <X className="w-3 h-3" />
                        )}
                        {isClosing ? "Closing…" : "Close"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 text-sm mb-4">
                   {(isScalper ? [
                    { label: `${pos.direction.toUpperCase()} Fill`, value: fmtPct(winningContractCost) },
                    { label: "YES Fill", value: fmtPct(pos.entryYesPrice) },
                    { label: "NO Fill", value: fmtPct(1 - pos.entryYesPrice) },
                    { label: "Contracts Filled", value: String(pos.contractCount) },
                    { label: "Spend", value: fmt$(pos.betAmount) },
                    { label: "Ticker", value: pos.ticker },
                    { label: "Window", value: wkToEst(pos.windowKey) + " EST" },
                  ] : [
                    { label: "Strike Price", value: fmtCrypto(pos.kalshiTarget) },
                    { label: "Crypto @ Entry", value: fmtCrypto(pos.cryptoPriceAtEntry) },
                    { label: "Entry Yes%", value: fmtPct(pos.entryYesPrice) },
                    { label: "Entry No%", value: fmtPct(1 - pos.entryYesPrice) },
                    { label: "Current Yes%", value: fmtPct(pos.currentYesPrice) },
                    { label: "Current No%", value: pos.currentYesPrice != null ? fmtPct(1 - pos.currentYesPrice) : "—" },
                    { label: "Contracts", value: String(pos.contractCount) },
                    { label: "Bet Size", value: fmt$(pos.betAmount) },
                    { label: "Ticker", value: pos.ticker },
                    { label: "Window", value: wkToEst(pos.windowKey) + " EST" },
                   ]).map(({ label, value }) => (
                     <div key={label} className={`rounded-lg p-2.5 ${isScalper ? "border border-amber-950/15 bg-black/15" : "bg-background/30"}`}>
                       <div className={`text-[10px] uppercase tracking-wide mb-0.5 ${isScalper ? "text-amber-950/65" : "text-muted-foreground"}`}>{label}</div>
                       <div className={`font-semibold text-sm ${isScalper ? "text-amber-950" : "text-foreground"}`}>{value}</div>
                    </div>
                  ))}
                </div>

                {pos.entrySignals && pos.decisionMode !== "conviction" && (
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <span className="text-xs text-muted-foreground self-center">Entry signals:</span>
                    {(["stat", "ml", "claude"] as const).map((key) => {
                      const val = pos.entrySignals![key === "stat" ? "statAbove" : key === "ml" ? "mlAbove" : "claudeAbove"];
                      const label = key === "stat" ? "Stat" : key === "ml" ? "ML" : "Claude";
                      if (val === null || val === undefined) {
                        return (
                          <span key={key} className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted/30 text-muted-foreground">
                            <Minus className="w-3 h-3" />
                            {label}
                          </span>
                        );
                      }
                      const isYesBet = pos.direction === "yes";
                      const agrees = isYesBet ? val === true : val === false;
                      return (
                        <span key={key} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full ${agrees ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                          {val ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                          {label} {val ? "UP" : "DN"}
                        </span>
                      );
                    })}
                    <span className="text-xs text-muted-foreground italic self-center">at entry</span>
                  </div>
                )}

                {pos.guardStates && (
                  <div className="flex flex-wrap gap-2">
                    <span className="text-xs text-muted-foreground self-center">Exit guards:</span>
                    {Object.entries(pos.guardStates).map(([key, val]) => (
                      <span key={key} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full ${val ? "bg-emerald-500/15 text-emerald-400" : "bg-muted/50 text-muted-foreground"}`}>
                        {val ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                        {GUARD_LABELS[key] ?? key}
                      </span>
                    ))}
                    {pos.guardReason && (
                      <span className="text-xs text-muted-foreground italic self-center">· {pos.guardReason}</span>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>

  );
}
