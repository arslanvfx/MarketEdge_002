import React, { useState } from "react";
import { useAuth } from "@clerk/react";
import { BarChart2, VolumeX, TrendingDown, Zap } from "lucide-react";
import type { QuietHoursV2, QuietHoursAnalysis } from "./types";
import { utcToEst, ET_LABEL, API_BASE } from "./utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function winRateTier(wr: number | null, totalBets: number): "good" | "ok" | "bad" | "empty" {
  if (wr === null || totalBets === 0) return "empty";
  if (wr >= 85) return "good";
  if (wr >= 75) return "ok";
  return "bad";
}

function hourMode(h: number, v2: QuietHoursV2): "silenced" | "reduced" | "active" {
  if (v2.silencedUtcHours.includes(h)) return "silenced";
  if (v2.reducedBetUtcHours[String(h)] != null) return "reduced";
  return "active";
}

// ── Single hour cell ──────────────────────────────────────────────────────────

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
  const tier = winRateTier(winRatePct, totalBets);

  // Background + border by tier and mode
  const tierStyles: Record<string, string> = {
    good:  "bg-emerald-500/10 border-emerald-500/25",
    ok:    "bg-amber-500/10   border-amber-500/25",
    bad:   "bg-red-500/10     border-red-500/25",
    empty: "bg-muted/20       border-border/40",
  };

  const winRateColor: Record<string, string> = {
    good:  "text-emerald-300",
    ok:    "text-amber-300",
    bad:   "text-red-300",
    empty: "text-muted-foreground/40",
  };

  const dotColor: Record<string, string> = {
    good:  "bg-emerald-400",
    ok:    "bg-amber-400",
    bad:   "bg-red-400",
    empty: "bg-muted-foreground/25",
  };

  const silencedOverlay = mode === "silenced"
    ? "opacity-40 grayscale-[60%]"
    : "";

  const currentRing = isCurrentHour
    ? "ring-2 ring-cyan-400/70 ring-offset-1 ring-offset-background"
    : "";

  const modeRing = mode === "reduced" && !isCurrentHour
    ? "ring-1 ring-amber-400/50"
    : "";

  return (
    <div
      className={`
        group relative flex flex-col rounded-xl border cursor-pointer select-none
        transition-all duration-150 hover:brightness-125 active:scale-[0.97]
        ${tierStyles[tier]} ${silencedOverlay} ${currentRing} ${modeRing}
      `}
      onClick={() => onCycleMode(utcHour)}
      title={`${estLabel} ${ET_LABEL} (UTC ${String(utcHour).padStart(2, "0")}:00)\nClick to cycle: Active → Silenced → Reduced${mode === "reduced" ? `\nReduced to: $${reducedBetAmount ?? "—"}` : ""}`}
    >
      {/* Inner padding wrapper */}
      <div className="flex flex-col gap-1 p-3">

        {/* Row 1: hour label + mode icon */}
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] font-semibold text-foreground/80 leading-none tracking-wide">
            {estLabel}
          </span>
          <span className="flex items-center">
            {mode === "silenced" && (
              <VolumeX className="w-3 h-3 text-slate-400" />
            )}
            {mode === "reduced" && (
              <TrendingDown className="w-3 h-3 text-amber-400" />
            )}
            {mode === "active" && (
              <span className={`w-2 h-2 rounded-full ${dotColor[tier]}`} />
            )}
          </span>
        </div>

        {/* Row 2: win rate — dominant */}
        <div className={`text-[18px] font-bold leading-tight ${winRateColor[tier]}`}>
          {totalBets === 0 ? (
            <span className="text-[13px] text-muted-foreground/30 font-normal">—</span>
          ) : winRatePct !== null ? (
            `${winRatePct.toFixed(0)}%`
          ) : (
            <span className="text-[13px] text-muted-foreground/30 font-normal">—</span>
          )}
        </div>

        {/* Row 3: bets + P&L */}
        {totalBets > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/60 leading-none">
              {totalBets}b
            </span>
            <span className={`text-[10px] font-medium leading-none ${totalPnl >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}
            </span>
          </div>
        )}

        {/* Reduced bet input */}
        {mode === "reduced" && (
          <input
            type="number"
            min={0.01}
            max={99}
            step={0.25}
            value={reducedBetAmount ?? ""}
            placeholder="$ cap"
            onClick={e => e.stopPropagation()}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) onReducedBetChange(utcHour, v);
            }}
            className="mt-0.5 w-full text-[11px] rounded-md px-2 py-1 bg-background/70 border border-amber-400/40 text-amber-300 outline-none focus:ring-1 focus:ring-amber-400/60 placeholder:text-amber-300/40"
          />
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface QuietHoursGridProps {
  value: QuietHoursV2;
  onChange: (v: QuietHoursV2) => void;
}

// Row labels for the 3-row layout (8 cols × 3 rows)
const ROW_LABELS = [
  { range: "12 AM – 7 AM", sublabel: "UTC 00–07" },
  { range: "8 AM – 3 PM",  sublabel: "UTC 08–15" },
  { range: "4 PM – 11 PM", sublabel: "UTC 16–23" },
];

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
    onChange({ ...value, silencedUtcHours: analysis.suggestedSilencedHours });
  }

  function cycleMode(h: number) {
    const current = hourMode(h, value);
    if (current === "active") {
      onChange({ ...value, silencedUtcHours: [...value.silencedUtcHours, h] });
    } else if (current === "silenced") {
      const defaultAmount = Number((value.reducedBetUtcHours[String(h)] ?? 0.50).toFixed(2));
      onChange({
        ...value,
        silencedUtcHours: value.silencedUtcHours.filter(x => x !== h),
        reducedBetUtcHours: { ...value.reducedBetUtcHours, [String(h)]: defaultAmount },
      });
    } else {
      const { [String(h)]: _, ...rest } = value.reducedBetUtcHours;
      onChange({
        ...value,
        silencedUtcHours: value.silencedUtcHours.filter(x => x !== h),
        reducedBetUtcHours: rest,
      });
    }
  }

  function setReducedBetAmount(h: number, amount: number) {
    onChange({ ...value, reducedBetUtcHours: { ...value.reducedBetUtcHours, [String(h)]: amount } });
  }

  const silencedCount = value.silencedUtcHours.length;
  const reducedCount = Object.keys(value.reducedBetUtcHours).length;

  // Split 24 hours into three rows of 8
  const rows = [
    Array.from({ length: 8 }, (_, i) => i),       // UTC 00–07
    Array.from({ length: 8 }, (_, i) => i + 8),   // UTC 08–15
    Array.from({ length: 8 }, (_, i) => i + 16),  // UTC 16–23
  ];

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-sm font-semibold text-foreground">Smart Quiet Hours</span>
          {value.enabled && (silencedCount > 0 || reducedCount > 0) && (
            <div className="flex items-center gap-1.5">
              {silencedCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400 border border-slate-500/20">
                  <VolumeX className="w-3 h-3" /> {silencedCount} silenced
                </span>
              )}
              {reducedCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <TrendingDown className="w-3 h-3" /> {reducedCount} reduced
                </span>
              )}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <span className="text-xs text-muted-foreground">Enabled</span>
          <div
            className={`w-9 h-5 rounded-full transition-colors relative ${value.enabled ? "bg-cyan-500" : "bg-muted"}`}
            onClick={() => onChange({ ...value, enabled: !value.enabled })}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${value.enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </div>
        </label>
      </div>

      {/* ── Legend ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" /> ≥85% win rate</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" /> 75–84%</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0" /> &lt;75%</span>
        <span className="flex items-center gap-1.5"><VolumeX className="w-3 h-3 text-slate-400 shrink-0" /> Silenced</span>
        <span className="flex items-center gap-1.5"><TrendingDown className="w-3 h-3 text-amber-400 shrink-0" /> Reduced</span>
        <span className="text-muted-foreground/50 hidden sm:block">· Click a cell to cycle Active → Silenced → Reduced</span>
      </div>

      {/* ── Grid: 3 rows of 8, with ET row labels ── */}
      <div className="flex flex-col gap-3">
        {rows.map((rowHours, rowIdx) => (
          <div key={rowIdx} className="flex items-start gap-3">
            {/* Row label */}
            <div className="flex flex-col items-end justify-center shrink-0 pt-3" style={{ width: "5rem" }}>
              <span className="text-[11px] font-medium text-foreground/60 text-right leading-tight">
                {ROW_LABELS[rowIdx].range} {ET_LABEL}
              </span>
              <span className="text-[9px] text-muted-foreground/40 text-right mt-0.5">
                {ROW_LABELS[rowIdx].sublabel}
              </span>
            </div>

            {/* 8 cells */}
            <div className="grid gap-2 flex-1" style={{ gridTemplateColumns: "repeat(8, minmax(0, 1fr))" }}>
              {rowHours.map(h => {
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
          </div>
        ))}
      </div>

      {/* ── Analyze + Apply controls ── */}
      <div className="flex flex-wrap items-end gap-3 pt-3 border-t border-border/50">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Days of data</span>
          <select
            className="bg-background border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground"
            value={days}
            onChange={e => setDays(parseInt(e.target.value, 10))}
          >
            {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Silence threshold</span>
          <select
            className="bg-background border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground"
            value={targetWinRate}
            onChange={e => setTargetWinRate(parseInt(e.target.value, 10))}
          >
            {[70, 75, 80, 85, 90].map(r => <option key={r} value={r}>&lt;{r}% win rate</option>)}
          </select>
        </label>

        <button
          onClick={fetchAnalysis}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border border-sky-500/40 text-sky-400 hover:bg-sky-500/10 disabled:opacity-50 transition-colors"
        >
          <BarChart2 className={`w-3.5 h-3.5 ${loading ? "animate-pulse" : ""}`} />
          {loading ? "Loading…" : "Analyze"}
        </button>

        {analysis && (
          <button
            onClick={applySuggested}
            className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border border-amber-500/50 bg-amber-500/5 text-amber-400 hover:bg-amber-500/15 transition-colors font-medium"
            title={`Auto-silence ${analysis.suggestedSilencedHours.length} hour${analysis.suggestedSilencedHours.length !== 1 ? "s" : ""} below ${targetWinRate}% win rate (≥5 bets)`}
          >
            <Zap className="w-3.5 h-3.5" />
            Apply suggested ({analysis.suggestedSilencedHours.length} hour{analysis.suggestedSilencedHours.length !== 1 ? "s" : ""})
          </button>
        )}

        {error && <span className="text-xs text-red-400">{error}</span>}

        {analysis && !error && (
          <span className="text-[11px] text-muted-foreground/60 ml-auto self-center">
            {analysis.days}d · {analysis.hourStats.reduce((s, h) => s + h.totalBets, 0).toLocaleString()} live bets
          </span>
        )}
      </div>
    </div>
  );
}
