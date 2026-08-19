import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/react";
import { BarChart2, VolumeX, TrendingDown, Zap, RefreshCw, Calendar, X, Check, AlertCircle, DollarSign } from "lucide-react";
import type { QuietHoursV2, QuietHoursAnalysis, QuietHoursHourStat } from "./types";
import { utcToEst, ET_LABEL, API_BASE, getEtUtcOffset } from "./utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function winRateTier(wr: number | null, totalBets: number): "good" | "ok" | "bad" | "empty" {
  if (wr === null || totalBets === 0) return "empty";
  if (wr >= 85) return "good";
  if (wr >= 75) return "ok";
  return "bad";
}

/**
 * Effective mode for a given hour on a specific day.
 * Mirrors the bot loop enforcement exactly:
 *   - If silencedByDow has an entry for this day, use it exclusively (ignore flat list).
 *   - Otherwise fall back to silencedUtcHours (flat).
 * Same logic for reduced bets.
 */
function hourMode(h: number, v2: QuietHoursV2, dow: number): "silenced" | "reduced" | "active" {
  const dowStr = String(dow);

  // ── Silence check ──
  const hasDowSilence = v2.silencedByDow != null && dowStr in v2.silencedByDow;
  const isSilenced = hasDowSilence
    ? (v2.silencedByDow![dowStr] ?? []).includes(h)
    : v2.silencedUtcHours.includes(h);
  if (isSilenced) return "silenced";

  // ── Reduced check ──
  const hasDowReduced = v2.reducedByDow != null && dowStr in v2.reducedByDow;
  const dgOverride = v2.dataGatheringOverrides?.[dowStr]?.[String(h)];
  const isReduced = (hasDowReduced
    ? v2.reducedByDow![dowStr]?.[String(h)] != null
    : v2.reducedBetUtcHours[String(h)] != null)
    || dgOverride?.type === "percent";
  if (isReduced) return "reduced";

  return "active";
}

/** Returns true when the hour is in the data-gathering list for this day (≤2 bets). */
function isDataGatheringHour(h: number, v2: QuietHoursV2, dow: number): boolean {
  const dgHours = v2.dataGatheringByDow?.[String(dow)];
  return Array.isArray(dgHours) && dgHours.includes(h);
}

/** Returns true when this day has its own per-dow entry (so a calendar badge appears). */
function hasDowEntry(v2: QuietHoursV2, dow: number): boolean {
  const dowStr = String(dow);
  const hasSilence = v2.silencedByDow != null && dowStr in v2.silencedByDow;
  const hasReduced = v2.reducedByDow != null && dowStr in v2.reducedByDow;
  return hasSilence || hasReduced;
}

/** Effective reduced % for a given hour. DOW-first, flat fallback. */
function effectiveReducedPct(h: number, v2: QuietHoursV2, dow: number): number | undefined {
  const dowStr = String(dow);
  const hasDowReduced = v2.reducedByDow != null && dowStr in v2.reducedByDow;
  const configured = hasDowReduced
    ? v2.reducedByDow![dowStr]?.[String(h)]
    : v2.reducedBetUtcHours[String(h)];
  if (configured != null) return configured;
  const override = v2.dataGatheringOverrides?.[dowStr]?.[String(h)];
  return override?.type === "percent" ? override.pct : undefined;
}

/** Count silenced + reduced hours configured for a specific day. */
function countDaySilenced(v2: QuietHoursV2, dow: number): number {
  const dowStr = String(dow);
  const hasDow = v2.silencedByDow != null && dowStr in v2.silencedByDow;
  return hasDow ? (v2.silencedByDow![dowStr] ?? []).length : v2.silencedUtcHours.length;
}

type DGCellOverride = { type: 'dollar'; amount: number } | { type: 'percent'; pct: number };

interface HourCellProps {
  utcHour: number;
  mode: "silenced" | "reduced" | "active";
  winRatePct: number | null;
  totalBets: number;
  wins: number;
  losses: number;
  totalPnl: number;
  reducedPct: number | undefined;
  isCurrentHour: boolean;
  isDataGathering?: boolean;
  dgCap?: number;
  dgOverride?: DGCellOverride;
  onToggleSilence: (h: number) => void;
  onSetReducedPct: (h: number, pct: number) => void;
  onClearReducedPct: (h: number) => void;
  onSetDgOverride: (h: number, override: DGCellOverride) => void;
  onClearDgOverride: (h: number) => void;
}

function HourCell({
  utcHour,
  mode,
  winRatePct,
  totalBets,
  wins,
  losses,
  totalPnl,
  reducedPct,
  isCurrentHour,
  isDataGathering = false,
  dgCap = 1,
  dgOverride,
  onToggleSilence,
  onSetReducedPct,
  onClearReducedPct,
  onSetDgOverride,
  onClearDgOverride,
}: HourCellProps) {
  const [editingPct, setEditingPct] = useState(false);
  const [pctInput, setPctInput] = useState("");
  const [editingDg, setEditingDg] = useState(false);
  const [dgDollarInput, setDgDollarInput] = useState("");

  const estHour = utcToEst(utcHour);
  const h12 = estHour % 12 || 12;
  const ampm = estHour < 12 ? "AM" : "PM";
  const estLabel = `${h12}${ampm}`;
  const tier = winRateTier(winRatePct, totalBets);

  const tierStyles: Record<string, string> = {
    good:  "bg-emerald-500/10 border-emerald-500/25",
    ok:    "bg-amber-500/10   border-amber-500/25",
    bad:   "bg-red-500/10     border-red-500/25",
    // No-data cells: subtle solid background so the silenced overlay is visible when toggled
    empty: "bg-muted/15 border-border/30",
  };
  const winRateColor: Record<string, string> = {
    good:  "text-emerald-300",
    ok:    "text-amber-300",
    bad:   "text-red-300",
    empty: "text-muted-foreground/30",
  };
  const dotColor: Record<string, string> = {
    good:  "bg-emerald-400",
    ok:    "bg-amber-400",
    bad:   "bg-red-400",
    empty: "", // no dot for empty cells
  };

  // Silenced cells: strong visual indicator (dark overlay + muted tones)
  const silencedOverlay = mode === "silenced" ? "opacity-50 saturate-0" : "";
  const currentRing = isCurrentHour ? "ring-2 ring-cyan-400/70 ring-offset-1 ring-offset-background" : "";
  const reducedRing = reducedPct != null && mode !== "silenced" ? "ring-1 ring-amber-400/50" : "";
  const dgIsPercent = dgOverride?.type === 'percent';
  const dgRing = isDataGathering && mode !== "silenced"
    ? (dgIsPercent ? "ring-1 ring-amber-400/50" : "ring-1 ring-violet-400/40")
    : "";

  // Preset bet percentages (% of regular bet to use)
  const PRESETS = [75, 50, 25];

  return (
    // DG cells open the override panel on click; other cells toggle silence
    <div
      onClick={() => {
        if (isDataGathering && mode !== "silenced") {
          setEditingDg(prev => !prev);
          setEditingPct(false);
        } else {
          onToggleSilence(utcHour);
        }
      }}
      className={`cursor-pointer relative flex flex-col gap-0.5 rounded-lg border px-1.5 py-1.5 transition-all select-none ${tierStyles[tier]} ${silencedOverlay} ${currentRing} ${reducedRing} ${dgRing}`}
    >
      {/* Top row: time label + mode icon + dot */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[9px] sm:text-[10px] font-mono text-foreground/70 leading-none shrink-0">{estLabel}</span>
          {mode === "silenced" && <VolumeX className="w-2.5 h-2.5 text-slate-400 shrink-0" />}
          {mode === "reduced" && <TrendingDown className="w-2.5 h-2.5 text-amber-400 shrink-0" />}
          {isDataGathering && mode !== "silenced" && (
            dgIsPercent ? (
              <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-500/15 px-1 py-px rounded leading-none border border-amber-500/30 shrink-0" title={`Data-gathering: ${dgOverride!.pct}% of regular bet`}>
                {(dgOverride as { type: 'percent'; pct: number }).pct}%
              </span>
            ) : (
              <span className="text-[10px] font-mono font-bold text-violet-400 bg-violet-500/15 px-1 py-px rounded leading-none border border-violet-500/30 shrink-0"
                title={`Sparse data — capped at $${dgOverride?.type === 'dollar' ? dgOverride.amount : dgCap}`}>
                ${dgOverride?.type === 'dollar' ? dgOverride.amount : dgCap}
              </span>
            )
          )}
        </div>
        {tier !== "empty" && (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor[tier]}`} />
        )}
      </div>

      {/* Win rate */}
      <div className={`text-[10px] sm:text-[11px] font-semibold leading-none ${winRateColor[tier]}`}>
        {winRatePct != null ? `${winRatePct}%` : "—"}
      </div>

      {/* Win / loss record */}
      <div className="text-[9px] leading-none">
        {totalBets > 0 ? (
          <span className="flex items-center gap-0.5">
            <span className="text-emerald-400/70">{wins}W</span>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-red-400/60">{losses}L</span>
            {totalPnl !== 0 && (
              <span className={`ml-0.5 ${totalPnl >= 0 ? "text-emerald-400/50" : "text-red-400/50"}`}>
                {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
              </span>
            )}
          </span>
        ) : (
          <span className="opacity-30">no data</span>
        )}
      </div>

      {/* DG override panel — shown when operator clicks a sparse-data cell */}
      {isDataGathering && mode !== "silenced" && editingDg && (
        <div className="mt-0.5" onClick={e => e.stopPropagation()}>
          <div className="flex flex-col gap-1">
            {/* Quick % buttons — picks percent of global bet, removes $ cap */}
            <div className="flex items-center gap-0.5 flex-wrap">
              <span className="text-[8px] text-muted-foreground/50 mr-0.5">%&nbsp;bet:</span>
              {[25, 50, 75, 100].map(p => (
                <button
                  key={p}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { onSetDgOverride(utcHour, { type: 'percent', pct: p }); setEditingDg(false); }}
                  className={`text-[9px] px-1 py-0.5 rounded leading-none border transition-colors ${dgOverride?.type === 'percent' && (dgOverride as { type: 'percent'; pct: number }).pct === p ? "bg-amber-500/30 text-amber-200 border-amber-400/50" : "bg-amber-500/15 text-amber-300 border-amber-500/25 hover:bg-amber-500/30"}`}
                >
                  {p}%
                </button>
              ))}
            </div>
            {/* Custom $ amount — overrides global cap for this cell only */}
            <div className="flex items-center gap-0.5">
              <span className="text-[8px] text-violet-400 font-bold">$</span>
              <input
                autoFocus
                type="number"
                min={0.5}
                max={50}
                step={0.5}
                className="w-12 text-[9px] bg-background border border-violet-500/40 rounded px-1 py-0.5 text-violet-300 focus:outline-none"
                value={dgDollarInput}
                placeholder={String(dgOverride?.type === 'dollar' ? (dgOverride as { type: 'dollar'; amount: number }).amount : dgCap)}
                onChange={e => setDgDollarInput(e.target.value)}
                onBlur={() => {
                  const v = parseFloat(dgDollarInput);
                  if (!isNaN(v) && v >= 0.5 && v <= 50) { onSetDgOverride(utcHour, { type: 'dollar', amount: v }); }
                  setEditingDg(false);
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const v = parseFloat(dgDollarInput);
                    if (!isNaN(v) && v >= 0.5 && v <= 50) { onSetDgOverride(utcHour, { type: 'dollar', amount: v }); }
                    setEditingDg(false);
                  }
                  if (e.key === "Escape") setEditingDg(false);
                }}
              />
              {dgOverride && (
                <button
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { onClearDgOverride(utcHour); setEditingDg(false); }}
                  className="text-[9px] text-muted-foreground/40 hover:text-red-400 transition-colors ml-0.5"
                  title="Reset to global cap"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
              <button
                onMouseDown={e => e.preventDefault()}
                onClick={() => setEditingDg(false)}
                className="text-[9px] text-muted-foreground/30 hover:text-muted-foreground transition-colors ml-auto"
              >
                <X className="w-2 h-2" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reduce section — stopPropagation so tapping here doesn't toggle the cell */}
      {mode !== "silenced" && !isDataGathering && (
        <div className="mt-0.5" onClick={e => e.stopPropagation()}>
          {editingPct ? (
            // Preset buttons + custom input (mobile-friendly)
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-0.5 flex-wrap">
                {PRESETS.map(p => (
                  <button
                    key={p}
                    onMouseDown={e => e.preventDefault()} // keep input focused so onBlur doesn't fire first
                    onClick={() => { onSetReducedPct(utcHour, p); setEditingPct(false); }}
                    className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 leading-none hover:bg-amber-500/35 transition-colors"
                  >
                    {p}%
                  </button>
                ))}
                <button
                  onClick={() => setEditingPct(false)}
                  className="text-[9px] text-muted-foreground/40 hover:text-red-400 transition-colors ml-auto"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
              <input
                autoFocus
                className="w-full text-[9px] bg-background border border-amber-500/40 rounded px-1 py-0.5 text-amber-300"
                value={pctInput}
                onChange={e => setPctInput(e.target.value)}
                onBlur={() => {
                  const v = parseInt(pctInput, 10);
                  if (!isNaN(v) && v >= 10 && v <= 99) onSetReducedPct(utcHour, v);
                  setEditingPct(false);
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const v = parseInt(pctInput, 10);
                    if (!isNaN(v) && v >= 10 && v <= 99) onSetReducedPct(utcHour, v);
                    setEditingPct(false);
                  }
                  if (e.key === "Escape") setEditingPct(false);
                }}
                placeholder="10–99"
              />
            </div>
          ) : reducedPct != null ? (
            // Show current % chip — tap to re-open picker
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => { setPctInput(String(reducedPct)); setEditingPct(true); }}
                className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 leading-none hover:bg-amber-500/25 transition-colors"
              >
                {reducedPct}% of bet
              </button>
              <button
                onClick={() => onClearReducedPct(utcHour)}
                className="text-[9px] text-muted-foreground/40 hover:text-red-400 transition-colors"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ) : (
            // No reduction set — tap to open picker
            <button
              onClick={() => { setPctInput(""); setEditingPct(true); }}
              className="text-[9px] text-muted-foreground/40 hover:text-amber-400 transition-colors leading-none"
            >
              +reduce
            </button>
          )}
        </div>
      )}
      {/* Hint for DG cells not in edit mode */}
      {isDataGathering && mode !== "silenced" && !editingDg && (
        <div className="mt-0.5">
          <span className="text-[8px] text-violet-400/50 leading-none">tap to set amount</span>
        </div>
      )}
    </div>
  );
}

const ROW_LABELS = [
  { range: "12a–8a",  sublabel: "(UTC 4–12)" },
  { range: "8a–4p",   sublabel: "(UTC 12–20)" },
  { range: "4p–12a",  sublabel: "(UTC 20–4)" },
];

function formatAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface QuietHoursGridProps {
  value: QuietHoursV2;
  onChange: (v: QuietHoursV2) => void;
  autoTuneLastRunAt?: string | null;
  autoTuneLastChanges?: { silenced: number[]; unsilenced: number[] } | null;
  /** When set, the win-rate analysis is filtered to this symbol's bets only. */
  symbolFilter?: string;
  /**
   * When provided, called after "Apply All Days" writes all 7 days of silenced
   * hours so the caller can immediately persist without a separate Save click.
   */
  onSave?: (updated: QuietHoursV2) => void;
  /** Dollar cap shown on cells in dataGatheringByDow (hours with ≤ 2 historical bets). */
  dgCap?: number;
}

export function QuietHoursGrid({ value, onChange, autoTuneLastRunAt, autoTuneLastChanges, symbolFilter, onSave, dgCap = 1 }: QuietHoursGridProps) {
  const { getToken } = useAuth();
  const [days, setDays] = useState(90); // match calibration window so all history is visible by default
  const [targetWinRate, setTargetWinRate] = useState(85);
  const [analysis, setAnalysis] = useState<QuietHoursAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // selectedDow defaults to today's ET day (not UTC day).
  // At 9:54 PM EDT Wednesday, getUTCDay() returns 4 (Thursday) because
  // it's already 1:54 AM UTC Thursday — but the user expects Wednesday's tab.
  const [selectedDow, setSelectedDow] = useState<number>(() => {
    const etMs = Date.now() - getEtUtcOffset() * 3_600_000;
    return new Date(etMs).getUTCDay();
  });

  // ── Auto-tune "Run now" state ─────────────────────────────────────────────
  const [atRunState, setAtRunState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [atRunError, setAtRunError] = useState<string | null>(null);

  const runAutoTuneNow = useCallback(async () => {
    setAtRunState("running");
    setAtRunError(null);
    try {
      const token = await getToken();
      const resp = await fetch(`${API_BASE}/crypto/bot/quiet-hours-auto-tune/run`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setAtRunState("done");
      // Re-fetch so the grid immediately reflects any silencing changes
      fetchAnalysis(selectedDow);
      setTimeout(() => setAtRunState("idle"), 4_000);
    } catch (e) {
      setAtRunError(e instanceof Error ? e.message : "Failed");
      setAtRunState("error");
      setTimeout(() => setAtRunState("idle"), 5_000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken, selectedDow]);

  const currentUtcHour = new Date().getUTCHours();

  // Auto-fetch analysis on mount and whenever the selected day changes.
  // This means win-rate data is always visible without needing a manual click.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchAnalysis(selectedDow); }, [selectedDow]);

  // ── Fetch analysis for a specific day ──────────────────────────────────────
  async function fetchAnalysis(forDow: number = selectedDow) {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const resp = await fetch(
        `${API_BASE}/crypto/bot/quiet-hours-analysis?days=${days}&targetWinRate=${targetWinRate}&dow=${forDow}${symbolFilter ? `&symbol=${encodeURIComponent(symbolFilter)}` : ""}`,
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

  // ── Active hour stats: always from the per-DOW breakdown ──────────────────
  function getActiveHourStats(): QuietHoursHourStat[] {
    if (!analysis) return [];
    // Use the per-day breakdown for the selected day
    const dowStats = analysis.hourStatsByDow?.[String(selectedDow)];
    if (dowStats) return dowStats;
    return analysis.hourStats; // fallback (should not happen when dow param is passed)
  }

  // ── Suggested hours: computed client-side from whatever is visible ─────────
  // Manual apply (user is reviewing data) — silences any red hour with ≥1 bet.
  // Auto-tune (unattended) uses a stricter ≥5 bet guard server-side.
  function computeSuggestedHours(stats: QuietHoursHourStat[]): number[] {
    return stats
      .filter(s => s.winRatePct !== null && s.winRatePct < targetWinRate && s.totalBets >= 1)
      .map(s => s.utcHour);
  }

  // ── Apply suggested to the selected day only and persist immediately ──────
  function applySuggested() {
    if (!analysis) return;
    const hours = computeSuggestedHours(getActiveHourStats());
    const dowStr = String(selectedDow);
    const newSilencedByDow = { ...(value.silencedByDow ?? {}), [dowStr]: hours };
    const updated = { ...value, silencedByDow: newSilencedByDow };
    onChange(updated);
    onSave?.(updated); // persist immediately — no manual Save click needed
  }

  // ── Toggle silence for the selected day only ──────────────────────────────
  // Always writes to silencedByDow; never touches the flat silencedUtcHours.
  // hourMode uses DOW-first logic (if DOW entry exists, use it; else flat fallback),
  // so once we write a DOW entry the flat list is no longer used for this day.
  function toggleSilence(h: number) {
    const dowStr = String(selectedDow);
    const visual = hourMode(h, value, selectedDow);

    const currentDow = value.silencedByDow?.[dowStr] ?? [];

    if (visual === "silenced") {
      // Un-silence: remove from this day's DOW list only
      const newDow = currentDow.filter(x => x !== h);
      const updated = { ...value, silencedByDow: { ...(value.silencedByDow ?? {}), [dowStr]: newDow } };
      onChange(updated);
      onSave?.(updated); // persist immediately — same as DG overrides
    } else {
      // Silence: add to this day's DOW list
      if (!currentDow.includes(h)) {
        const updated = { ...value, silencedByDow: { ...(value.silencedByDow ?? {}), [dowStr]: [...currentDow, h] } };
        onChange(updated);
        onSave?.(updated); // persist immediately — same as DG overrides
      }
    }
  }

  // ── Reduced-% controls (DOW-specific) ────────────────────────────────────
  function setReducedPct(h: number, pct: number) {
    const dowStr = String(selectedDow);
    const existing = value.reducedByDow?.[dowStr] ?? {};
    const dgForDay = value.dataGatheringOverrides?.[dowStr] ?? {};
    const { [String(h)]: existingDg, ...remainingDg } = dgForDay;
    const updated = {
      ...value,
      reducedByDow: {
        ...(value.reducedByDow ?? {}),
        [dowStr]: { ...existing, [String(h)]: pct },
      },
      ...(existingDg?.type === "percent"
        ? {
            dataGatheringOverrides: {
              ...(value.dataGatheringOverrides ?? {}),
              [dowStr]: remainingDg,
            },
          }
        : {}),
    };
    onChange(updated);
    onSave?.(updated); // persist immediately — same as DG overrides
  }

  function clearReducedPct(h: number) {
    const dowStr = String(selectedDow);
    const existing = value.reducedByDow?.[dowStr] ?? {};
    if (!(String(h) in existing)) {
      const dgOverride = getDgOverride(h);
      if (dgOverride?.type === "percent") {
        clearDgOverride(h);
        return;
      }
    }
    const { [String(h)]: _, ...rest } = existing;
    const updated = { ...value, reducedByDow: { ...(value.reducedByDow ?? {}), [dowStr]: rest } };
    onChange(updated);
    onSave?.(updated); // persist immediately — same as DG overrides
  }

  // ── Data-gathering per-cell override controls ─────────────────────────────
  function getDgOverride(h: number): DGCellOverride | undefined {
    return value.dataGatheringOverrides?.[String(selectedDow)]?.[String(h)];
  }

  function setDgOverride(h: number, override: DGCellOverride) {
    const dowStr = String(selectedDow);
    const existing = value.dataGatheringOverrides?.[dowStr] ?? {};
    const updated = {
      ...value,
      dataGatheringOverrides: {
        ...(value.dataGatheringOverrides ?? {}),
        [dowStr]: { ...existing, [String(h)]: override },
      },
    };
    onChange(updated);
    onSave?.(updated); // auto-save immediately — deliberate per-cell action
  }

  function clearDgOverride(h: number) {
    const dowStr = String(selectedDow);
    const existing = value.dataGatheringOverrides?.[dowStr] ?? {};
    const { [String(h)]: _, ...rest } = existing;
    const updated = {
      ...value,
      dataGatheringOverrides: {
        ...(value.dataGatheringOverrides ?? {}),
        [dowStr]: rest,
      },
    };
    onChange(updated);
    onSave?.(updated);
  }

  function handleTabChange(dow: number) {
    setSelectedDow(dow);
    setAnalysis(null); // clear stale analysis so apply-suggested cannot use wrong-day data
    setError(null);
  }

  const activeHourStats = getActiveHourStats();
  const suggestedHours  = computeSuggestedHours(activeHourStats);
  const silencedCount   = countDaySilenced(value, selectedDow);

  // Build UTC-hour arrays for each ET time band.
  // utcToEst converts UTC→ET, so ET hour X = UTC hour (X + etOffset) % 24.
  // Without this, UTC 0-7 renders as ET 8PM-3AM (EDT) — labelled as "12a-8a" — wrong.
  const etOffset = getEtUtcOffset(); // 4=EDT, 5=EST
  const rows = [
    Array.from({ length: 8 }, (_, i) => (i + etOffset) % 24),        // ET 12a–8a
    Array.from({ length: 8 }, (_, i) => (i + 8 + etOffset) % 24),    // ET 8a–4p
    Array.from({ length: 8 }, (_, i) => (i + 16 + etOffset) % 24),   // ET 4p–12a
  ];

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-sm font-semibold text-foreground">Smart Quiet Hours</span>
          {value.enabled && silencedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400 border border-slate-500/20">
              <VolumeX className="w-3 h-3" /> {silencedCount} silenced {DOW_NAMES[selectedDow]}
            </span>
          )}
          {value.enabled && hasDowEntry(value, selectedDow) && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Calendar className="w-2.5 h-2.5" /> per-day rules active
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0" title="When OFF, this coin's quiet-hour restrictions are bypassed and it can bet at any time">
          <span className="text-xs text-muted-foreground">Enforce hours</span>
          <div
            className={`w-9 h-5 rounded-full transition-colors relative ${value.enabled ? "bg-cyan-500" : "bg-muted"}`}
            onClick={() => {
              const updated = { ...value, enabled: !value.enabled };
              onChange(updated);
              onSave?.(updated); // persist immediately — no manual Save click needed
            }}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${value.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
          </div>
        </label>
      </div>

      {/* ── Day-of-week tabs ── */}
      <div className="flex items-center gap-0.5 sm:gap-1 flex-wrap">
        {DOW_TABS.map(tab => {
          const isActive = selectedDow === tab.dow;
          const silenced = countDaySilenced(value, tab.dow);
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
              {silenced > 0 && (
                <span className="ml-1 text-[9px] text-slate-400">{silenced}</span>
              )}
            </button>
          );
        })}
        <span className="hidden sm:inline ml-2 text-[11px] text-muted-foreground/50">
          {DOW_NAMES[selectedDow]} rules · tap a cell to silence/activate
        </span>
      </div>
      {/* Mobile-only tab hint */}
      <p className="sm:hidden text-[10px] text-muted-foreground/50 -mt-2">
        {DOW_NAMES[selectedDow]} · tap cell to silence/activate for this day only
      </p>

      {/* ── Legend ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" /> ≥85% win rate</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" /> 75–84%</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0" /> &lt;75%</span>
        <span className="flex items-center gap-1.5"><VolumeX className="w-3 h-3 text-slate-400 shrink-0" /> Silenced (tap to toggle)</span>
        <span className="flex items-center gap-1.5"><TrendingDown className="w-3 h-3 text-amber-400 shrink-0" /> Reduced bets</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-muted/30 border border-border/30 shrink-0" /> No data yet</span>
        <span className="flex items-center gap-1.5"><DollarSign className="w-3 h-3 text-violet-400 shrink-0" /> Sparse data (capped)</span>
      </div>

      {/* ── Grid: 3 rows of 8 ── */}
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
                    winRatePct={stat?.winRatePct ?? null}
                    totalBets={stat?.totalBets ?? 0}
                    wins={stat?.wins ?? 0}
                    losses={stat?.losses ?? 0}
                    totalPnl={stat?.totalPnl ?? 0}
                    reducedPct={reducedPct}
                    isCurrentHour={h === currentUtcHour}
                    isDataGathering={isDataGatheringHour(h, value, selectedDow)}
                    dgCap={dgCap}
                    dgOverride={getDgOverride(h)}
                    onToggleSilence={toggleSilence}
                    onSetReducedPct={setReducedPct}
                    onClearReducedPct={clearReducedPct}
                    onSetDgOverride={setDgOverride}
                    onClearDgOverride={clearDgOverride}
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
              className={`w-8 h-4 rounded-full relative transition-colors ${value.autoTuneEnabled !== false ? "bg-cyan-500" : "bg-muted"}`}
              onClick={() => onChange({ ...value, autoTuneEnabled: value.autoTuneEnabled === false })}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${value.autoTuneEnabled !== false ? "translate-x-4" : "translate-x-0.5"}`} />
            </div>
            <span className="text-xs font-medium text-foreground/80 flex items-center gap-1.5">
              <RefreshCw className="w-3 h-3 text-cyan-400" />
              Auto-tune
            </span>
          </label>

          {value.autoTuneEnabled !== false && (
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

          {/* Run now button */}
          {value.autoTuneEnabled !== false && (
            <button
              onClick={runAutoTuneNow}
              disabled={atRunState === "running"}
              className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md border transition-all ${
                atRunState === "done"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                  : atRunState === "error"
                  ? "border-red-500/50 bg-red-500/10 text-red-400"
                  : "border-slate-500/30 text-muted-foreground hover:text-foreground hover:border-slate-400/50 disabled:opacity-50"
              }`}
              title="Force-run auto-tune now, bypassing the interval timer"
            >
              {atRunState === "running" && <RefreshCw className="w-3 h-3 animate-spin" />}
              {atRunState === "done"    && <Check className="w-3 h-3" />}
              {atRunState === "error"   && <AlertCircle className="w-3 h-3" />}
              {atRunState === "idle"    && <RefreshCw className="w-3 h-3" />}
              {atRunState === "running" ? "Running…"
                : atRunState === "done" ? "Done"
                : atRunState === "error" ? (atRunError ?? "Error")
                : "Run now"}
            </button>
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
        {value.autoTuneEnabled !== false && (
          <p className="text-[10px] text-muted-foreground/50 leading-snug">
            Runs every {value.autoTuneIntervalHours ?? 2}h. Analyzes each day of the week separately using all bets (live + shadow paper). Silences hours below {value.autoTuneThreshold ?? 84.5}% win rate (≥5 bets) and unsilences hours that recover above it. Monday rules apply only on Mondays, etc.
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
          {loading ? "Loading…" : `Analyze ${DOW_NAMES[selectedDow]}`}
        </button>

        {analysis && suggestedHours.length > 0 && (
          /* Apply to the selected market + selected day only — saves immediately */
          <button
            onClick={applySuggested}
            className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border border-emerald-500/50 bg-emerald-500/5 text-emerald-400 hover:bg-emerald-500/15 transition-colors font-medium"
            title={`Silence ${suggestedHours.length} hour${suggestedHours.length !== 1 ? "s" : ""} on ${DOW_NAMES[selectedDow]} and save`}
          >
            <Zap className="w-3.5 h-3.5" />
            Apply {DOW_NAMES[selectedDow]} ({suggestedHours.length}h)
          </button>
        )}

        {error && <span className="text-xs text-red-400">{error}</span>}

        {analysis && !error && (
          <span className="text-[11px] text-muted-foreground/60 ml-auto self-center">
            {analysis.days}d · {DOW_NAMES[selectedDow]}
            {" · "}{(activeHourStats.reduce((s, h) => s + h.totalBets, 0)).toLocaleString()} bets
          </span>
        )}
      </div>
    </div>
  );
}

// Mon first, then Tue–Sat, Sun last
const DOW_TABS: { label: string; dow: number }[] = [
  { label: "Mon", dow: 1 },
  { label: "Tue", dow: 2 },
  { label: "Wed", dow: 3 },
  { label: "Thu", dow: 4 },
  { label: "Fri", dow: 5 },
  { label: "Sat", dow: 6 },
  { label: "Sun", dow: 0 },
];

const DOW_NAMES: Record<number, string> = {
  0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat",
};
