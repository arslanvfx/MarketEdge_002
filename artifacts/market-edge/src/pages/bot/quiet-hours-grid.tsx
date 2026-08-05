import React, { useState } from "react";
import { useAuth } from "@clerk/react";
import { BarChart2, VolumeX, TrendingDown, Zap, RefreshCw, Calendar, X } from "lucide-react";
import type { QuietHoursV2, QuietHoursAnalysis, QuietHoursHourStat } from "./types";
import { utcToEst, ET_LABEL, API_BASE } from "./utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function winRateTier(wr: number | null, totalBets: number): "good" | "ok" | "bad" | "empty" {
  if (wr === null || totalBets === 0) return "empty";
  if (wr >= 85) return "good";
  if (wr >= 75) return "ok";
  return "bad";
}

/** Effective mode for a given hour, considering flat + per-dow overrides. */
function hourMode(h: number, v2: QuietHoursV2, dow: number | null): "silenced" | "reduced" | "active" {
  const dowStr = dow != null ? String(dow) : null;
  const silencedFlat = v2.silencedUtcHours.includes(h);
  const silencedDow  = dowStr != null && (v2.silencedByDow?.[dowStr] ?? []).includes(h);
  if (silencedFlat || silencedDow) return "silenced";

  const reducedFlat = v2.reducedBetUtcHours[String(h)];
  const reducedDow  = dowStr != null ? v2.reducedByDow?.[dowStr]?.[String(h)] : undefined;
  if (reducedFlat != null || reducedDow != null) return "reduced";
  return "active";
}

/** Returns true when an hour has a per-dow specific override (so a badge should appear). */
function hasDowOverride(h: number, v2: QuietHoursV2, dow: number | null): boolean {
  if (dow == null) return false;
  const dowStr = String(dow);
  const silencedDow = (v2.silencedByDow?.[dowStr] ?? []).includes(h);
  const reducedDow  = v2.reducedByDow?.[dowStr]?.[String(h)] != null;
  return silencedDow || reducedDow;
}

interface HourCellProps {
  utcHour: number;
  mode: "silenced" | "reduced" | "active";
  hasDowBadge: boolean;
  winRatePct: number | null;
  totalBets: number;
  totalPnl: number;
  reducedPct: number | undefined;     // 1–99: % reduction; undefined = not reduced
  isCurrentHour: boolean;
  onToggleSilence: (h: number) => void;
  onSetReducedPct: (h: number, pct: number) => void;
  onClearReducedPct: (h: number) => void;
}

function HourCell({
  utcHour,
  mode,
  hasDowBadge,
  winRatePct,
  totalBets,
  totalPnl,
  reducedPct,
  isCurrentHour,
  onToggleSilence,
  onSetReducedPct,
  onClearReducedPct,
}: HourCellProps) {
  const [editingPct, setEditingPct] = useState(false);
  const [pctInput, setPctInput] = useState("");

  const estHour = utcToEst(utcHour);
  const estLabel = `${String(estHour).padStart(2, "0")}:00`;
  const tier = winRateTier(winRatePct, totalBets);

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

  const silencedOverlay = mode === "silenced" ? "opacity-40 grayscale-[60%]" : "";
  const currentRing = isCurrentHour ? "ring-2 ring-cyan-400/70 ring-offset-1 ring-offset-background" : "";
  const reducedRing = reducedPct != null && mode !== "silenced" ? "ring-1 ring-amber-400/50" : "";

  function commitPct() {
    const v = parseInt(pctInput, 10);
    if (!isNaN(v) && v >= 1 && v <= 99) {
      onSetReducedPct(utcHour, v);
    }
    setEditingPct(false);
    setPctInput("");
  }

  return (
    <div
      className={`
        group relative flex flex-col rounded-lg sm:rounded-xl border select-none
        transition-all duration-150
        ${tierStyles[tier]} ${silencedOverlay} ${currentRing} ${reducedRing}
      `}
    >
      {/* Per-dow calendar badge */}
      {hasDowBadge && (
        <div className="absolute top-0.5 right-0.5 sm:top-1 sm:right-1 z-10">
          <Calendar className="w-2 h-2 sm:w-2.5 sm:h-2.5 text-sky-400/80" />
        </div>
      )}

      {/* Main clickable area — toggles silence */}
      <div
        className="flex flex-col gap-0.5 sm:gap-1 p-1.5 sm:p-3 cursor-pointer hover:brightness-125 active:scale-[0.97]"
        onClick={() => onToggleSilence(utcHour)}
        title={`${estLabel} ${ET_LABEL} (UTC ${String(utcHour).padStart(2, "0")}:00)\nClick to ${mode === "silenced" ? "activate" : "silence"}`}
      >
        {/* Row 1: hour label + mode icon */}
        <div className="flex items-center justify-between gap-0.5">
          <span className="text-[9px] sm:text-[11px] font-semibold text-foreground/80 leading-none tracking-wide">
            {estLabel}
          </span>
          <span className="flex items-center">
            {mode === "silenced" && <VolumeX className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-slate-400" />}
            {mode !== "silenced" && reducedPct != null && <TrendingDown className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-amber-400" />}
            {mode !== "silenced" && reducedPct == null && <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${dotColor[tier]}`} />}
          </span>
        </div>

        {/* Row 2: win rate */}
        <div className={`text-[13px] sm:text-[18px] font-bold leading-tight ${winRateColor[tier]}`}>
          {totalBets === 0 ? (
            <span className="text-[10px] sm:text-[13px] text-muted-foreground/30 font-normal">—</span>
          ) : winRatePct !== null ? (
            `${winRatePct.toFixed(0)}%`
          ) : (
            <span className="text-[10px] sm:text-[13px] text-muted-foreground/30 font-normal">—</span>
          )}
        </div>

        {/* Row 3: bets + P&L — hidden on mobile */}
        {totalBets > 0 && (
          <div className="hidden sm:flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/60 leading-none">{totalBets}b</span>
            <span className={`text-[10px] font-medium leading-none ${totalPnl >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}
            </span>
          </div>
        )}
      </div>

      {/* Reduced-% control — only when not silenced */}
      {mode !== "silenced" && (
        <div className="px-1.5 pb-1.5 sm:px-2 sm:pb-2 -mt-0.5" onClick={e => e.stopPropagation()}>
          {editingPct ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                type="number"
                min={1}
                max={99}
                step={5}
                value={pctInput}
                placeholder="30"
                onChange={e => setPctInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") commitPct(); if (e.key === "Escape") { setEditingPct(false); setPctInput(""); } }}
                onBlur={commitPct}
                className="w-full text-[10px] rounded px-1.5 py-0.5 bg-background/80 border border-amber-400/50 text-amber-300 outline-none focus:ring-1 focus:ring-amber-400/60 placeholder:text-amber-300/30"
              />
              <span className="text-[9px] text-amber-300/60 shrink-0">%</span>
            </div>
          ) : reducedPct != null ? (
            <div className="flex items-center gap-0.5 justify-between">
              <button
                onClick={() => { setPctInput(String(reducedPct)); setEditingPct(true); }}
                className="text-[9px] sm:text-[10px] text-amber-400 bg-amber-400/10 rounded px-1 py-0.5 hover:bg-amber-400/20 transition-colors leading-none font-medium"
              >
                –{reducedPct}%
              </button>
              <button
                onClick={() => onClearReducedPct(utcHour)}
                className="text-slate-500 hover:text-slate-300 transition-colors"
                title="Remove reduction"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setPctInput(""); setEditingPct(true); }}
              className="text-[9px] text-muted-foreground/30 hover:text-amber-400/60 transition-colors leading-none"
              title="Set reduced bet %"
            >
              +reduce
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAgo(isoStr: string): string {
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── Main component ────────────────────────────────────────────────────────────

interface QuietHoursGridProps {
  value: QuietHoursV2;
  onChange: (v: QuietHoursV2) => void;
  autoTuneLastRunAt?: string | null;
  autoTuneLastChanges?: { silenced: number[]; unsilenced: number[] } | null;
}

const ROW_LABELS = [
  { range: "12 AM – 7 AM", sublabel: "UTC 00–07" },
  { range: "8 AM – 3 PM",  sublabel: "UTC 08–15" },
  { range: "4 PM – 11 PM", sublabel: "UTC 16–23" },
];

export function QuietHoursGrid({ value, onChange, autoTuneLastRunAt, autoTuneLastChanges }: QuietHoursGridProps) {
  const { getToken } = useAuth();
  const [analysis, setAnalysis] = useState<QuietHoursAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(14);
  const [targetWinRate, setTargetWinRate] = useState(85);
  const [error, setError] = useState<string | null>(null);
  // Selected DOW tab: null = "All", 0–6 = specific day (JS getUTCDay)
  const [selectedDow, setSelectedDow] = useState<number | null>(null);

  const currentUtcHour = new Date().getUTCHours();

  async function fetchAnalysis(forDow: number | null = selectedDow) {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const dowParam = forDow != null ? `&dow=${forDow}` : "";
      const resp = await fetch(
        `${API_BASE}/crypto/bot/quiet-hours-analysis?days=${days}&targetWinRate=${targetWinRate}${dowParam}`,
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

  // Get the hour stats appropriate for the currently selected tab
  function getActiveHourStats(): QuietHoursHourStat[] {
    if (!analysis) return [];
    if (selectedDow != null && analysis.hourStatsByDow?.[String(selectedDow)]) {
      return analysis.hourStatsByDow[String(selectedDow)];
    }
    return analysis.hourStats;
  }

  // Apply suggested hours to the correct config layer
  function applySuggested() {
    if (!analysis) return;
    if (selectedDow == null) {
      onChange({ ...value, silencedUtcHours: analysis.suggestedSilencedHours });
    } else {
      const dowStr = String(selectedDow);
      const newSilencedByDow = { ...(value.silencedByDow ?? {}), [dowStr]: analysis.suggestedSilencedHours };
      onChange({ ...value, silencedByDow: newSilencedByDow });
    }
  }

  // ── Toggle silence for "All" tab ──────────────────────────────────────────
  // Simple 2-state toggle on the flat silencedUtcHours list.
  function toggleSilenceFlat(h: number) {
    const isSilenced = value.silencedUtcHours.includes(h);
    if (isSilenced) {
      onChange({ ...value, silencedUtcHours: value.silencedUtcHours.filter(x => x !== h) });
    } else {
      onChange({ ...value, silencedUtcHours: [...value.silencedUtcHours, h] });
    }
  }

  // ── Toggle silence for a DOW tab ─────────────────────────────────────────
  // Uses the visual mode (hourMode) as source of truth.
  // Un-silencing removes from BOTH flat and DOW lists so the cell becomes
  // fully active regardless of where the rule originally came from.
  // Silencing adds a DOW-specific entry so other days are not affected.
  function toggleSilenceDow(h: number, dow: number) {
    const dowStr = String(dow);
    const visual = hourMode(h, value, dow);

    if (visual === "silenced") {
      // Remove from flat silenced list + from this DOW's silenced list
      const newFlatSilenced   = value.silencedUtcHours.filter(x => x !== h);
      const dowSilenced       = value.silencedByDow?.[dowStr] ?? [];
      const newDowSilenced    = dowSilenced.filter(x => x !== h);
      const newSilencedByDow  = { ...(value.silencedByDow ?? {}), [dowStr]: newDowSilenced };
      onChange({ ...value, silencedUtcHours: newFlatSilenced, silencedByDow: newSilencedByDow });
    } else {
      // Active or reduced → add DOW-specific silence
      const dowSilenced = value.silencedByDow?.[dowStr] ?? [];
      if (!dowSilenced.includes(h)) {
        const newSilencedByDow = { ...(value.silencedByDow ?? {}), [dowStr]: [...dowSilenced, h] };
        onChange({ ...value, silencedByDow: newSilencedByDow });
      }
    }
  }

  function toggleSilence(h: number) {
    if (selectedDow == null) toggleSilenceFlat(h);
    else toggleSilenceDow(h, selectedDow);
  }

  // ── Reduced-% controls ────────────────────────────────────────────────────
  function setReducedPct(h: number, pct: number) {
    if (selectedDow == null) {
      onChange({ ...value, reducedBetUtcHours: { ...value.reducedBetUtcHours, [String(h)]: pct } });
    } else {
      const dowStr = String(selectedDow);
      const existing = value.reducedByDow?.[dowStr] ?? {};
      const newReducedByDow = { ...(value.reducedByDow ?? {}), [dowStr]: { ...existing, [String(h)]: pct } };
      onChange({ ...value, reducedByDow: newReducedByDow });
    }
  }

  function clearReducedPct(h: number) {
    if (selectedDow == null) {
      const { [String(h)]: _, ...rest } = value.reducedBetUtcHours;
      onChange({ ...value, reducedBetUtcHours: rest });
    } else {
      const dowStr = String(selectedDow);
      const existing = value.reducedByDow?.[dowStr] ?? {};
      const { [String(h)]: _, ...rest } = existing;
      const newReducedByDow = { ...(value.reducedByDow ?? {}), [dowStr]: rest };
      onChange({ ...value, reducedByDow: newReducedByDow });
    }
  }

  function handleTabChange(dow: number | null) {
    setSelectedDow(dow);
  }

  const activeHourStats = getActiveHourStats();
  const silencedCount = value.silencedUtcHours.length;
  const reducedCount = Object.keys(value.reducedBetUtcHours).length;

  const dowExtraCounts = DOW_TABS
    .filter(t => t.dow != null)
    .map(t => ({ label: t.label, dow: t.dow!, extra: countDowExtra(value, t.dow!) }))
    .filter(x => x.extra > 0);

  const rows = [
    Array.from({ length: 8 }, (_, i) => i),
    Array.from({ length: 8 }, (_, i) => i + 8),
    Array.from({ length: 8 }, (_, i) => i + 16),
  ];

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-sm font-semibold text-foreground">Smart Quiet Hours</span>
          {value.enabled && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {silencedCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400 border border-slate-500/20">
                  <VolumeX className="w-3 h-3" /> {silencedCount} silenced all days
                </span>
              )}
              {reducedCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <TrendingDown className="w-3 h-3" /> {reducedCount} reduced all days
                </span>
              )}
              {dowExtraCounts.map(({ label, extra }) => (
                <span key={label} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  <Calendar className="w-2.5 h-2.5" /> {label} +{extra}
                </span>
              ))}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <span className="text-xs text-muted-foreground">Enabled</span>
          <div
            className={`w-9 h-5 rounded-full transition-colors relative ${value.enabled ? "bg-cyan-500" : "bg-muted"}`}
            onClick={() => onChange({ ...value, enabled: !value.enabled })}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${value.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
          </div>
        </label>
      </div>

      {/* ── Day-of-week tabs ── */}
      <div className="flex items-center gap-0.5 sm:gap-1 flex-wrap">
        {DOW_TABS.map(tab => {
          const isActive = selectedDow === tab.dow;
          const dowExtra = tab.dow != null ? countDowExtra(value, tab.dow) : 0;
          return (
            <button
              key={tab.label}
              onClick={() => handleTabChange(tab.dow)}
              className={`relative text-[10px] sm:text-[11px] px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md transition-colors font-medium ${
                isActive
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30 border border-transparent"
              }`}
            >
              {tab.label}
              {dowExtra > 0 && (
                <span className="ml-1 text-[9px] text-sky-400">+{dowExtra}</span>
              )}
            </button>
          );
        })}
        {selectedDow != null && (
          <span className="hidden sm:inline ml-2 text-[11px] text-muted-foreground/50">
            {DOW_NAMES[selectedDow]} data · tap to silence/activate per-day
          </span>
        )}
      </div>
      {/* Mobile-only tab hint */}
      {selectedDow != null && (
        <p className="sm:hidden text-[10px] text-muted-foreground/50 -mt-2">
          {DOW_NAMES[selectedDow]} · tap cell to silence/activate for this day only
        </p>
      )}

      {/* ── Legend ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" /> ≥85% win rate</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" /> 75–84%</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0" /> &lt;75%</span>
        <span className="flex items-center gap-1.5"><VolumeX className="w-3 h-3 text-slate-400 shrink-0" /> Silenced (tap to toggle)</span>
        <span className="flex items-center gap-1.5"><TrendingDown className="w-3 h-3 text-amber-400 shrink-0" /> Reduced</span>
        {selectedDow != null && (
          <span className="flex items-center gap-1.5"><Calendar className="w-3 h-3 text-sky-400 shrink-0" /> Day-specific rule</span>
        )}
      </div>

      {/* ── Grid: 3 rows of 8 (desktop) / 4 cols wrapping (mobile) ── */}
      <div className="flex flex-col gap-2 sm:gap-3">
        {rows.map((rowHours, rowIdx) => (
          <div key={rowIdx} className="flex items-start gap-2 sm:gap-3">
            {/* Row label */}
            <div className="flex flex-col items-end justify-center shrink-0 pt-2 sm:pt-3 w-12 sm:w-20">
              <span className="text-[9px] sm:text-[11px] font-medium text-foreground/60 text-right leading-tight">
                {ROW_LABELS[rowIdx].range}
                <span className="hidden sm:inline"> {ET_LABEL}</span>
              </span>
              <span className="hidden sm:block text-[9px] text-muted-foreground/40 text-right mt-0.5">
                {ROW_LABELS[rowIdx].sublabel}
              </span>
            </div>
            {/* 4 cols on mobile, 8 on sm+ */}
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-1 sm:gap-2 flex-1">
              {rowHours.map(h => {
                const stat = activeHourStats.find(s => s.utcHour === h);
                const reducedPct = effectiveReducedPct(h, value, selectedDow);
                return (
                  <HourCell
                    key={h}
                    utcHour={h}
                    mode={hourMode(h, value, selectedDow)}
                    hasDowBadge={hasDowOverride(h, value, selectedDow)}
                    winRatePct={stat?.winRatePct ?? null}
                    totalBets={stat?.totalBets ?? 0}
                    totalPnl={stat?.totalPnl ?? 0}
                    reducedPct={reducedPct}
                    isCurrentHour={h === currentUtcHour}
                    onToggleSilence={toggleSilence}
                    onSetReducedPct={setReducedPct}
                    onClearReducedPct={clearReducedPct}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Auto-tune ── */}
      <div className="flex flex-col gap-2 pt-3 border-t border-border/50">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <div
              className={`w-8 h-4 rounded-full relative transition-colors ${value.autoTuneEnabled ? "bg-cyan-500" : "bg-muted"}`}
              onClick={() => onChange({ ...value, autoTuneEnabled: !value.autoTuneEnabled })}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${value.autoTuneEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
            </div>
            <span className="text-xs font-medium text-foreground/80 flex items-center gap-1.5">
              <RefreshCw className="w-3 h-3 text-cyan-400" />
              Auto-tune
            </span>
          </label>

          {value.autoTuneEnabled && (
            <>
              {/* Interval */}
              <label className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Every</span>
                <select
                  className="bg-background border border-border rounded-md px-2 py-0.5 text-[11px] text-foreground"
                  value={value.autoTuneIntervalHours ?? 2}
                  onChange={e => onChange({ ...value, autoTuneIntervalHours: parseInt(e.target.value, 10) })}
                >
                  {[1, 2, 4, 6, 12].map(h => <option key={h} value={h}>{h}h</option>)}
                </select>
              </label>

              {/* History */}
              <label className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">History</span>
                <select
                  className="bg-background border border-border rounded-md px-2 py-0.5 text-[11px] text-foreground"
                  value={value.autoTuneDays ?? 14}
                  onChange={e => onChange({ ...value, autoTuneDays: parseInt(e.target.value, 10) })}
                >
                  {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>{d}d</option>)}
                </select>
              </label>

              {/* Threshold */}
              <label className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Silence below</span>
                <select
                  className="bg-background border border-border rounded-md px-2 py-0.5 text-[11px] text-foreground"
                  value={value.autoTuneThreshold ?? 84.5}
                  onChange={e => onChange({ ...value, autoTuneThreshold: parseFloat(e.target.value) })}
                >
                  {[80, 82.5, 84.5, 85, 87.5, 90].map(t => (
                    <option key={t} value={t}>{t}% win rate</option>
                  ))}
                </select>
              </label>
            </>
          )}

          {/* Last-run status */}
          {autoTuneLastRunAt && (
            <span className="text-[11px] text-muted-foreground/60 ml-auto flex items-center gap-1.5">
              Last run {formatAgo(autoTuneLastRunAt)}
              {autoTuneLastChanges && (autoTuneLastChanges.silenced.length > 0 || autoTuneLastChanges.unsilenced.length > 0) ? (
                <span className="text-amber-400">
                  · silenced {autoTuneLastChanges.silenced.length}, unsilenced {autoTuneLastChanges.unsilenced.length}
                </span>
              ) : (
                <span className="text-emerald-400/70">· no changes</span>
              )}
            </span>
          )}
        </div>
        {value.autoTuneEnabled && (
          <p className="text-[10px] text-muted-foreground/50 leading-snug">
            Runs every {value.autoTuneIntervalHours ?? 2}h. Silences hours with &lt;{value.autoTuneThreshold ?? 84.5}% win rate (≥5 bets) and unsilences hours that recover above it.
          </p>
        )}
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
          onClick={() => fetchAnalysis(selectedDow)}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border border-sky-500/40 text-sky-400 hover:bg-sky-500/10 disabled:opacity-50 transition-colors"
        >
          <BarChart2 className={`w-3.5 h-3.5 ${loading ? "animate-pulse" : ""}`} />
          {loading ? "Loading…" : selectedDow != null ? `Analyze ${DOW_NAMES[selectedDow]}` : "Analyze"}
        </button>

        {analysis && (
          <button
            onClick={applySuggested}
            className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border border-amber-500/50 bg-amber-500/5 text-amber-400 hover:bg-amber-500/15 transition-colors font-medium"
            title={`Auto-silence ${analysis.suggestedSilencedHours.length} hour${analysis.suggestedSilencedHours.length !== 1 ? "s" : ""}${selectedDow != null ? ` on ${DOW_NAMES[selectedDow]} only` : ""} below ${targetWinRate}% win rate`}
          >
            <Zap className="w-3.5 h-3.5" />
            Apply suggested ({analysis.suggestedSilencedHours.length} hour{analysis.suggestedSilencedHours.length !== 1 ? "s" : ""})
            {selectedDow != null && <span className="ml-1 opacity-70">{DOW_NAMES[selectedDow]} only</span>}
          </button>
        )}

        {error && <span className="text-xs text-red-400">{error}</span>}

        {analysis && !error && (
          <span className="text-[11px] text-muted-foreground/60 ml-auto self-center">
            {analysis.days}d
            {selectedDow != null ? ` · ${DOW_NAMES[selectedDow]}` : ""}
            {" · "}{(activeHourStats.reduce((s, h) => s + h.totalBets, 0)).toLocaleString()} live bets
          </span>
        )}
      </div>
    </div>
  );
}

const DOW_TABS: { label: string; dow: number | null; apiDow: string }[] = [
  { label: "All",  dow: null, apiDow: "all" },
  { label: "Mon",  dow: 1,    apiDow: "1" },
  { label: "Tue",  dow: 2,    apiDow: "2" },
  { label: "Wed",  dow: 3,    apiDow: "3" },
  { label: "Thu",  dow: 4,    apiDow: "4" },
  { label: "Fri",  dow: 5,    apiDow: "5" },
  { label: "Sat",  dow: 6,    apiDow: "6" },
  { label: "Sun",  dow: 0,    apiDow: "0" },
];

function countDowExtra(v2: QuietHoursV2, dow: number): number {
  const silencedDow = (v2.silencedByDow?.[String(dow)] ?? []).filter(
    h => !v2.silencedUtcHours.includes(h),
  );
  const reducedDow = Object.keys(v2.reducedByDow?.[String(dow)] ?? {}).filter(
    hk => v2.reducedBetUtcHours[hk] == null,
  );
  return silencedDow.length + reducedDow.length;
}

/** Effective reduced % for a given hour (DOW override takes precedence over flat). */
function effectiveReducedPct(h: number, v2: QuietHoursV2, dow: number | null): number | undefined {
  if (dow != null) {
    const dowVal = v2.reducedByDow?.[String(dow)]?.[String(h)];
    if (dowVal != null) return dowVal;
  }
  return v2.reducedBetUtcHours[String(h)];
}

const DOW_NAMES: Record<number, string> = {
  0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat",
};
