import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import React from "react";
import { useState } from "react";
import type { AutoTuneLogEntry } from "./types";
import { EST } from "./utils";

interface AutoTuneHistoryProps {
  tuneEntries: AutoTuneLogEntry[];
  tuneCount: number;
  tuneLogOpen: boolean;
  setTuneLogOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function AutoTuneHistory({ tuneEntries, tuneCount, tuneLogOpen, setTuneLogOpen }: AutoTuneHistoryProps) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentTuneEntry = tuneEntries.find((e) => new Date(e.createdAt).getTime() > oneHourAgo) ?? null;
  return (
    <>
        {/* ── Auto-Tune History ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setTuneLogOpen(o => !o)}
          >
            <Sliders className="w-4 h-4 text-violet-400" />
            <h2 className="font-semibold text-sm">Auto-Tune History</h2>
            {tuneCount > 0 && (
              <span className={`inline-flex items-center justify-center text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] ${recentTuneEntry ? "bg-violet-500/30 text-violet-300 border border-violet-500/50" : "bg-muted text-muted-foreground border border-border"}`}>
                {tuneCount}
              </span>
            )}
            {recentTuneEntry && (
              <span className="text-[10px] text-violet-400 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block animate-pulse" />
                last {Math.round((Date.now() - new Date(recentTuneEntry.createdAt).getTime()) / 60000)}m ago
              </span>
            )}
            {tuneLogOpen ? <ChevronUp className="w-4 h-4 ml-auto text-muted-foreground" /> : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />}
          </button>
          {tuneLogOpen && (
            <div className="p-5">
              {tuneEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No parameter changes yet — auto-tune mutations will appear here once the rules trigger.
                </p>
              ) : (
                <div className="space-y-2">
                  {tuneEntries.map(entry => {
                    const ruleColor = entry.ruleName === "confidence_floor_raise"
                      ? "text-amber-400"
                      : entry.ruleName === "per_coin_pause"
                      ? "text-red-400"
                      : "text-sky-400";
                    const ruleLabel = entry.ruleName === "confidence_floor_raise"
                      ? "Confidence Raised"
                      : entry.ruleName === "per_coin_pause"
                      ? "Coin Paused"
                      : entry.ruleName === "quiet_hours_expand"
                      ? "Quiet Hours Expanded"
                      : entry.ruleName;
                    return (
                      <div key={entry.id} className="bg-background/40 rounded-lg px-4 py-3 flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-semibold ${ruleColor}`}>{ruleLabel}</span>
                          {entry.oldValue && entry.newValue && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {entry.oldValue} → {entry.newValue}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString("en-US", { timeZone: EST, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">{entry.triggerReason}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>


    </>
  );
}
