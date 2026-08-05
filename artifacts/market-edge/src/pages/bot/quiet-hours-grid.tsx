import React, { useState } from "react";
import { useAuth } from "@clerk/react";
import { BarChart2, RefreshCw, Zap, VolumeX, TrendingDown } from "lucide-react";
import type { QuietHoursV2, QuietHoursAnalysis } from "./types";
import { utcToEst, ET_LABEL, API_BASE } from "./utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

function winRateColor(wr: number | null, totalBets: number): string {
  if (wr === null || totalBets === 0) return "bg-muted/40 border-border text-muted-foreground/50";
  if (wr >= 85) return "bg-emerald-500/15 border-emerald-500/30 text-emerald-300";
  if (wr >= 75) return "bg-amber-500/15 border-amber-500/30 text-amber-300";
  return "bg-red-500/15 border-red-500/30 text-red-300";
}

function winRateDot(wr: number | null, totalBets: number): string {
  if (wr === null || totalBets === 0) return "bg-muted-foreground/30";
  if (wr >= 85) return "bg-emerald-400";
  if (wr >= 75) return "bg-amber-400";
  return "bg-red-400";
}

function hourMode(h: number, v2: QuietHoursV2): "silenced" | "reduced" | "active" {
  if (v2.silencedUtcHours.includes(h)) return "silenced";
  if (v2.reducedBetUtcHours[String(h)] != null) return "reduced";
  return "active";
}

// ── Sub-component: single hour cell ─────────────────────────────────────────

interface HourCellProps {
  utcHour: number;
  mode: "silenced" | "reduced" | "active";
  winRatePct: number | null;
  totalBets: number;
  totalPnl: number;
  reducedBetAmount: number | undefined;
  isCurrentHour: boolean;
  onCycleMode: (h: number) => void;
  onReducedBetChange: (h: number, amount: number) => void;
}

function HourCell({
  utcHour,
  mode,
  winRatePct,
  totalBets,
  totalPnl,
  reducedBetAmount,
  isCurrentHour,
  onCycleMode,
  onReducedBetChange,
}: HourCellProps) {
  const estHour = utcToEst(utcHour);
  const estLabel = `${String(estHour).padStart(2, "0")}:00`;

  const baseColor = winRateColor(winRatePct, totalBets);
  const dot = winRateDot(winRatePct, totalBets);

  // Mode-specific overlays
  const modeRing =
    mode === "silenced"
      ? "ring-2 ring-slate-400/60"
      : mode === "reduced"
      ? "ring-2 ring-amber-400/60"
      : "";

  const modeOverlay =
    mode === "silenced"
      ? "opacity-40"
      : "";

  return (
    <div
      className={`relative flex flex-col gap-0.5 p-2 rounded-lg border cursor-pointer select-none transition-all
        ${baseColor} ${modeRing} ${modeOverlay}
        ${isCurrentHour ? "ring-2 ring-cyan-400/80" : ""}
        hover:brightness-110 active:scale-95`}
      onClick={() => onCycleMode(utcHour)}
      title={`${estLabel} ${ET_LABEL} (UTC ${utcHour})\nClick to cycle: Active → Silenced → Reduced${mode === "reduced" ? `\nReduced to: $${reducedBetAmount ?? "—"}` : ""}`}
    >
      {/* Top row: hour + mode icon */}
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold leading-none">{estLabel}</span>
        {mode === "silenced" && <VolumeX className="w-3 h-3 text-slate-400 flex-shrink-0" />}
        {mode === "reduced" && <TrendingDown className="w-3 h-3 text-amber-400 flex-shrink-0" />}
        {mode === "active" && totalBets > 0 && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />}
      </div>

      {/* Win rate */}
      <span className="text-[11px] font-bold leading-none">
        {totalBets === 0 ? (
          <span className="opacity-40">—</span>
        ) : winRatePct !== null ? (
          `${winRatePct.toFixed(0)}%`
        ) : (
          <span className="opacity-40">—</span>
        )}
      </span>

      {/* Bets + P&L */}
      {totalBets > 0 && (
        <span className={`text-[9px] leading-none ${totalPnl >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
          {totalBets}b {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}
        </span>
      )}

      {/* Reduced bet input */}
      {mode === "reduced" && (
        <input
          type="number"
          min={0.01}
          max={99}
          step={0.25}
          value={reducedBetAmount ?? ""}
          placeholder="$"
          onClick={e => e.stopPropagation()}
          onChange={e => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v > 0) onReducedBetChange(utcHour, v);
          }}
          className="mt-0.5 w-full text-[10px] rounded px-1 py-0.5 bg-background/60 border border-amber-400/40 text-amber-300 outline-none focus:ring-1 focus:ring-amber-400/60"
        />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface QuietHoursGridProps {
  value: QuietHoursV2;
  onChange: (v: QuietHoursV2) => void;
}

export function QuietHoursGrid({ value, onChange }: QuietHoursGridProps) {
  const { getToken } = useAuth();
  const [analysis, setAnalysis] = useState<QuietHoursAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(14);
  const [targetWinRate, setTargetWinRate] = useState(85);
  const [error, setError] = useState<string | null>(null);

  const currentUtcHour = new Date().getUTCHours();

  async function fetchAnalysis() {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const resp = await fetch(
        `${API_BASE}/crypto/bot/quiet-hours-analysis?days=${days}&targetWinRate=${targetWinRate}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: QuietHoursAnalysis = await resp.json();
      setAnalysis(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  function applySuggested() {
    if (!analysis) return;
    onChange({
      ...value,
      silencedUtcHours: analysis.suggestedSilencedHours,
    });
  }

  function cycleMode(h: number) {
    const current = hourMode(h, value);
    if (current === "active") {
      // → silenced
      onChange({
        ...value,
        silencedUtcHours: [...value.silencedUtcHours, h],
      });
    } else if (current === "silenced") {
      // → reduced
      const newSilenced = value.silencedUtcHours.filter(x => x !== h);
      const defaultAmount = Number((value.reducedBetUtcHours[String(h)] ?? 0.50).toFixed(2));
      onChange({
        ...value,
        silencedUtcHours: newSilenced,
        reducedBetUtcHours: { ...value.reducedBetUtcHours, [String(h)]: defaultAmount },
      });
    } else {
      // → active
      const { [String(h)]: _, ...rest } = value.reducedBetUtcHours;
      onChange({
        ...value,
        silencedUtcHours: value.silencedUtcHours.filter(x => x !== h),
        reducedBetUtcHours: rest,
      });
    }
  }

  function setReducedBetAmount(h: number, amount: number) {
    onChange({
      ...value,
      reducedBetUtcHours: { ...value.reducedBetUtcHours, [String(h)]: amount },
    });
  }

  const silencedCount = value.silencedUtcHours.length;
  const reducedCount = Object.keys(value.reducedBetUtcHours).length;

  return (
    <div className="flex flex-col gap-3">
      {/* ── Header + enabled toggle ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Smart Quiet Hours</span>
          {(silencedCount > 0 || reducedCount > 0) && value.enabled && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
              {silencedCount > 0 && `${silencedCount} silenced`}
              {silencedCount > 0 && reducedCount > 0 && " · "}
              {reducedCount > 0 && `${reducedCount} reduced`}
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-muted-foreground">Enabled</span>
          <div
            className={`w-8 h-4 rounded-full transition-colors relative ${value.enabled ? "bg-cyan-500" : "bg-muted"}`}
            onClick={() => onChange({ ...value, enabled: !value.enabled })}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${value.enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </div>
        </label>
      </div>

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> ≥85% win rate
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> 75–84%
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400" /> &lt;75%
        </span>
        <span className="flex items-center gap-1.5">
          <VolumeX className="w-3 h-3 text-slate-400" /> Silenced
        </span>
        <span className="flex items-center gap-1.5">
          <TrendingDown className="w-3 h-3 text-amber-400" /> Reduced
        </span>
        <span className="text-muted-foreground/60 ml-auto">Click a cell to cycle Active → Silenced → Reduced</span>
      </div>

      {/* ── 24-cell grid ── */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
        {Array.from({ length: 24 }, (_, h) => {
          const stat = analysis?.hourStats.find(s => s.utcHour === h);
          return (
            <HourCell
              key={h}
              utcHour={h}
              mode={hourMode(h, value)}
              winRatePct={stat?.winRatePct ?? null}
              totalBets={stat?.totalBets ?? 0}
              totalPnl={stat?.totalPnl ?? 0}
              reducedBetAmount={value.reducedBetUtcHours[String(h)]}
              isCurrentHour={h === currentUtcHour}
              onCycleMode={cycleMode}
              onReducedBetChange={setReducedBetAmount}
            />
          );
        })}
      </div>

      {/* ── Row 2 label hint ── */}
      <div className="flex justify-between text-[10px] text-muted-foreground/60 -mt-1 px-0.5">
        <span>00:00–11:00 UTC (top row)</span>
        <span>12:00–23:00 UTC (bottom row) · current hour highlighted in cyan</span>
      </div>

      {/* ── Analyze & Apply controls ── */}
      <div className="flex flex-wrap items-end gap-3 pt-1 border-t border-border/50">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Days of data</span>
          <select
            className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground"
            value={days}
            onChange={e => setDays(parseInt(e.target.value, 10))}
          >
            {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Silence threshold</span>
          <select
            className="bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground"
            value={targetWinRate}
            onChange={e => setTargetWinRate(parseInt(e.target.value, 10))}
          >
            {[70, 75, 80, 85, 90].map(r => <option key={r} value={r}>&lt;{r}% win rate</option>)}
          </select>
        </label>
        <button
          onClick={fetchAnalysis}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-sky-500/40 text-sky-400 hover:bg-sky-500/10 disabled:opacity-50 transition-colors"
        >
          <BarChart2 className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading…" : "Analyze"}
        </button>
        {analysis && (
          <button
            onClick={applySuggested}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
            title={`Auto-silence ${analysis.suggestedSilencedHours.length} hour${analysis.suggestedSilencedHours.length !== 1 ? "s" : ""} below ${targetWinRate}% win rate (≥5 bets)`}
          >
            <Zap className="w-3 h-3" />
            Apply suggested ({analysis.suggestedSilencedHours.length} hour{analysis.suggestedSilencedHours.length !== 1 ? "s" : ""})
          </button>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
        {analysis && !error && (
          <span className="text-[11px] text-muted-foreground/70 ml-auto">
            {analysis.days}d · {analysis.hourStats.reduce((s, h) => s + h.totalBets, 0)} live bets
          </span>
        )}
      </div>
    </div>
  );
}
