import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import React from "react";
import type { BotStatus } from "./types";
import { fmtPct } from "./utils";

interface ManualOrderModalProps {
  manualOrderSym: string | null;
  setManualOrderSym: React.Dispatch<React.SetStateAction<string | null>>;
  manualDir: "yes" | "no";
  setManualDir: React.Dispatch<React.SetStateAction<"yes" | "no">>;
  manualBetSize: string;
  setManualBetSize: React.Dispatch<React.SetStateAction<string>>;
  manualSubmitting: boolean;
  submitManualOrder: () => Promise<void>;
  manualOrderKalshiData: { target: number | null; ticker: string | null; yesPrice: number | null; yesAsk: number | null; yesBid: number | null } | undefined;
  status: BotStatus | undefined;
  activeMode: "paper" | "live";
}

export function ManualOrderModal({ manualOrderSym, setManualOrderSym, manualDir, setManualDir, manualBetSize, setManualBetSize, manualSubmitting, submitManualOrder, manualOrderKalshiData, status, activeMode }: ManualOrderModalProps) {
  if (!manualOrderSym) return null;
  const openPosList = status?.openPositions ?? [];
  const ask = manualOrderKalshiData?.yesAsk ?? null;
  const bid = manualOrderKalshiData?.yesBid ?? null;
  const mid = manualOrderKalshiData?.yesPrice ?? null;
  const yesAskC = ask != null ? (ask * 100).toFixed(0) : mid != null ? (mid * 100).toFixed(0) : "—";
  const noAskC  = bid != null ? ((1 - bid) * 100).toFixed(0) : mid != null ? ((1 - mid) * 100).toFixed(0) : "—";
  const betSizeNum = parseFloat(manualBetSize);
  const costPerContract = manualDir === "yes"
    ? (ask ?? mid ?? 0.5)
    : (bid != null ? 1 - bid : mid != null ? 1 - mid : 0.5);
  const contracts = (!isNaN(betSizeNum) && betSizeNum > 0 && costPerContract > 0)
    ? Math.floor(betSizeNum / costPerContract)
    : 0;
  const payout = contracts > 0 && costPerContract > 0
    ? (manualDir === "yes"
      ? contracts * (1 - (ask ?? mid ?? 0.5))
      : contracts * (bid ?? mid ?? 0.5))
    : 0;
  return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setManualOrderSym(null)}>
            <div
              className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-5"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingCart className="w-4 h-4 text-sky-400" />
                  <h3 className="font-bold text-base">Place Order — {manualOrderSym}</h3>
                </div>
                <button onClick={() => setManualOrderSym(null)} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Live prices */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">YES ask</div>
                  <div className="text-lg font-bold text-emerald-400 font-mono">{yesAskC}¢</div>
                </div>
                <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">NO ask</div>
                  <div className="text-lg font-bold text-red-400 font-mono">{noAskC}¢</div>
                </div>
              </div>

              {/* Direction toggle */}
              <div className="flex gap-2">
                <button
                  onClick={() => setManualDir("yes")}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    manualDir === "yes"
                      ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-400"
                      : "bg-background border-border text-muted-foreground hover:border-emerald-500/30"
                  }`}
                >
                  YES
                </button>
                <button
                  onClick={() => setManualDir("no")}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    manualDir === "no"
                      ? "bg-red-500/20 border-red-500/60 text-red-400"
                      : "bg-background border-border text-muted-foreground hover:border-red-500/30"
                  }`}
                >
                  NO
                </button>
              </div>

              {/* Bet size */}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Bet Size ($)</span>
                <input
                  type="number"
                  min={0.5}
                  max={status?.config?.maxBetSize ?? 25}
                  step={0.5}
                  value={manualBetSize}
                  onChange={e => setManualBetSize(e.target.value)}
                  className="bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-sky-500/60"
                />
              </label>

              {/* Preview */}
              <div className="rounded-xl bg-muted/30 border border-border p-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contracts</span>
                  <span className="font-mono font-bold">{contracts > 0 ? contracts : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cost/contract</span>
                  <span className="font-mono">{costPerContract > 0 ? `${(costPerContract * 100).toFixed(0)}¢` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Projected win</span>
                  <span className={`font-mono font-bold ${payout > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {payout > 0 ? `$${payout.toFixed(2)}` : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mode</span>
                  <span className={`font-bold ${activeMode === "live" ? "text-red-400" : "text-yellow-400"}`}>
                    {activeMode.toUpperCase()}
                  </span>
                </div>
              </div>

              {contracts < 1 && !isNaN(betSizeNum) && betSizeNum > 0 && (
                <p className="text-xs text-amber-400">Budget too small — increase bet size or wait for prices to change.</p>
              )}

              {openPosList.some(p => p.symbol === manualOrderSym) && (
                <p className="text-xs text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                  A position is already open for {manualOrderSym}. Close it before placing a new order.
                </p>
              )}

              <button
                onClick={submitManualOrder}
                disabled={manualSubmitting || contracts < 1 || openPosList.some(p => p.symbol === manualOrderSym)}
                className={`w-full py-2.5 rounded-xl font-bold text-sm transition-colors ${
                  manualSubmitting || contracts < 1 || openPosList.some(p => p.symbol === manualOrderSym)
                    ? "bg-muted text-muted-foreground cursor-not-allowed"
                    : manualDir === "yes"
                    ? "bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30"
                    : "bg-red-500/20 border border-red-500/50 text-red-300 hover:bg-red-500/30"
                }`}
              >
                {manualSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Placing…
                  </span>
                ) : openPosList.some(p => p.symbol === manualOrderSym) ? (
                  "Position already open"
                ) : (
                  `Confirm ${manualDir.toUpperCase()} Order`
                )}
              </button>
            </div>
          </div>
        );
}
