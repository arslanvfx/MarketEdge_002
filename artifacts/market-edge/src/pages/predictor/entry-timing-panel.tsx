import { Timer, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import type { TimingAnalysisRow } from "./types";

interface EntryTimingPanelProps {
  open: boolean;
  onToggle: () => void;
  timingRows: TimingAnalysisRow[];
  timing7dRows: TimingAnalysisRow[];
  selected: string;
  isLoading: boolean;
}

export function EntryTimingPanel({ open, onToggle, timingRows, timing7dRows, selected, isLoading }: EntryTimingPanelProps) {
          const rows = timingRows;
          const rows7d = timing7dRows;
          const map7d = new Map(rows7d.map((r) => [r.minuteMark, r]));
          const windowsCollected = rows.length > 0 ? Math.max(...rows.map((r) => r.sampleCount)) : 0;
          const windows7dCollected = rows7d.length > 0 ? Math.max(...rows7d.map((r) => r.sampleCount)) : 0;
          const MIN_WINDOWS = 10;
          const collecting = windowsCollected < MIN_WINDOWS;
          const bestByEv = rows.reduce<TimingAnalysisRow | null>(
            (acc, r) => (r.ev !== null && (acc === null || (acc.ev ?? -Infinity) < r.ev) ? r : acc),
            null,
          );
          const bestByAcc = rows.reduce<TimingAnalysisRow | null>(
            (acc, r) => (r.accuracy !== null && (acc === null || (acc.accuracy ?? 0) < r.accuracy) ? r : acc),
            null,
          );
          const best = bestByEv ?? bestByAcc;
          const has7d = rows7d.length > 0 && windows7dCollected >= 3;
          if (rows.length === 0 && !isLoading) return null;
          return (
            <div className="mt-4 rounded-lg border border-purple-800/40 bg-purple-950/20 overflow-hidden">
              <button
                onClick={() => onToggle()}
                className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-purple-900/20 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Timer className="h-4 w-4 text-purple-400" />
                  <span className="text-sm font-semibold text-purple-300">Entry Timing Analysis</span>
                  {collecting ? (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-purple-900/40 text-purple-400">
                      Collecting data… ({windowsCollected}/{MIN_WINDOWS} windows)
                    </span>
                  ) : best !== null ? (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-purple-900/60 text-purple-200">
                      Best entry: ~{best.label} into window
                    </span>
                  ) : null}
                  {isLoading && (
                    <Loader2 className="h-3 w-3 animate-spin text-purple-400 ml-1" />
                  )}
                </div>
                {open ? (
                  <ChevronUp className="h-4 w-4 text-purple-400" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-purple-400" />
                )}
              </button>

              {open && (
                <div className="px-4 pb-4 pt-1">
                  <p className="text-xs text-purple-300/70 mb-3">
                    How often the price-vs-strike direction at each minute mark matched the final outcome. Higher accuracy and positive EV indicate a reliable entry signal for {selected}.
                  </p>
                  {collecting ? (
                    <p className="text-xs text-purple-300/50 italic">
                      Evaluating windows — {windowsCollected} of {MIN_WINDOWS} needed for reliable curves. Check back after a few more 15-minute windows close.
                    </p>
                  ) : rows.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">No evaluated windows yet.</p>
                  ) : (
                    <>
                      {best && (
                        <div className="mb-3 text-xs text-emerald-300/90 font-medium">
                          Best entry: ~{best.label} into the window
                          {best.accuracy !== null && ` (${Math.round(best.accuracy * 100)}% accurate`}
                          {best.ev !== null ? `, EV ${best.ev > 0 ? "+" : ""}${(best.ev * 100).toFixed(1)}%)` : best.accuracy !== null ? ")" : ""}
                        </div>
                      )}
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-purple-400/70 border-b border-purple-800/30">
                            <th className="text-left pb-1.5 font-medium">Minute</th>
                            <th className="text-right pb-1.5 font-medium">
                              {has7d ? "All-time %" : "Accuracy %"}
                            </th>
                            {has7d && (
                              <th className="text-right pb-1.5 font-medium">
                                <span className="text-sky-400">7-day %</span>
                              </th>
                            )}
                            {has7d && (
                              <th className="text-right pb-1.5 font-medium">
                                <span className="text-purple-400/70">Trend</span>
                              </th>
                            )}
                            <th className="text-right pb-1.5 font-medium">EV Score</th>
                            <th className="text-right pb-1.5 font-medium">n</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => {
                            const acc = row.accuracy ?? 0;
                            const pct = Math.round(acc * 100);
                            const isPositive = acc >= 0.55;
                            const isNegative = acc < 0.45;
                            const isBest = row.minuteMark === best?.minuteMark;
                            const evSign = row.ev !== null && row.ev > 0 ? "+" : "";
                            const row7 = map7d.get(row.minuteMark);
                            const acc7 = row7?.accuracy ?? null;
                            const pct7 = acc7 !== null ? Math.round(acc7 * 100) : null;
                            const isPositive7 = acc7 !== null && acc7 >= 0.55;
                            const isNegative7 = acc7 !== null && acc7 < 0.45;
                            const trendDiff = acc7 !== null ? Math.round((acc7 - acc) * 100) : null;
                            const trendUp = trendDiff !== null && trendDiff >= 3;
                            const trendDown = trendDiff !== null && trendDiff <= -3;
                            return (
                              <tr
                                key={row.minuteMark}
                                className={`border-b border-purple-900/20 last:border-0 ${isBest ? "bg-emerald-950/30" : ""}`}
                              >
                                <td className={`py-1.5 font-mono ${isBest ? "text-emerald-300 font-semibold" : "text-purple-200"}`}>
                                  {row.label}{isBest && " ★"}
                                </td>
                                <td className={`py-1.5 text-right font-semibold ${isPositive ? "text-emerald-400" : isNegative ? "text-red-400" : "text-yellow-400"}`}>
                                  {pct}%
                                </td>
                                {has7d && (
                                  <td className={`py-1.5 text-right font-semibold ${pct7 === null ? "text-gray-600" : isPositive7 ? "text-sky-400" : isNegative7 ? "text-red-400" : "text-yellow-400"}`}>
                                    {pct7 !== null ? `${pct7}%` : "—"}
                                  </td>
                                )}
                                {has7d && (
                                  <td className="py-1.5 text-right font-mono text-[11px]">
                                    {trendDiff === null ? (
                                      <span className="text-gray-600">—</span>
                                    ) : trendUp ? (
                                      <span className="text-emerald-400">↑{trendDiff}pp</span>
                                    ) : trendDown ? (
                                      <span className="text-red-400">↓{Math.abs(trendDiff)}pp</span>
                                    ) : (
                                      <span className="text-purple-400/50">≈</span>
                                    )}
                                  </td>
                                )}
                                <td className={`py-1.5 text-right ${row.ev === null ? "text-gray-600" : row.ev > 0 ? "text-emerald-400" : "text-red-400"}`}>
                                  {row.ev !== null ? `${evSign}${(row.ev * 100).toFixed(1)}%` : "—"}
                                </td>
                                <td className="py-1.5 text-right text-gray-500">{row.sampleCount}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <p className="text-xs text-purple-300/40 mt-2">
                        {has7d
                          ? `Trend column shows 7-day accuracy vs all-time (pp = percentage points). ↑ means recent windows are more accurate.`
                          : "EV requires Kalshi Yes price data (accumulates over time). Accuracy alone is useful for timing."}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          );

}
