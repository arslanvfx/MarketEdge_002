import { useState } from "react";
import { Timer, ChevronDown, ChevronUp } from "lucide-react";

export interface BotEntryTimingRow {
  coin: string | null;
  minuteMark: number;
  label: string;
  sampleCount: number;
  accuracy: number | null;
  avgYesPrice: number | null;
  avgTheoreticalReturn: number | null;
  pctAbove1_5x: number | null;
  ev: number | null;
}

interface Props {
  rows: BotEntryTimingRow[];
  isLoading: boolean;
}

const MIN_WINDOWS = 10;

function accColor(acc: number | null): string {
  if (acc === null) return "text-muted-foreground/40";
  if (acc >= 0.60) return "text-emerald-400";
  if (acc >= 0.52) return "text-sky-400";
  if (acc >= 0.45) return "text-yellow-400";
  return "text-red-400";
}

function retColor(ret: number | null): string {
  if (ret === null) return "text-muted-foreground/40";
  if (ret >= 1.8) return "text-emerald-400";
  if (ret >= 1.4) return "text-sky-400";
  if (ret >= 1.0) return "text-yellow-400";
  return "text-red-400";
}

function evColor(ev: number | null): string {
  if (ev === null) return "text-muted-foreground/40";
  if (ev > 0.05) return "text-emerald-400";
  if (ev > 0) return "text-sky-400";
  return "text-red-400";
}

export function BotEntryTimingPanel({ rows, isLoading }: Props) {
  const [open, setOpen] = useState(false);

  const coins = ["ALL", ...Array.from(new Set(rows.map(r => r.coin).filter(Boolean) as string[])).sort()];
  const [coin, setCoin] = useState("ALL");

  const filtered = coin === "ALL" ? rows : rows.filter(r => r.coin === coin);

  const windowsCollected = filtered.length > 0 ? Math.max(...filtered.map(r => r.sampleCount)) : 0;
  const collecting = windowsCollected < MIN_WINDOWS;

  const bestByEv = filtered.reduce<BotEntryTimingRow | null>((best, r) => {
    if (r.ev === null) return best;
    return best === null || r.ev > (best.ev ?? -Infinity) ? r : best;
  }, null);

  const bestByAcc = filtered.reduce<BotEntryTimingRow | null>((best, r) => {
    if (r.accuracy === null) return best;
    return best === null || r.accuracy > (best.accuracy ?? 0) ? r : best;
  }, null);

  const best = bestByEv ?? bestByAcc;

  if (rows.length === 0 && !isLoading) return null;

  return (
    <div className="min-w-0 bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full px-3 sm:px-5 py-3 border-b border-border flex flex-wrap items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <Timer className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm">Entry Timing Analytics</h2>
        <span className="ml-1 text-[10px] text-muted-foreground bg-violet-500/10 px-2 py-0.5 rounded-full">
          ML Gate accuracy per minute
        </span>
        {collecting && windowsCollected > 0 && (
          <span className="ml-1 text-[10px] text-amber-400/80 bg-amber-500/10 px-2 py-0.5 rounded-full">
            Collecting… {windowsCollected}/{MIN_WINDOWS} windows
          </span>
        )}
        {!collecting && best !== null && (
          <span className="ml-1 text-[10px] text-emerald-400/90 bg-emerald-500/10 px-2 py-0.5 rounded-full">
            Best: {best.label}
          </span>
        )}
        {open
          ? <ChevronUp className="w-4 h-4 ml-auto text-muted-foreground" />
          : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />
        }
      </button>

      {open && (
        <div className="p-3 sm:p-5 space-y-4">
          <p className="text-[10px] text-muted-foreground">
            At each minute (0–14) into the window, shows how often the composite ML Gate model direction matched the final outcome.
            Higher accuracy + higher theoretical return = optimal entry zone.
          </p>

          {/* Coin selector */}
          {coins.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {coins.map(c => (
                <button
                  key={c}
                  onClick={() => setCoin(c)}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-colors ${
                    coin === c
                      ? "bg-violet-500 text-white"
                      : "bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {collecting ? (
            <div className="text-[10px] text-muted-foreground/60 italic py-2">
              {windowsCollected === 0
                ? "No evaluated windows yet — data will appear as the bot runs."
                : `Accumulating data… ${windowsCollected} of ${MIN_WINDOWS} windows evaluated. Check back soon.`
              }
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No data for this coin yet.</p>
          ) : (
            <>
              {best && (
                <div className="bg-emerald-950/30 border border-emerald-500/20 rounded-lg px-4 py-2.5 text-xs">
                  <span className="text-emerald-400 font-semibold">Best entry: {best.label}</span>
                  {best.accuracy !== null && (
                    <span className="text-emerald-300/80 ml-2">
                      {Math.round(best.accuracy * 100)}% accurate
                    </span>
                  )}
                  {best.avgTheoreticalReturn !== null && (
                    <span className="text-sky-300/80 ml-2">
                      · {best.avgTheoreticalReturn.toFixed(2)}× avg return
                    </span>
                  )}
                  {best.ev !== null && (
                    <span className={`ml-2 ${best.ev > 0 ? "text-emerald-300/80" : "text-red-300/80"}`}>
                      · EV {best.ev > 0 ? "+" : ""}{(best.ev * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
              )}

              {/* Visual bar chart for accuracy */}
              <div>
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground/60 mb-2">
                  Direction accuracy by minute (composite ML Gate model)
                </div>
                <div className="flex items-end gap-0.5" style={{ height: 60 }}>
                  {Array.from({ length: 15 }, (_, i) => {
                    const row = filtered.find(r => r.minuteMark === i);
                    const acc = row?.accuracy ?? null;
                    const isBest = row?.minuteMark === best?.minuteMark;
                    const barH = acc !== null ? Math.max(4, Math.round(acc * 52)) : 4;
                    const barColor = isBest
                      ? "bg-emerald-500"
                      : acc === null ? "bg-muted/20"
                      : acc >= 0.58 ? "bg-sky-500"
                      : acc >= 0.50 ? "bg-yellow-500/70"
                      : "bg-red-500/50";
                    return (
                      <div
                        key={i}
                        className="flex-1 flex flex-col items-center gap-0.5"
                        title={acc !== null
                          ? `Min ${i}: ${Math.round(acc * 100)}% accurate (n=${row?.sampleCount ?? 0})`
                          : `Min ${i}: no data`
                        }
                      >
                        <div className="w-full flex items-end" style={{ height: 52 }}>
                          <div
                            className={`w-full rounded-sm transition-all ${barColor} ${isBest ? "ring-1 ring-emerald-400/60" : ""}`}
                            style={{ height: barH }}
                          />
                        </div>
                        {i % 3 === 0 && (
                          <div className="text-[7px] text-muted-foreground/50">{i}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground/30 mt-0.5">
                  <span>min 0</span><span>min 7</span><span>min 14</span>
                </div>
              </div>

              {/* Data table */}
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground/60 border-b border-border">
                    <th className="text-left pb-1.5 font-medium">Minute</th>
                    <th className="text-right pb-1.5 font-medium">Accuracy</th>
                    <th className="text-right pb-1.5 font-medium">Return</th>
                    <th className="text-right pb-1.5 font-medium">≥1.5×</th>
                    <th className="text-right pb-1.5 font-medium">EV</th>
                    <th className="text-right pb-1.5 font-medium">n</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(row => {
                    const isBest = row.minuteMark === best?.minuteMark;
                    const accPct  = row.accuracy !== null ? Math.round(row.accuracy * 100) : null;
                    const ret     = row.avgTheoreticalReturn;
                    const pct15x  = row.pctAbove1_5x !== null ? Math.round(row.pctAbove1_5x * 100) : null;
                    const evSign  = row.ev !== null && row.ev > 0 ? "+" : "";
                    return (
                      <tr
                        key={row.minuteMark}
                        className={`border-b border-border/40 last:border-0 ${isBest ? "bg-emerald-950/20" : ""}`}
                      >
                        <td className={`py-1.5 font-mono text-[11px] ${isBest ? "text-emerald-300 font-semibold" : "text-foreground/80"}`}>
                          min {row.minuteMark}{isBest && " ★"}
                        </td>
                        <td className={`py-1.5 text-right font-semibold ${accColor(row.accuracy)}`}>
                          {accPct !== null ? `${accPct}%` : "—"}
                        </td>
                        <td className={`py-1.5 text-right font-mono text-[11px] ${retColor(ret)}`}>
                          {ret !== null ? `${ret.toFixed(2)}×` : "—"}
                        </td>
                        <td className={`py-1.5 text-right text-[11px] ${pct15x !== null && pct15x >= 40 ? "text-emerald-400" : "text-muted-foreground/50"}`}>
                          {pct15x !== null ? `${pct15x}%` : "—"}
                        </td>
                        <td className={`py-1.5 text-right ${evColor(row.ev)}`}>
                          {row.ev !== null ? `${evSign}${(row.ev * 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="py-1.5 text-right text-muted-foreground/40 text-[11px]">
                          {row.sampleCount}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="text-[9px] text-muted-foreground/30">
                Accuracy = composite ML Gate direction matched final window outcome.
                Return = theoretical return multiple for the model's called direction.
                ≥1.5× = % of snapshots where the return available was ≥ 1.5×.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
