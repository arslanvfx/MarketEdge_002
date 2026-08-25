import { useState } from "react";
import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import type { CoinGuardState } from "./types";
import { fmt$ } from "./utils";

interface PerCoinGuardProps {
  coinGuardData: CoinGuardState | undefined;
}

export function PerCoinGuard({ coinGuardData }: PerCoinGuardProps) {
  const [open, setOpen] = useState(true);
  if (!coinGuardData) return null;
  return (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/20 transition-colors text-left"
            >
              <Shield className="w-4 h-4 text-sky-400" />
              <h2 className="font-semibold text-sm">Per-Coin Guard Status</h2>
              <span className="text-xs text-muted-foreground ml-auto">
                Daily cap: {fmt$(coinGuardData.maxDailyLossPerCoin)} / coin
              </span>
              {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
            </button>
            {open && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4">
              {coinGuardData.coins.map((coin) => {
                // Compute current window key with same formula as backend (YYYY-MM-DDTHH:mm UTC)
                const currentWK = new Date(Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000))
                  .toISOString().slice(0, 16);
                // Paused iff backend pause rule: currentWindowKey <= pauseUntilWindowKey (string compare)
                const isPaused = coin.pauseUntilWindowKey != null && currentWK <= coin.pauseUntilWindowKey;
                // windowsLeft: number of 15-min windows still paused (current window counts as 1)
                const windowsLeft = isPaused ? (() => {
                  const currentMs = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
                  const pauseMs = new Date(coin.pauseUntilWindowKey! + ":00Z").getTime();
                  return Math.max(1, Math.round((pauseMs - currentMs) / (15 * 60_000)) + 1);
                })() : 0;
                const lossPct = coinGuardData.maxDailyLossPerCoin > 0
                  ? Math.min(1, coin.dailyLoss / coinGuardData.maxDailyLossPerCoin)
                  : 0;
                const hasAnything = isPaused || coin.dailyLoss > 0 || coin.consecutiveLosses > 0 || coin.slippageStrikes > 0;
                return (
                  <div
                    key={coin.symbol}
                    className={`rounded-lg p-3 border ${isPaused ? "border-red-500/50 bg-red-950/20" : hasAnything ? "border-amber-500/30 bg-amber-950/10" : "border-border bg-background/30"}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm text-foreground">{coin.symbol}</span>
                      {isPaused ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 whitespace-nowrap">
                          Paused · {windowsLeft}w left
                        </span>
                      ) : (
                        <span className="text-[10px] text-emerald-500 font-medium">Active</span>
                      )}
                    </div>

                    {/* Daily loss bar */}
                    <div className="mb-2">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Daily loss</span>
                        <span className={coin.dailyLoss > 0 ? "text-red-400" : ""}>{fmt$(coin.dailyLoss)} / {fmt$(coinGuardData.maxDailyLossPerCoin)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${lossPct > 0.75 ? "bg-red-500" : lossPct > 0.4 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${(lossPct * 100).toFixed(1)}%` }}
                        />
                      </div>
                    </div>

                    {/* Badges row */}
                    <div className="flex flex-wrap gap-1">
                      {coin.consecutiveLosses > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                          {coin.consecutiveLosses} loss streak
                        </span>
                      )}
                      {coin.slippageStrikes > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">
                          {coin.slippageStrikes} slip {coin.slippageStrikes === 1 ? "strike" : "strikes"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>}
          </div>

  );
}
