import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from "recharts";
import { API_BASE, fmt$ } from "./utils";

interface HourlyBar {
  etHour: number;
  regularPnl: number;
  scalperPnl: number;
  totalPnl: number;
}

interface DailyHourlyPnlData {
  mode: "paper" | "live";
  timeZone: "America/New_York";
  dayStartAt: string;
  nextResetAt: string;
  hours: HourlyBar[];
}

function formatHour(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

interface TooltipPayload {
  payload?: { totalPnl: number; regularPnl: number; scalperPnl: number; label: string };
}

function HourTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const isPos = d.totalPnl >= 0;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-slate-200 mb-1">{d.label}</div>
      <div className={`font-bold text-sm ${isPos ? "text-emerald-400" : "text-red-400"}`}>
        {fmt$(d.totalPnl)}
      </div>
      {(d.regularPnl !== 0 || d.scalperPnl !== 0) && (
        <div className="mt-1 space-y-0.5 text-slate-400">
          {d.regularPnl !== 0 && <div>Bot: <span className={d.regularPnl >= 0 ? "text-emerald-400" : "text-red-400"}>{fmt$(d.regularPnl)}</span></div>}
          {d.scalperPnl !== 0 && <div>Scalper: <span className={d.scalperPnl >= 0 ? "text-emerald-400" : "text-red-400"}>{fmt$(d.scalperPnl)}</span></div>}
        </div>
      )}
    </div>
  );
}

export function DailyHourlyPnlChart({ mode }: { mode: "paper" | "live" }) {
  const [daysAgo, setDaysAgo] = useState(0);
  const selectedDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - daysAgo * 86_400_000));
  const { data, isLoading, isError } = useQuery<DailyHourlyPnlData>({
    queryKey: ["daily-hourly-pnl", mode, selectedDate],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/crypto/bot/daily-pnl-hourly?mode=${mode}&date=${selectedDate}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!r.ok) throw new Error("Failed to load hourly P&L");
      return r.json();
    },
    refetchInterval: daysAgo === 0 ? 15_000 : false,
    staleTime: 0,
  });

  const hasData = (data?.hours?.length ?? 0) > 0;

  // Build a full 24-bar array so the x-axis is always midnight→midnight.
  // Only hours with activity are returned from the API; fill the rest with 0.
  const bars: (HourlyBar & { label: string })[] = Array.from({ length: 24 }, (_, i) => {
    const found = data?.hours.find((h) => h.etHour === i);
    return {
      etHour: i,
      regularPnl: found?.regularPnl ?? 0,
      scalperPnl: found?.scalperPnl ?? 0,
      totalPnl: found?.totalPnl ?? 0,
      label: `${formatHour(i)} ET`,
    };
  });

  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.totalPnl)), 0.01);
  const yDomain = [-maxAbs * 1.25, maxAbs * 1.25];

  if (isLoading) {
    return (
      <div className="bg-slate-900/60 border border-slate-700/50 rounded-xl p-4 mb-4">
        <div className="h-36 flex items-center justify-center text-slate-500 text-sm animate-pulse">
          Loading hourly P&amp;L…
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-slate-900/60 border border-slate-700/50 rounded-xl p-4 mb-4">
        <div className="h-20 flex items-center justify-center text-red-400 text-sm">
          Unable to load hourly P&amp;L
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/60 border border-slate-700/50 rounded-xl p-4 mb-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Daily P&amp;L by Hour</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            {" · "}12 AM – 12 AM ET · {mode === "live" ? "Live" : "Paper"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button aria-label="Previous day" onClick={() => setDaysAgo(v => Math.min(29, v + 1))} disabled={daysAgo >= 29} className="rounded-md border border-slate-700 p-1.5 text-slate-300 disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-16 text-center text-xs font-medium text-slate-300">{daysAgo === 0 ? "Today" : `${daysAgo}d ago`}</span>
          <button aria-label="Next day" onClick={() => setDaysAgo(v => Math.max(0, v - 1))} disabled={daysAgo === 0} className="rounded-md border border-slate-700 p-1.5 text-slate-300 disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {hasData && (
          <div className="flex gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500 opacity-80" />
              Profit
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500 opacity-80" />
              Loss
            </span>
          </div>
        )}
      </div>

      {!hasData ? (
        <div className="h-32 flex items-center justify-center text-slate-500 text-sm">
          No settled bets on this date
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis
              dataKey="etHour"
              tickFormatter={formatHour}
              tick={{ fontSize: 10, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
              interval={2}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(v: number) => (v === 0 ? "$0" : fmt$(v))}
              tick={{ fontSize: 10, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
              width={46}
            />
            <Tooltip
              content={<HourTooltip />}
              cursor={{ fill: "rgba(148,163,184,0.06)" }}
            />
            <ReferenceLine y={0} stroke="#334155" strokeWidth={1} />
            <Bar dataKey="totalPnl" radius={[3, 3, 0, 0]} maxBarSize={24}>
              {bars.map((entry) => (
                <Cell
                  key={entry.etHour}
                  fill={
                    entry.totalPnl > 0
                      ? "#10b981"
                      : entry.totalPnl < 0
                        ? "#ef4444"
                        : "#334155"
                  }
                  fillOpacity={entry.totalPnl === 0 ? 0 : 0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
