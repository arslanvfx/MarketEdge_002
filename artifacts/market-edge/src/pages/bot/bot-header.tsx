import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BotStatus, BotConfig, AutoTuneLogEntry, OpenPosition } from "./types";
import { utcToEst, ET_LABEL } from "./utils";

interface BotHeaderProps {
  status: BotStatus | undefined;
  openPosList: OpenPosition[];
  statusLabel: string;
  cfg: BotConfig | undefined;
  merged: BotConfig;
  confirmLive: boolean;
  recentTuneEntry: AutoTuneLogEntry | null;
  kalshiBalanceData: { balance: number | null; ok: boolean; reason?: string } | undefined;
  pnl: number;
  togglePause: () => void;
  setConfirmLive: (v: boolean) => void;
  setMode: (mode: "paper" | "live") => Promise<void>;
}

export function BotHeader({ status, openPosList, statusLabel, cfg, merged, confirmLive, recentTuneEntry, kalshiBalanceData, pnl, togglePause, setConfirmLive, setMode }: BotHeaderProps) {
  return (
    <>
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Bot className="w-6 h-6 text-cyan-400" />
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground">Kalshi Bot Dashboard</h1>
            <p className="text-xs text-muted-foreground">Automated prediction market engine</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold px-2 py-1 rounded-full border ${status?.mode === "live" ? "border-red-500/50 bg-red-500/10 text-red-400" : "border-yellow-500/50 bg-yellow-500/10 text-yellow-400"}`}>
            {status?.mode?.toUpperCase() ?? "PAPER"}
          </span>
          <span className={`text-xs px-2 py-1 rounded-full ${status?.paused ? "bg-muted text-muted-foreground" : openPosList.length > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-sky-500/10 text-sky-400"}`}>
            {statusLabel()}
          </span>
          {(status?.circuitBreakerWindowsRemaining ?? 0) > 0 ? (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-500/30" title={`Circuit breaker active — ${status!.circuitBreakerWindowsRemaining} window(s) remaining`}>
              <AlertTriangle className="w-3 h-3" />
              CB: {status!.circuitBreakerWindowsRemaining} {status!.circuitBreakerWindowsRemaining === 1 ? "window" : "windows"}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground border border-border" title="Circuit breaker inactive">
              <AlertTriangle className="w-3 h-3" />
              CB off
            </span>
          )}
          {status?.isInQuietHours && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground border border-border" title={`Quiet hours active (${String(utcToEst(cfg?.quietHoursStart ?? 0)).padStart(2,"0")}:00–${String(utcToEst(cfg?.quietHoursEnd ?? 0)).padStart(2,"0")}:00 ${ET_LABEL}) — no new entries`}>
              <Clock className="w-3 h-3" />
              Quiet
            </span>
          )}
          {status?.dbDegraded && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 animate-pulse" title={`Database unreachable since ${status.dbDegradedSince ? new Date(status.dbDegradedSince).toLocaleTimeString() : "recently"} — new bets paused until connection restores`}>
              <AlertTriangle className="w-3 h-3" />
              DB offline
            </span>
          )}
          {recentTuneEntry && (() => {
            const ruleLabel =
              recentTuneEntry.ruleName === "confidence_floor_raise" ? "Confidence raised" :
              recentTuneEntry.ruleName === "per_coin_pause" ? "Coin paused" :
              recentTuneEntry.ruleName === "quiet_hours_expand" ? "Quiet hrs expanded" :
              recentTuneEntry.ruleName;
            const minutesAgo = Math.round((Date.now() - new Date(recentTuneEntry.createdAt).getTime()) / 60000);
            return (
              <span
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30 animate-pulse"
                title={`Auto-tune fired ${minutesAgo}m ago: ${recentTuneEntry.triggerReason}`}
              >
                <Sliders className="w-3 h-3" />
                {ruleLabel} · {minutesAgo}m ago
              </span>
            );
          })()}
          <Button size="sm" variant="outline" onClick={togglePause} className="h-7 gap-1">
            {status?.paused ? <><Play className="w-3 h-3" />Resume</> : <><Pause className="w-3 h-3" />Pause</>}
          </Button>
          {/* Paper ⇄ Live mode toggle. Switching to Paper is immediate and stops
              all real-money betting. Switching to Live requires confirmation.
              The toggle is locked to Paper in non-production environments — live
              betting is only permitted in the production deployment. */}
          {!status?.isProductionEnv ? (
            <div
              className="flex items-center gap-2 opacity-50 cursor-not-allowed select-none"
              title="Live betting is only available in the production deployment."
            >
              <span className="text-xs font-medium text-yellow-400">Paper</span>
              <div className="relative w-11 h-6 rounded-full bg-muted">
                <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">Live</span>
            </div>
          ) : confirmLive ? (
              <span className="text-xs text-red-400 font-medium animate-pulse">Confirming…</span>
          ) : (
            <div className="flex items-center gap-2" title={status?.mode === "live" ? "Live — betting real money. Click to switch back to Paper." : "Paper — simulated betting. Click to go Live."}>
              <span className={`text-xs font-medium ${status?.mode === "paper" ? "text-yellow-400" : "text-muted-foreground"}`}>Paper</span>
              <button
                type="button"
                role="switch"
                aria-checked={status?.mode === "live"}
                onClick={() => {
                  if (status?.mode === "live") {
                    setMode("paper"); // immediate — stops real-money betting
                  } else {
                    setConfirmLive(true); // require confirmation before real money
                  }
                }}
                className={`relative w-11 h-6 rounded-full transition-colors ${status?.mode === "live" ? "bg-red-500" : "bg-muted"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${status?.mode === "live" ? "translate-x-5" : ""}`} />
              </button>
              <span className={`text-xs font-medium ${status?.mode === "live" ? "text-red-400" : "text-muted-foreground"}`}>Live</span>
              {/* Live Kalshi balance badge — shown next to the toggle when in live mode */}
              {status?.mode === "live" && (kalshiBalanceData?.ok ? kalshiBalanceData.balance : status?.accountBalance) != null && (
                <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 ml-1" title="Kalshi account balance">
                  ${((kalshiBalanceData?.ok ? kalshiBalanceData.balance : status?.accountBalance) ?? 0).toFixed(2)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

    </>
  );
}
