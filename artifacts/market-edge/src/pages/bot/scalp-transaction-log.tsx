import React, { useState } from "react";
import { Clock, Shield, Target, Activity, AlertTriangle, Trophy, XCircle, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { fmt$, fmtPct, fmtDateTime, fmtCrypto, fmtDuration, wkToEst } from "./utils";
import type { ScalpOrder, HistoryRecord } from "./types";
import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "./utils";

const HIST_PAGE_SIZE = 20;

interface ScalpTransactionLogProps {
  activeMode: "paper" | "live";
  historyMode: "paper" | "live";
  regularHistory: HistoryRecord[];
}

export function ScalpTransactionLog({ activeMode, historyMode, regularHistory }: ScalpTransactionLogProps) {
  const [histPage, setHistPage] = useState(0);

  const { data } = useQuery<{ orders: ScalpOrder[] }>({
    queryKey: ["bot-scalper-history", historyMode],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/history?mode=${historyMode}&limit=500`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  const records = data?.orders ?? [];
  const totalRecords = records.length;
  const totalHistPages = Math.max(1, Math.ceil(totalRecords / HIST_PAGE_SIZE));
  const clampedHistPage = Math.min(histPage, totalHistPages - 1);
  const pagedRecords = records.slice(clampedHistPage * HIST_PAGE_SIZE, (clampedHistPage + 1) * HIST_PAGE_SIZE);

  if (totalRecords === 0) return null;

  return (
    <div className="bg-card border border-amber-500/30 rounded-xl overflow-hidden mt-6 mb-6">
      <div className="px-5 py-3 border-b border-amber-500/30 bg-amber-500/5 flex items-center gap-2 flex-wrap">
        <Zap className="w-4 h-4 text-amber-500/80" />
        <h2 className="font-semibold text-sm text-amber-500/90 tracking-widest uppercase">Scalp History</h2>
        
        <span className="text-xs text-muted-foreground ml-2">{totalRecords} record{totalRecords !== 1 ? "s" : ""}</span>
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

      <div className="p-4 space-y-3">
        {pagedRecords.map((r) => {
          const linkedRegBet = regularHistory.find(h => h.symbol === r.symbol && h.windowKey === r.windowKey);
          
          const isWin = r.outcome === "win";
          const isLoss = r.outcome === "loss";
          const isOpen = r.outcome === "open";
          const entryCost = r.side === "yes" ? r.avgFillPrice : (r.avgFillPrice !== null ? 1 - r.avgFillPrice : null);
          
          const cardBg = "border-border bg-card/60";

          return (
            <div key={r.id} className={`border rounded-xl p-0 transition-colors ${cardBg} overflow-hidden`}>
              <div className="p-4">
                {/* Header */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-base font-black tracking-tight text-foreground">{r.symbol}</span>
                  
                  {r.side && (
                    <span className={`flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full ${r.side === "yes" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                      {r.side === "yes" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                      {r.side === "yes" ? "ABOVE" : "BELOW"}
                    </span>
                  )}
                  
                  <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    <Zap className="w-2.5 h-2.5" /> HIGH-VALUE SCALP
                  </span>
                  
                  {isWin ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                      <Trophy className="w-3 h-3" /> WIN
                    </span>
                  ) : isLoss ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300">
                      <XCircle className="w-3 h-3" /> LOSS
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 animate-pulse">
                      <Activity className="w-3 h-3" /> ACTIVE
                    </span>
                  )}
                  
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-500"}`}>
                    {r.mode?.toUpperCase()}
                  </span>
                  
                  {r.incidentId && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> INCIDENT
                    </span>
                  )}
                  
                  <span className="ml-auto text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  <div className="bg-background/40 rounded-lg p-2.5">
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Strike</div>
                    <div className="text-xs font-semibold font-mono">{r.ticker ? fmtCrypto(parseFloat(r.ticker)) : "—"}</div>
                  </div>
                  <div className="bg-background/40 rounded-lg p-2.5">
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">End Price</div>
                    <div className="text-xs font-semibold font-mono">—</div>
                  </div>
                  <div className="bg-background/40 rounded-lg p-2.5">
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">Exit</div>
                    <div className="text-xs font-semibold font-mono">—</div>
                  </div>
                  <div className={`rounded-lg p-2.5 ${r.pnl == null ? "bg-background/40" : r.pnl > 0 ? "bg-emerald-500/10" : r.pnl < 0 ? "bg-red-500/10" : "bg-background/40"}`}>
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">P&L</div>
                    <div className={`text-sm font-bold font-mono ${r.pnl == null ? "text-foreground" : r.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {r.pnl != null ? (r.pnl >= 0 ? "+" : "") + fmt$(r.pnl) : "—"}
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Original Bet Context */}
                {linkedRegBet && (
                  <div className="border-t border-border/50 bg-background/30 p-4 pb-3 flex flex-col gap-2">
                    <div className="text-[9px] font-bold text-sky-500/70 tracking-widest uppercase flex items-center gap-1.5">
                      <Shield className="w-3 h-3" /> Original Conviction Bet
                    </div>
                    <div className="flex items-center gap-6 flex-wrap text-xs text-muted-foreground">
                      <div>
                        Entry: <span className="font-mono text-foreground font-medium">
                          {linkedRegBet.entryPrice ? `${(parseFloat(linkedRegBet.entryPrice) * 100).toFixed(0)}¢ YES · ${((1 - parseFloat(linkedRegBet.entryPrice)) * 100).toFixed(0)}¢ NO` : "—"}
                        </span>
                      </div>
                      <div>
                        Size: <span className="font-semibold text-foreground">
                          {linkedRegBet.contractCount ?? "—"} @ {(() => {
                            const ep = linkedRegBet.entryPrice != null ? parseFloat(linkedRegBet.entryPrice) : null;
                            if (ep == null) return "—";
                            const costPerContract = linkedRegBet.direction === "no" ? 1 - ep : ep;
                            return `${(costPerContract * 100).toFixed(0)}¢`;
                          })()}
                        </span>
                      </div>
                      <div>
                        Placed: <span className="font-medium text-foreground">{fmtDateTime(linkedRegBet.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Scalp Layer */}
                <div className="border-t border-amber-500/30 bg-amber-500/5 p-4 flex flex-col gap-3">
                  <div className="text-[9px] font-bold text-amber-500/80 tracking-widest uppercase flex items-center gap-1.5">
                    <Zap className="w-3 h-3" /> Scalp Layer Added
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-4 text-xs text-muted-foreground">
                    <div>
                      <div className="text-[9px] uppercase tracking-wide text-amber-500/60 mb-0.5">Side</div>
                      <div className="font-bold text-amber-400">
                        {r.side === "yes" ? "YES" : "NO"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wide text-amber-500/60 mb-0.5">Entry</div>
                      <div className="font-mono text-amber-100">
                        {entryCost !== null ? `${Math.round(entryCost * 100)}¢` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wide text-amber-500/60 mb-0.5">Contracts</div>
                      <div className="font-semibold text-amber-100">
                        {r.filledCount}
                      </div>
                      <div className="text-[9px] text-amber-500/50 mt-0.5">{fmt$(r.budgetSpent)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wide text-amber-500/60 mb-0.5">Added at</div>
                      <div className="font-medium text-amber-100">{fmtDateTime(r.createdAt)}</div>
                    </div>
                  </div>
                </div>
              
              {/* Footer row */}
              <div className="bg-background/80 border-t border-border/30 px-4 py-2 flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                {!isOpen && r.settledAt && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {fmtDuration(r.createdAt, r.settledAt)}
                  </span>
                )}
                <span className="font-mono">{wkToEst(r.windowKey)} EST</span>
                {r.status && <span className="truncate max-w-[220px]">· {r.status}</span>}
                <span className="text-amber-500/60 font-medium">· Scalp placed at {fmtDateTime(r.createdAt)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
