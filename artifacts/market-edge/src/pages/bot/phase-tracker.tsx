import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrendingUp, CheckCircle2, XCircle, ChevronRight, RefreshCw, RotateCcw, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "./utils";

interface PhaseStatus {
  phase: number;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number;
  betTargetPassed: boolean;
  winRatePassed: boolean;
  pnlPassed: boolean;
  allPassed: boolean;
  isLastPhase: boolean;
  targetBets: number;
  betSize: number;
  maxBetSize: number;
  label: string;
  nextBetSize: number | null;
  nextMaxBetSize: number | null;
}

const PHASE_COLORS: Record<number, { badge: string; ring: string; bar: string; glow: string }> = {
  1: { badge: "bg-sky-500/15 text-sky-300 border-sky-500/30", ring: "border-sky-500/20 bg-sky-500/5", bar: "bg-sky-500", glow: "text-sky-400" },
  2: { badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", ring: "border-amber-500/20 bg-amber-500/5", bar: "bg-amber-400", glow: "text-amber-400" },
  3: { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", ring: "border-emerald-500/20 bg-emerald-500/5", bar: "bg-emerald-400", glow: "text-emerald-400" },
};

const PHASE_LABELS = ["Test", "Build", "Full"];

interface Props {
  onConfigSaved: () => void;
}

export function PhaseTracker({ onConfigSaved }: Props) {
  const qc = useQueryClient();
  const [advancing, setAdvancing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: status, isLoading, refetch } = useQuery<PhaseStatus>({
    queryKey: ["phase-status"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/crypto/bot/phase-status`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  async function advancePhase() {
    if (!status || advancing) return;
    setAdvancing(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await fetch(`${API_BASE}/crypto/bot/advance-phase`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body.error ?? "Failed to advance phase");
      } else {
        setSuccess(`Advanced to Phase ${body.newPhase} — bet sizes updated to $${body.betSize}/$${body.maxBetSize}`);
        await qc.invalidateQueries({ queryKey: ["phase-status"] });
        await qc.invalidateQueries({ queryKey: ["bot-status"] });
        onConfigSaved();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setAdvancing(false);
    }
  }

  async function resetPhase(toPhase?: number) {
    if (resetting) return;
    setResetting(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await fetch(`${API_BASE}/crypto/bot/reset-phase`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPhase != null ? { phase: toPhase } : {}),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body.error ?? "Failed to reset phase");
      } else {
        const label = toPhase != null ? `Reset to Phase ${toPhase}` : "Phase timer restarted";
        setSuccess(`${label} — tracking from now`);
        await qc.invalidateQueries({ queryKey: ["phase-status"] });
        await qc.invalidateQueries({ queryKey: ["bot-status"] });
        onConfigSaved();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setResetting(false);
    }
  }

  const phase = status?.phase ?? 1;
  const colors = PHASE_COLORS[phase] ?? PHASE_COLORS[1];

  const betProgress = status ? Math.min(1, status.bets / Math.max(status.targetBets, 1)) : 0;
  const winRatePct = status ? Math.round(status.winRate * 100) : 0;
  const pnlDisplay = status
    ? (status.pnl >= 0 ? `+$${status.pnl.toFixed(2)}` : `-$${Math.abs(status.pnl).toFixed(2)}`)
    : "$0.00";

  function GateCheck({ passed, label }: { passed: boolean; label: string }) {
    return (
      <div className="flex items-center gap-1.5">
        {passed
          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          : <XCircle className="w-3.5 h-3.5 text-rose-400/70 shrink-0" />}
        <span className={`text-[11px] ${passed ? "text-foreground/80" : "text-muted-foreground/60"}`}>{label}</span>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border ${colors.ring} p-3 flex flex-col gap-2.5`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className={`w-3.5 h-3.5 ${colors.glow}`} />
          <span className="text-xs font-semibold text-foreground/90">Scale Phase Tracker</span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${colors.badge}`}>
            Phase {phase} — {status?.label ?? PHASE_LABELS[(phase - 1)] ?? "Test"}
          </span>
          {status?.isLastPhase && (
            <Trophy className="w-3.5 h-3.5 text-amber-400" title="Final phase reached" />
          )}
        </div>
        <button
          onClick={() => refetch()}
          className="p-1 rounded hover:bg-white/5 transition-colors"
          title="Refresh phase stats"
        >
          <RefreshCw className="w-3 h-3 text-muted-foreground/50" />
        </button>
      </div>

      {/* Current bet sizes */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
        <span>
          Bet size: <span className="text-foreground/90 font-medium">${status?.betSize ?? "—"}</span>
          <span className="mx-1">/</span>
          Max: <span className="text-foreground/90 font-medium">${status?.maxBetSize ?? "—"}</span>
        </span>
        {!status?.isLastPhase && status?.nextBetSize != null && (
          <>
            <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
            <span className="text-muted-foreground/50">
              Next: ${status.nextBetSize} / ${status.nextMaxBetSize}
            </span>
          </>
        )}
      </div>

      {isLoading && (
        <div className="text-[11px] text-muted-foreground/50 animate-pulse">Loading phase data…</div>
      )}

      {status && (
        <>
          {/* Bet progress bar */}
          {!status.isLastPhase && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
                <span>Live bets this phase</span>
                <span className={status.betTargetPassed ? "text-emerald-400" : "text-foreground/70"}>
                  {status.bets} / {status.targetBets}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${colors.bar}`}
                  style={{ width: `${Math.round(betProgress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col items-center gap-0.5 rounded-lg bg-white/[0.03] py-1.5 px-2">
              <span className="text-[10px] text-muted-foreground/50">Win rate</span>
              <span className={`text-sm font-semibold ${status.winRatePassed ? "text-emerald-400" : "text-foreground/80"}`}>
                {status.bets > 0 ? `${winRatePct}%` : "—"}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 rounded-lg bg-white/[0.03] py-1.5 px-2">
              <span className="text-[10px] text-muted-foreground/50">Phase P&L</span>
              <span className={`text-sm font-semibold ${status.pnl > 0 ? "text-emerald-400" : status.pnl < 0 ? "text-rose-400" : "text-foreground/80"}`}>
                {status.bets > 0 ? pnlDisplay : "—"}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 rounded-lg bg-white/[0.03] py-1.5 px-2">
              <span className="text-[10px] text-muted-foreground/50">W / L</span>
              <span className="text-sm font-semibold text-foreground/80">
                {status.bets > 0 ? `${status.wins} / ${status.losses}` : "—"}
              </span>
            </div>
          </div>

          {/* Gate checks */}
          {!status.isLastPhase && (
            <div className="flex flex-col gap-1 rounded-lg bg-white/[0.03] px-2.5 py-2">
              <span className="text-[10px] text-muted-foreground/50 mb-0.5">Gates to advance</span>
              <GateCheck passed={status.betTargetPassed} label={`${status.targetBets}+ live bets this phase`} />
              <GateCheck passed={status.winRatePassed} label="Win rate ≥ 85%" />
              <GateCheck passed={status.pnlPassed} label="Phase P&L positive" />
            </div>
          )}

          {status.isLastPhase && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-2">
              <Trophy className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="text-[11px] text-emerald-300">
                Phase 3 reached — full bet sizes active. Keep tracking performance.
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {!status.isLastPhase && (
              <Button
                size="sm"
                disabled={!status.allPassed || advancing}
                onClick={advancePhase}
                className={`h-7 text-[11px] px-3 ${status.allPassed ? "bg-emerald-600 hover:bg-emerald-500 text-white" : "opacity-40 cursor-not-allowed"}`}
              >
                {advancing ? "Advancing…" : `Advance to Phase ${phase + 1}`}
                {status.allPassed && !advancing && <ChevronRight className="w-3 h-3 ml-1" />}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={resetting}
              onClick={() => resetPhase()}
              className="h-7 text-[11px] px-2.5 text-muted-foreground/60 hover:text-foreground/80"
              title="Restart phase timer from now (keeps phase number)"
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              {resetting ? "Resetting…" : "Restart timer"}
            </Button>
            {phase > 1 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={resetting}
                onClick={() => resetPhase(phase - 1)}
                className="h-7 text-[11px] px-2.5 text-rose-400/60 hover:text-rose-400"
                title={`Go back to Phase ${phase - 1} with its bet sizes`}
              >
                ↩ Back to Phase {phase - 1}
              </Button>
            )}
          </div>

          {/* Phase jump buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground/40">Jump to:</span>
            {[1, 2, 3].map(p => (
              <button
                key={p}
                disabled={resetting || p === phase}
                onClick={() => resetPhase(p)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors
                  ${p === phase
                    ? "border-white/10 text-white/30 cursor-default"
                    : "border-white/10 text-muted-foreground/50 hover:border-white/20 hover:text-foreground/70 cursor-pointer"
                  }`}
              >
                Phase {p}
              </button>
            ))}
          </div>
        </>
      )}

      {error && (
        <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2.5 py-1.5">
          {error}
        </div>
      )}
      {success && (
        <div className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-1.5">
          {success}
        </div>
      )}
    </div>
  );
}
