import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import type { TradingWindowsData, TradingWindowBucket } from "./types";
import { fetchJson } from "./utils";

const TRAINING_COIN_FILTERS = ["ALL", "BTC", "ETH", "XRP", "HYPE", "BNB", "DOGE"] as const;

type BarViewMode = "er" | "accuracy";

function bucketBarColor(b: TradingWindowBucket, mode: BarViewMode = "er"): string {
  if (mode === "accuracy") {
    const sparse = b.evaluatedCount < 5 || b.accuracyPct === null;
    if (sparse) return "bg-slate-600/40";
    const acc = b.accuracyPct!;
    if (acc >= 65) return "bg-emerald-500";
    if (acc >= 55) return "bg-emerald-400/60";
    if (acc >= 45) return "bg-amber-400";
    if (acc >= 35) return "bg-orange-500";
    return "bg-red-500";
  }
  if (b.sparse || b.avgEfficiencyRatio === null) return "bg-slate-600/40";
  const er = b.avgEfficiencyRatio;
  if (er >= 0.55) return "bg-emerald-500";
  if (er >= 0.40) return "bg-emerald-400/60";
  if (er >= 0.25) return "bg-amber-400";
  if (er >= 0.15) return "bg-orange-500";
  return "bg-red-500";
}

function bucketBarHeight(b: TradingWindowBucket, maxPx = 56, mode: BarViewMode = "er"): number {
  if (mode === "accuracy") {
    const sparse = b.evaluatedCount < 5 || b.accuracyPct === null;
    if (sparse) return 4;
    return Math.max(4, Math.round((b.accuracyPct! / 100) * maxPx));
  }
  if (b.sparse || b.avgEfficiencyRatio === null) return 4;
  return Math.max(4, Math.round(b.avgEfficiencyRatio * maxPx));
}

function HourlyBars({
  hourly,
  currentHour,
  showLabels,
  mode = "er",
}: {
  hourly: TradingWindowsData["hourly"];
  currentHour: number;
  showLabels: Set<number>;
  mode?: BarViewMode;
}) {
  return (
    <div className="flex gap-px items-end" style={{ height: "72px" }}>
      {hourly.map((b) => {
        const isCurrent = b.hour === currentHour;
        const accSparse = b.evaluatedCount < 5 || b.accuracyPct === null;
        const h = bucketBarHeight(b, 56, mode);
        const col = bucketBarColor(b, mode);
        const isSparse = accSparse || b.sparse;
        const tip = mode === "accuracy"
          ? (accSparse
              ? `${b.label} ET: ${b.evaluatedCount} evaluated (sparse — need 5+)`
              : `${b.label} ET: ${b.evaluatedCount} evaluated · accuracy ${b.accuracyPct}% · ER ${b.avgEfficiencyRatio?.toFixed(2) ?? "—"}`)
          : (b.sparse
              ? `${b.label} ET: ${b.count} samples (sparse — need 10+)`
              : `${b.label} ET: ${b.count} windows · ER ${b.avgEfficiencyRatio?.toFixed(2)} · ${b.trendingPct ?? "—"}% trending · accuracy ${b.accuracyPct !== null ? `${b.accuracyPct}%` : "—"}`);
        return (
          <div
            key={b.hour}
            className="flex-1 flex flex-col items-center justify-end gap-0.5"
            style={{ height: "72px" }}
          >
            <div
              className={`w-full rounded-t transition-all ${col} ${
                isCurrent ? "ring-2 ring-white/50 ring-offset-0" : ""
              } ${isSparse ? "border border-dashed border-slate-500/50" : ""}`}
              style={{ height: `${h}px` }}
              title={tip}
            />
            {showLabels.has(b.hour) && (
              <span
                className={`text-[7px] leading-none ${
                  isCurrent ? "text-white/80 font-bold" : "text-muted-foreground/40"
                }`}
              >
                {b.hour === 0 ? "12A" : b.hour === 12 ? "12P" : b.hour < 12 ? `${b.hour}A` : `${b.hour - 12}P`}
              </span>
            )}
            {!showLabels.has(b.hour) && isCurrent && (
              <span className="text-[7px] leading-none text-white/80 font-bold">
                {b.hour === 0 ? "12A" : b.hour === 12 ? "12P" : b.hour < 12 ? `${b.hour}A` : `${b.hour - 12}P`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const ET_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const DOW_FILTER_LABELS = ["All", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Sun=0…Sat=6 in JS Date, matching our DOW_LABELS on the server.
const DOW_FILTER_INDEX: Record<string, number | null> = {
  All: null, Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Re-score an hourly bucket array and return top-N best + worst. */
function scoreHourly(
  hourly: Array<TradingWindowBucket & { hour: number; label: string }>,
  n = 3,
): { best: typeof hourly; worst: typeof hourly } {
  const scored = hourly
    .filter((h) => !h.sparse && h.avgEfficiencyRatio !== null)
    .map((h) => ({
      ...h,
      score: ((h.accuracyPct ?? 50) / 100) * 0.4 + (h.avgEfficiencyRatio ?? 0) * 0.6,
    }))
    .sort((a, b) => b.score - a.score);
  return {
    best:  scored.slice(0, Math.min(n, scored.length)),
    worst: scored.slice(-Math.min(n, scored.length)).reverse(),
  };
}

export function TradingWindowsPanel({ currentEtHour }: { currentEtHour: number }) {
  const [coinFilter,   setCoinFilter]   = useState<string>("ALL");
  const [selectedDay,  setSelectedDay]  = useState<string>("All"); // "All" or "Sun"…"Sat"
  const [barMode,      setBarMode]      = useState<BarViewMode>("er");
  // Show hour labels every 3 hours so the axis is readable without crowding.
  const SHOW_LABELS = new Set([0, 3, 6, 9, 12, 15, 18, 21]);

  const query = useQuery({
    queryKey: ["trading-windows", coinFilter],
    queryFn: () =>
      fetchJson<TradingWindowsData>(
        coinFilter === "ALL"
          ? "/crypto/trading-windows"
          : `/crypto/trading-windows?symbol=${coinFilter}`,
      ),
    refetchInterval: 15 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data ?? null;
  const updatedLabel = data?.lastUpdatedAt
    ? `Updated ${ET_TIME_FMT.format(new Date(data.lastUpdatedAt))} ET`
    : null;

  const selectedDayIdx = DOW_FILTER_INDEX[selectedDay] ?? null;
  const activeHourly = selectedDayIdx !== null
    ? (data?.byDayHour?.[selectedDayIdx] ?? data?.hourly ?? [])
    : (data?.hourly ?? []);

  const { best: bestHours, worst: worstHours } = data
    ? scoreHourly(activeHourly)
    : { best: [], worst: [] };

  // Toggle: clicking the active day deselects back to "All".
  function handleDayClick(label: string) {
    setSelectedDay((prev) => (prev === label ? "All" : label));
  }

  const isSingleCoin = coinFilter !== "ALL";

  return (
    <div className="mt-6 space-y-3">

      {/* ── Section header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-2">
          <Clock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold">Best Windows to Trade</h3>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              When markets are most predictable
              {data ? ` · ${data.totalSamples} windows recorded` : ""}
              {isSingleCoin ? ` (${coinFilter} only)` : " across all training coins"}
            </p>
          </div>
        </div>
        {/* ER / Accuracy mode toggle */}
        <div className="flex shrink-0 rounded-lg overflow-hidden border border-border text-[10px] font-semibold">
          <button
            onClick={() => setBarMode("er")}
            className={`px-2.5 py-1 transition-colors ${
              barMode === "er"
                ? "bg-primary/20 text-primary"
                : "bg-muted/20 text-muted-foreground hover:bg-muted/40"
            }`}
          >
            Efficiency
          </button>
          <button
            onClick={() => setBarMode("accuracy")}
            className={`px-2.5 py-1 transition-colors ${
              barMode === "accuracy"
                ? "bg-primary/20 text-primary"
                : "bg-muted/20 text-muted-foreground hover:bg-muted/40"
            }`}
          >
            Accuracy %
          </button>
        </div>
      </div>

      {/* ── Coin filter pills ── */}
      <div className="flex gap-1.5 flex-wrap">
        {TRAINING_COIN_FILTERS.map((c) => (
          <button
            key={c}
            onClick={() => setCoinFilter(c)}
            className={`px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
              coinFilter === c
                ? "border-primary/60 bg-primary/15 text-primary"
                : "border-border bg-muted/20 text-muted-foreground hover:bg-muted/40"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* ── Loading / empty / full panel ── */}
      {query.isLoading && !data ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : !data ? null : !data.hasEnoughData ? (
        /* Collecting data */
        <Card className="bg-card/50 px-4 py-4 space-y-3">
          <div className="flex items-start gap-2">
            <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
            <div className="text-[11px] leading-snug">
              <span className="text-amber-300 font-semibold">Collecting data </span>
              <span className="text-muted-foreground">
                — needs more recorded windows to surface patterns.{" "}
                {data.totalSamples} recorded so far
                {isSingleCoin ? ` for ${coinFilter}` : ""}.
              </span>
            </div>
          </div>
          {data.totalSamples > 0 && (
            <div className="opacity-30 pointer-events-none">
              <HourlyBars hourly={activeHourly} currentHour={currentEtHour} showLabels={SHOW_LABELS} mode={barMode} />
            </div>
          )}
        </Card>
      ) : (
        /* ── Full panel ── */
        <Card className="bg-card/50 px-4 py-5 space-y-5">

          {/* Best / Avoid recommendation chips */}
          {(bestHours.length > 0 || worstHours.length > 0) && (
            <div className="flex gap-4 flex-wrap">
              {bestHours.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider shrink-0">
                    Best{selectedDay !== "All" ? ` (${selectedDay}s)` : ""}
                  </span>
                  {bestHours.map((h) => (
                    <span
                      key={h.hour}
                      className="inline-flex items-center rounded-lg px-2.5 py-1 text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                      title={`ER ${h.avgEfficiencyRatio?.toFixed(2)} · accuracy ${h.accuracyPct ?? "—"}% · ${h.count} windows`}
                    >
                      {h.label}
                    </span>
                  ))}
                </div>
              )}
              {worstHours.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider shrink-0">
                    Avoid{selectedDay !== "All" ? ` (${selectedDay}s)` : ""}
                  </span>
                  {worstHours.map((h) => (
                    <span
                      key={h.hour}
                      className="inline-flex items-center rounded-lg px-2.5 py-1 text-[11px] font-semibold bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
                      title={`ER ${h.avgEfficiencyRatio?.toFixed(2)} · accuracy ${h.accuracyPct ?? "—"}% · ${h.count} windows`}
                    >
                      {h.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 24-hour bar chart */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted-foreground/60 font-semibold uppercase tracking-wider">
              Hours of day (ET){selectedDay !== "All" ? ` · ${selectedDay}s only` : " · all days"}
              {" "}·{" "}
              {barMode === "er" ? "bar height = efficiency ratio" : "bar height = prediction accuracy"}
              {" · "}white ring = current hour
            </div>
            <HourlyBars hourly={activeHourly} currentHour={currentEtHour} showLabels={SHOW_LABELS} mode={barMode} />
          </div>

          {/* Day-of-week bars — always visible; clicking a day filters the hourly chart above */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/60 font-semibold uppercase tracking-wider">
                Day of week · click to filter
              </span>
              {selectedDay !== "All" && (
                <button
                  onClick={() => setSelectedDay("All")}
                  className="text-[10px] text-sky-400 hover:text-sky-300 transition-colors font-medium"
                >
                  ← show all days
                </button>
              )}
            </div>
            <div className="flex gap-2 items-end" style={{ height: "60px" }}>
              {data.daily.map((b) => {
                const dayLabel = DOW_FILTER_LABELS[b.dayIndex + 1];
                const isSelected = selectedDay === dayLabel;
                return (
                  <button
                    key={b.dayIndex}
                    onClick={() => handleDayClick(dayLabel)}
                    className="flex-1 flex flex-col items-center justify-end gap-1 group"
                    style={{ height: "60px" }}
                    title={
                      b.sparse
                        ? `${b.label}: ${b.count} samples (sparse)`
                        : `${b.label}: ER ${b.avgEfficiencyRatio?.toFixed(2)} · ${b.trendingPct ?? "—"}% trending · accuracy ${b.accuracyPct ?? "—"}%`
                    }
                  >
                    <div
                      className={`w-full rounded-t transition-all group-hover:opacity-80 ${bucketBarColor(b)} ${
                        isSelected ? "ring-2 ring-white/60 ring-offset-0" : ""
                      }`}
                      style={{ height: `${bucketBarHeight(b, 40)}px` }}
                    />
                    <span
                      className={`text-[9px] font-semibold transition-colors ${
                        isSelected
                          ? "text-white"
                          : "text-muted-foreground/50 group-hover:text-muted-foreground"
                      }`}
                    >
                      {b.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Legend + footer */}
          <div className="border-t border-border/30 pt-3 space-y-2">
            <div className="flex items-center gap-3 flex-wrap text-[9px] text-muted-foreground/60">
              {barMode === "er" ? (
                <>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />Trending (ER ≥ 0.55)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />Drifting (0.25–0.55)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />Choppy (&lt; 0.25)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-600/40 border border-dashed border-slate-500/60 inline-block" />Sparse (&lt; 10 samples)</span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />Strong (≥ 65%)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-400/60 inline-block" />Good (55–65%)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />Coin-flip (45–55%)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />Poor (&lt; 45%)</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-600/40 border border-dashed border-slate-500/60 inline-block" />Sparse (&lt; 5 evaluated)</span>
                </>
              )}
            </div>
            <div className="text-[9px] text-muted-foreground/40 flex items-center gap-2 flex-wrap">
              <span>{updatedLabel ?? "Updated every 15 min"}</span>
              <span>·</span>
              <span>hover a bar for details</span>
              <span>·</span>
              <span>{data.totalSamples} recorded windows</span>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prediction Accuracy Log — tracks 15-min boundary predictions vs actual
// ---------------------------------------------------------------------------
