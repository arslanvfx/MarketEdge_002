import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BotConditionsSnapshot, WindowEval, BotStatus } from "./types";
import { API_BASE, wkToEst, fmtPct } from "./utils";
import { CountdownCell } from "./countdown-cell";

function ConditionChip({ ok, warn, bad, label }: { ok?: boolean; warn?: boolean; bad?: boolean; label: string }) {
  const cls = bad
    ? "bg-red-500/15 text-red-300 border-red-500/30"
    : warn
    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
    : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  const dot = bad ? "bg-red-400" : warn ? "bg-amber-400" : "bg-emerald-400";
  return (
    <span className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-medium whitespace-nowrap ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      {label}
    </span>
  );
}

export function ConditionsPanel({
  conditions,
  evaluation,
  status,
}: {
  conditions: BotConditionsSnapshot | undefined;
  evaluation: WindowEval[];
  status: BotStatus | undefined;
}) {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "loading" | "done">("idle");
  const [freeRunLoading, setFreeRunLoading] = useState(false);

  async function handleFreeRunToggle() {
    if (freeRunLoading) return;
    setFreeRunLoading(true);
    try {
      const token = await getToken();
      const next = !(conditions?.freeRunMode ?? false);
      await fetch(`${API_BASE}/crypto/bot/free-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ enabled: next }),
      });
      void qc.invalidateQueries({ queryKey: ["bot-conditions"] });
    } finally {
      setFreeRunLoading(false);
    }
  }

  async function handleReset() {
    setResetState("loading");
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/crypto/bot/reset-conditions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });
      setResetState("done");
      void qc.invalidateQueries({ queryKey: ["bot-conditions"] });
      void qc.invalidateQueries({ queryKey: ["bot-status"] });
      void qc.invalidateQueries({ queryKey: ["bot-window-eval"] });
      void qc.invalidateQueries({ queryKey: ["bot-coin-guard-state"] });
      void qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
      setTimeout(() => setResetState("idle"), 3000);
    } catch {
      setResetState("idle");
    }
  }

  const restrictionCount = !conditions ? 0 : [
    conditions.botEnabled === false,
    conditions.botPaused,
    conditions.isInQuietHours,
    conditions.circuitBreakerActive,
    conditions.dailyLimitHit,
    conditions.dbDegraded,
    conditions.doubtPenaltyPp > 0,
    (conditions.unanimousFailurePenaltyPp ?? 0) > 0,
    conditions.warmupSecondsRemaining > 0,
    conditions.emptyBookBlockedCoins.length > 0,
    Object.keys(conditions.emptyBookAttempts).length > 0,
    (conditions.nearStrikeFilteredCoins ?? []).length > 0,
    Object.keys(conditions.autoTunePausedCoins).length > 0,
    Object.values(status?.coinStreakState ?? {}).some(s => s.pauseUntilWindowKey !== null),
    conditions.directionCapEnabled && (conditions.directionCountYes >= conditions.maxSameDirectionBets || conditions.directionCountNo >= conditions.maxSameDirectionBets),
    conditions.totalBetsThisWindow >= conditions.maxBetsPerWindow,
  ].filter(Boolean).length;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-muted/30 transition-colors select-none"
        onClick={() => setOpen(o => !o)}
      >
        <Shield className="w-4 h-4 text-sky-400 flex-shrink-0" />
        <span className="font-semibold text-sm text-foreground flex-1">Bot Conditions</span>
        {restrictionCount > 0 ? (
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
            {restrictionCount} active
          </span>
        ) : conditions ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">
            All clear
          </span>
        ) : null}
        <button
          onClick={(e) => { e.stopPropagation(); handleFreeRunToggle(); }}
          disabled={freeRunLoading}
          title={conditions?.freeRunMode
            ? "Free Run is ON — all restriction layers bypassed. Safety rails (circuit breaker, daily loss, max bets, ML-Claude gate) still active. Click to turn off."
            : "Free Run OFF — click to bypass all restriction/penalty layers for unrestricted model-driven betting"}
          className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border transition-colors font-medium ${
            conditions?.freeRunMode
              ? "border-amber-500/60 text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 cursor-pointer"
              : freeRunLoading
              ? "border-zinc-500/30 text-zinc-500 cursor-not-allowed"
              : "border-zinc-600/40 text-zinc-400 hover:bg-zinc-700/30 cursor-pointer"
          }`}
        >
          <Zap className={`w-3 h-3 ${freeRunLoading ? "animate-pulse" : ""} ${conditions?.freeRunMode ? "fill-amber-400 text-amber-400" : ""}`} />
          {conditions?.freeRunMode ? "Free Run ON" : "Free Run"}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); if (resetState === "idle") handleReset(); }}
          disabled={resetState !== "idle"}
          title="Clear all window restrictions, cooldowns, pauses, and circuit breaker — safe to run at any time"
          className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border transition-colors ${
            resetState === "done"
              ? "border-emerald-500/50 text-emerald-400 bg-emerald-500/10"
              : resetState === "loading"
              ? "border-sky-500/30 text-sky-400/50 cursor-not-allowed"
              : "border-sky-500/40 text-sky-400 hover:bg-sky-500/10 cursor-pointer"
          }`}
        >
          <RotateCcw className={`w-3 h-3 ${resetState === "loading" ? "animate-spin" : ""}`} />
          {resetState === "done" ? "Reset ✓" : resetState === "loading" ? "Resetting…" : "Reset all"}
        </button>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </div>

      {open && (
        <div className="border-t border-border">
          {/* ── Global conditions ── */}
          <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-border/50">
            <ConditionChip
              ok={(conditions?.botEnabled !== false) && !conditions?.botPaused}
              warn={conditions?.botPaused}
              bad={conditions?.botEnabled === false}
              label={conditions?.botEnabled === false ? "Bot disabled" : conditions?.botPaused ? "Paused" : "Enabled"}
            />
            <ConditionChip
              ok={!conditions?.isInQuietHours}
              bad={conditions?.isInQuietHours}
              label={conditions?.isInQuietHours
                ? `Quiet hrs (${conditions.quietHoursStart}–${conditions.quietHoursEnd} UTC)`
                : "No quiet hours"}
            />
            {conditions?.quietHoursV2State?.mode === "silenced" && (
              <ConditionChip bad label={`🔇 Silenced (${conditions.quietHoursV2State.utcHour} UTC)`} />
            )}
            {conditions?.quietHoursV2State?.mode === "reduced" && (
              <ConditionChip warn label={`📉 Reduced bets (${conditions.quietHoursV2State.reducedBetAmount != null ? `${conditions.quietHoursV2State.reducedBetAmount}%` : "—"} of selected size) (${conditions.quietHoursV2State.utcHour} UTC)`} />
            )}
            <ConditionChip
              ok={!conditions?.circuitBreakerActive}
              bad={conditions?.circuitBreakerActive}
              label={conditions?.circuitBreakerActive
                ? `Circuit breaker (${conditions.circuitBreakerWindowsRemaining}w left)`
                : "CB off"}
            />
            <ConditionChip
              ok={!conditions?.dailyLimitHit}
              bad={conditions?.dailyLimitHit}
              label={conditions?.dailyLimitHit
                ? `Daily limit hit`
                : `Daily P&L $${(conditions?.dailyPnl ?? 0).toFixed(2)} / -$${conditions?.dailyLossLimit ?? 0}`}
            />
            {conditions?.dbDegraded && <ConditionChip bad label="DB offline" />}
            {(conditions?.doubtPenaltyPp ?? 0) > 0 && (
              <ConditionChip warn label={`Doubt penalty +${conditions!.doubtPenaltyPp}pp`} />
            )}
            {(conditions?.unanimousFailurePenaltyPp ?? 0) > 0 && (
              <ConditionChip warn label={`Unanimous fail +${conditions!.unanimousFailurePenaltyPp}pp`} />
            )}
            {(conditions?.warmupSecondsRemaining ?? 0) > 0 && (
              <ConditionChip warn label={`Window warmup ${conditions!.warmupSecondsRemaining}s`} />
            )}
            {conditions?.directionCapEnabled && (
              <>
                <ConditionChip
                  ok={conditions.directionCountYes < conditions.maxSameDirectionBets}
                  bad={conditions.directionCountYes >= conditions.maxSameDirectionBets}
                  label={`YES ${conditions.directionCountYes}/${conditions.maxSameDirectionBets} bets`}
                />
                <ConditionChip
                  ok={conditions.directionCountNo < conditions.maxSameDirectionBets}
                  bad={conditions.directionCountNo >= conditions.maxSameDirectionBets}
                  label={`NO ${conditions.directionCountNo}/${conditions.maxSameDirectionBets} bets`}
                />
              </>
            )}
            <ConditionChip
              ok={conditions ? conditions.totalBetsThisWindow < conditions.maxBetsPerWindow : true}
              bad={conditions ? conditions.totalBetsThisWindow >= conditions.maxBetsPerWindow : false}
              label={`${conditions?.totalBetsThisWindow ?? 0}/${conditions?.maxBetsPerWindow ?? "?"} window bets`}
            />
          </div>

          {/* ── Per-coin table ── */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 bg-muted/20">
                  <th className="text-left px-5 py-2 font-medium text-muted-foreground">Coin</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Signal</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Conf</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-3 py-2 pr-5 font-medium text-muted-foreground">Reason</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.map((ev) => {
                  const emptyBlocked = conditions?.emptyBookBlockedCoins.includes(ev.symbol);
                  const emptyAttempts = conditions?.emptyBookAttempts[ev.symbol];
                  const fullyBlocked = conditions?.fullyBlockedCoins.includes(ev.symbol);
                  const yesBlocked = conditions?.yesBlockedCoins.includes(ev.symbol);
                  const autoTuneW = conditions?.autoTunePausedCoins[ev.symbol];
                  const streakPaused = !!status?.coinStreakState?.[ev.symbol]?.pauseUntilWindowKey;
                  const nearStrikeFiltered = (conditions?.nearStrikeFilteredCoins ?? []).includes(ev.symbol);
                  const betPlaced = ev.betPlacedThisWindow;

                  let statusNode: React.ReactNode;
                  let extraReason = "";

                  if (betPlaced) {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium border border-emerald-500/30">Bet placed</span>;
                  } else if (emptyBlocked) {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 font-medium border border-red-500/30">Empty book ✕</span>;
                    extraReason = "IOC 0 fills × 2 — blocked this window";
                  } else if (emptyAttempts) {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-medium border border-amber-500/30">Empty ({emptyAttempts}/2)</span>;
                    extraReason = "IOC 0 fill — will retry next tick";
                  } else if (fullyBlocked) {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 font-medium border border-red-500/30">No edge ✕</span>;
                    extraReason = "Soft-blocked — no historical edge. Shadow bets monitored; unblocks at ≥60% WR";
                  } else if (autoTuneW) {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-medium border border-amber-500/30">Tune pause ({autoTuneW}w)</span>;
                  } else if (streakPaused) {
                    const st = status?.coinStreakState?.[ev.symbol];
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 font-medium border border-orange-500/30">Streak pause ({st?.consecutiveLosses}L)</span>;
                  } else if (nearStrikeFiltered) {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 font-medium border border-sky-500/30">Near-strike ✕</span>;
                    extraReason = "Market near 50/50 — shadow bets monitored; unblocks at ≥60% WR in this zone";
                  } else if (yesBlocked && ev.action === "BET_YES") {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-medium border border-amber-500/30">YES blocked</span>;
                    extraReason = "YES bets historically unprofitable for this coin";
                  } else if (ev.action === "SKIP") {
                    statusNode = <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">Skip</span>;
                  } else {
                    statusNode = (
                      <span className={`px-2 py-0.5 rounded-full font-medium border ${ev.action === "BET_YES" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-red-500/15 text-red-300 border-red-500/30"}`}>
                        {ev.action === "BET_YES" ? "▲ YES" : "▼ NO"}
                      </span>
                    );
                  }

                  return (
                    <tr key={ev.symbol} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-2.5 font-bold text-foreground">{ev.symbol}</td>
                      <td className="px-3 py-2.5">
                        <span className={`font-mono text-[10px] tracking-wide ${ev.action === "SKIP" ? "text-muted-foreground" : ev.action === "BET_YES" ? "text-emerald-400" : "text-red-400"}`}>
                          {ev.action}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-muted-foreground">
                        {ev.confidence > 0 ? `${ev.confidence}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5">{statusNode}</td>
                      <td className="px-3 py-2.5 pr-5 text-muted-foreground max-w-[260px] truncate" title={extraReason || ev.reason}>
                        {extraReason || ev.reason || "—"}
                      </td>
                    </tr>
                  );
                })}
                {evaluation.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-5 text-center text-muted-foreground">
                      No evaluation data yet — waiting for next bot tick
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Window key footer */}
          {conditions?.windowKey && (
            <div className="px-5 py-2 border-t border-border/30 text-[10px] text-muted-foreground/50 font-mono">
              Window: {conditions.windowKey}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ClearPausesButton() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  async function handleClear() {
    setState("loading");
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/crypto/bot/clear-pauses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });
      setState("done");
      void qc.invalidateQueries({ queryKey: ["bot-status"] });
      void qc.invalidateQueries({ queryKey: ["bot-coin-guard-state"] });
      void qc.invalidateQueries({ queryKey: ["bot-perf-report"] });
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
    }
  }

  return (
    <button
      className={`ml-auto text-[11px] px-2.5 py-1 rounded-lg border transition-colors flex items-center gap-1.5 ${
        state === "done"
          ? "border-emerald-500/50 text-emerald-400 bg-emerald-500/10"
          : state === "loading"
          ? "border-amber-500/30 text-amber-400/50 cursor-not-allowed"
          : "border-amber-500/40 text-amber-400 hover:bg-amber-500/20 cursor-pointer"
      }`}
      onClick={handleClear}
      disabled={state !== "idle"}
    >
      {state === "loading" && (
        <RefreshCw className="w-3 h-3 animate-spin" />
      )}
      {state === "done" ? "Pauses cleared ✓" : "Clear pauses now"}
    </button>
  );
}
