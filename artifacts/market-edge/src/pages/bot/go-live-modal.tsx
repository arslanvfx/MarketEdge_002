import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BotStatus, BotConfig } from "./types";

interface GoLiveModalProps {
  confirmLive: boolean;
  setConfirmLive: (v: boolean) => void;
  liveCheckboxChecked: boolean;
  setLiveCheckboxChecked: (v: boolean) => void;
  status: BotStatus | undefined;
  preflightLoading: boolean;
  kalshiPreflightData: { configured: boolean; balance: number | null; ok: boolean } | undefined;
  merged: BotConfig;
  setMode: (mode: "paper" | "live") => Promise<void>;
}

export function GoLiveModal({ confirmLive, setConfirmLive, liveCheckboxChecked, setLiveCheckboxChecked, status, preflightLoading, kalshiPreflightData, merged, setMode }: GoLiveModalProps) {
  if (!confirmLive) return null;
  return (
        <div
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => { setConfirmLive(false); setLiveCheckboxChecked(false); }}
        >
          <div
            className="w-96 max-w-[92vw] bg-card border border-red-500/40 rounded-2xl shadow-2xl p-6 flex flex-col gap-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-red-400 font-bold text-base">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              Switch to Live Betting
            </div>
            <p className="text-xs text-muted-foreground -mt-1">Real money will be at stake. Review the checks below before confirming.</p>

            {/* Pre-live checklist */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-xs">
                {status?.configured
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  : <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                <span className={status?.configured ? "text-emerald-400" : "text-red-400 font-medium"}>
                  {status?.configured ? "Kalshi API key configured" : "Kalshi API key NOT configured — cannot go live"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {preflightLoading
                  ? <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
                  : kalshiPreflightData?.ok
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    : <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                <span className={preflightLoading ? "text-muted-foreground" : kalshiPreflightData?.ok ? "text-emerald-400" : "text-yellow-400 font-medium"}>
                  {preflightLoading
                    ? "Checking Kalshi account balance…"
                    : kalshiPreflightData?.ok
                      ? `Kalshi balance: $${kalshiPreflightData.balance?.toFixed(2)} (above $${(merged.minAccountBalance ?? 5).toFixed(2)} minimum)`
                      : "Balance check unavailable — you may still proceed if your API key is configured"}
                </span>
              </div>
            </div>

            {/* Active limits summary */}
            <div className="bg-background/60 border border-border rounded-lg px-4 py-3 text-xs flex flex-col gap-1.5">
              <div className="text-muted-foreground font-medium mb-1">Active safety limits</div>
              {([
                ["Max single bet", `$${(merged.maxBetSize ?? 2).toFixed(2)}`],
                ["Daily loss limit", `$${(merged.dailyLossLimit ?? 20).toFixed(2)}`],
                ["Total exposure cap", `$${(merged.maxTotalExposure ?? 5).toFixed(2)}`],
                ["Min account balance", `$${(merged.minAccountBalance ?? 5).toFixed(2)}`],
                ["Daily loss / coin", `$${(merged.maxDailyLossPerCoin ?? 3).toFixed(2)}`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="text-foreground font-mono">{v}</span>
                </div>
              ))}
            </div>

            {/* Confirmation checkbox */}
            <label className="flex items-start gap-2.5 cursor-pointer select-none text-xs">
              <input
                type="checkbox"
                className="mt-0.5 accent-red-500 cursor-pointer"
                checked={liveCheckboxChecked}
                onChange={e => setLiveCheckboxChecked(e.target.checked)}
              />
              <span className="text-muted-foreground leading-relaxed">
                I understand this will place real bets on Kalshi. I have reviewed my settings and accept the financial risk.
              </span>
            </label>

            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                variant="destructive"
                className="flex-1 h-8 font-semibold"
                disabled={!status?.configured || !liveCheckboxChecked}
                onClick={() => { setMode("live"); setConfirmLive(false); setLiveCheckboxChecked(false); }}
              >
                {preflightLoading ? "Verifying…" : "Confirm — Go Live"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => { setConfirmLive(false); setLiveCheckboxChecked(false); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>

  );
}
