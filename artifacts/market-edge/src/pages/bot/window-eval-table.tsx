import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import type { WindowEval, OpenPosition } from "./types";
import { wkToEst } from "./utils";
import { CountdownCell } from "./countdown-cell";

interface WindowEvalTableProps {
  evaluation: WindowEval[];
  openPosList: OpenPosition[];
  openManualOrder: (sym: string) => void;
}

export function WindowEvalTable({ evaluation, openPosList, openManualOrder }: WindowEvalTableProps) {
  return (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-sm">Market Selection — This Window</h2>
            {evaluation.length > 0 && (
              <span className="text-xs text-muted-foreground ml-auto">
                {wkToEst(evaluation[0]?.windowKey)} EST window
              </span>
            )}
          </div>
          {evaluation.length === 0 ? (
            <div className="px-5 py-8 text-center text-muted-foreground text-sm">
              Waiting for next bot tick (every 30s)…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                    <th className="px-5 py-2">Coin</th>
                    <th className="px-3 py-2">Decision</th>
                    <th className="px-3 py-2">Confidence</th>
                    <th className="px-3 py-2">Score</th>
                    <th className="px-3 py-2">Trend</th>
                    <th className="px-3 py-2">Regime</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">Selected</th>
                    <th className="px-3 py-2">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluation.map((e) => (
                    <tr key={e.symbol} className={`border-b border-border/50 ${e.selected ? "bg-amber-500/5" : ""}`}>
                      <td className="px-5 py-2.5 font-bold">{e.symbol}</td>
                      <td className="px-3 py-2.5">
                        {e.betPlacedThisWindow && e.placedBetDirection ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            e.placedBetDirection === "yes" ? "bg-emerald-500/15 text-emerald-400" :
                            "bg-red-500/15 text-red-400"
                          }`}>
                            {e.placedBetDirection.toUpperCase()}
                          </span>
                        ) : (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            e.action === "BET_YES" ? "bg-emerald-500/15 text-emerald-400" :
                            e.action === "BET_NO" ? "bg-red-500/15 text-red-400" :
                            "bg-muted text-muted-foreground"
                          }`}>
                            {e.action.replace("BET_", "")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.betPlacedThisWindow && e.placedBetConfidence != null ? (
                          <span className="font-mono">{e.placedBetConfidence.toFixed(0)}%</span>
                        ) : e.action !== "SKIP" ? (
                          <span className="font-mono">{e.confidence.toFixed(0)}%</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.action !== "SKIP" ? <span className="font-mono">{e.score.toFixed(2)}</span> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.trendStability ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            e.trendStability === "clean" ? "bg-emerald-500/15 text-emerald-400" :
                            e.trendStability === "reversing" ? "bg-red-500/15 text-red-400" :
                            "bg-amber-500/15 text-amber-400"
                          }`}>
                            {e.trendStability}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {e.regime ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            e.regime === "trending_up" ? "bg-sky-500/15 text-sky-400" :
                            e.regime === "trending_down" ? "bg-orange-500/15 text-orange-400" :
                            "bg-zinc-500/15 text-zinc-400"
                          }`}>
                            {e.regime === "trending_up" ? "↑ trending" :
                             e.regime === "trending_down" ? "↓ trending" :
                             "↔ ranging"}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5 min-w-[240px] max-w-[320px]"><CountdownCell reason={e.reason} windowKey={e.windowKey} /></td>
                      <td className="px-3 py-2.5">
                        {e.betPlacedThisWindow ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                            BET PLACED
                          </span>
                        ) : e.selected ? (
                          <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        {openPosList.some(p => p.symbol === e.symbol) ? (
                          <span
                            title={`Position already open for ${e.symbol}`}
                            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border border-muted/40 text-muted-foreground cursor-not-allowed whitespace-nowrap opacity-60"
                          >
                            <ShoppingCart className="w-3 h-3" />
                            Open
                          </span>
                        ) : (
                          <button
                            onClick={() => openManualOrder(e.symbol)}
                            title={`Place a manual order for ${e.symbol}`}
                            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border border-sky-500/40 text-sky-400 hover:bg-sky-500/15 hover:border-sky-400/60 transition-colors whitespace-nowrap"
                          >
                            <ShoppingCart className="w-3 h-3" />
                            Order
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>


  );
}
