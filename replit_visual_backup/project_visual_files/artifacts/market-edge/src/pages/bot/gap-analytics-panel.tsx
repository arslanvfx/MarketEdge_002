import { useState } from "react";
import { Crosshair, ChevronDown, ChevronUp, Trophy, XCircle } from "lucide-react";
import type { GapAnalyticsResult, GapBandRow } from "./types";

interface GapAnalyticsPanelProps {
  data: GapAnalyticsResult | undefined;
  activeMode: "paper" | "live";
}

function bandColor(winRate: number | null, bets: number): string {
  if (bets < 2 || winRate == null) return "bg-muted/30 text-muted-foreground";
  if (winRate >= 0.65) return "bg-emerald-500/20 text-emerald-300";
  if (winRate >= 0.50) return "bg-sky-500/20 text-sky-300";
  if (winRate >= 0.40) return "bg-amber-500/20 text-amber-300";
  return "bg-red-500/20 text-red-300";
}

function WinRateBar({ row }: { row: GapBandRow }) {
  const wr = row.winRate ?? 0;
  const pct = Math.round(wr * 100);
  const barW = row.bets === 0 ? 0 : Math.max(4, Math.round(wr * 100));
  const color = row.bets < 2 || row.winRate == null ? "bg-muted/40"
    : wr >= 0.65 ? "bg-emerald-400"
    : wr >= 0.50 ? "bg-sky-400"
    : wr >= 0.40 ? "bg-yellow-400"
    : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${barW}%` }} />
      </div>
      <span className={`text-[10px] font-mono w-8 text-right ${row.bets < 2 ? "text-muted-foreground/50" : ""}`}>
        {row.bets < 2 ? "—" : `${pct}%`}
      </span>
    </div>
  );
}

export function GapAnalyticsPanel({ data, activeMode }: GapAnalyticsPanelProps) {
  const [open, setOpen] = useState(false);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);

  const coins = data ? Object.keys(data.byCoin).sort() : [];
  const displayBands = selectedCoin && data?.byCoin[selectedCoin]
    ? data.byCoin[selectedCoin]
    : data?.bands ?? [];

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <Crosshair className="w-4 h-4 text-sky-400" />
        <h2 className="font-semibold text-sm">Gap Performance</h2>
        <span className="text-[10px] text-muted-foreground ml-1">
          how far was the crypto price from the Kalshi strike when the bet was placed?
        </span>
        {data && data.totalBets > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {data.totalBets} evaluated bet{data.totalBets !== 1 ? "s" : ""}
          </span>
        )}
        {open ? <ChevronUp className="w-4 h-4 ml-1 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 ml-1 text-muted-foreground" />}
      </button>

      {open && (
        <div className="p-5 space-y-5">
          {!data || data.totalBets === 0 ? (
            <p className="text-sm text-muted-foreground">
              No evaluated bets yet — gap data will appear after the first settlement.
            </p>
          ) : (
            <>
              {/* Mode badge */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${activeMode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"}`}>
                  {activeMode}
                </span>

                {/* Coin filter tabs */}
                {coins.length > 1 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <button
                      onClick={() => setSelectedCoin(null)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        selectedCoin === null
                          ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      All
                    </button>
                    {coins.map(sym => (
                      <button
                        key={sym}
                        onClick={() => setSelectedCoin(s => s === sym ? null : sym)}
                        className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                          selectedCoin === sym
                            ? "border-sky-500/50 bg-sky-500/15 text-sky-300 font-bold"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Gap band breakdown table */}
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                  Win rate by gap band{selectedCoin ? ` — ${selectedCoin}` : " — all coins"}
                </div>
                <div className="space-y-1.5">
                  {/* Column headers */}
                  <div className="grid grid-cols-[96px_1fr_60px_40px_40px] gap-2 text-[9px] uppercase tracking-wide text-muted-foreground/60 px-2">
                    <span>Gap</span>
                    <span>Win rate</span>
                    <span className="text-right">Bets</span>
                    <span className="text-right text-emerald-400/60">W</span>
                    <span className="text-right text-red-400/60">L</span>
                  </div>
                  {displayBands.map((row) => (
                    <div
                      key={row.band}
                      className={`grid grid-cols-[96px_1fr_60px_40px_40px] gap-2 items-center rounded-lg px-2 py-2 ${
                        row.bets === 0 ? "opacity-40" : ""
                      }`}
                    >
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded text-center ${bandColor(row.winRate, row.bets)}`}>
                        {row.band}
                      </span>
                      <WinRateBar row={row} />
                      <span className="text-[11px] font-mono text-muted-foreground text-right">
                        {row.bets}
                      </span>
                      <span className="text-[11px] font-mono text-emerald-400 text-right">
                        {row.wins > 0 ? row.wins : "—"}
                      </span>
                      <span className="text-[11px] font-mono text-red-400 text-right">
                        {row.losses > 0 ? row.losses : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Per-coin summary grid (only when showing all) */}
              {!selectedCoin && coins.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                    Best gap band per coin
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {coins.map(sym => {
                      const symBands = data.byCoin[sym] ?? [];
                      const best = symBands
                        .filter(b => b.bets >= 2 && b.winRate != null)
                        .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0] ?? null;
                      const worst = symBands
                        .filter(b => b.bets >= 2 && b.winRate != null)
                        .sort((a, b) => (a.winRate ?? 1) - (b.winRate ?? 1))[0] ?? null;
                      const totalBets = symBands.reduce((s, b) => s + b.bets, 0);
                      const totalWins = symBands.reduce((s, b) => s + b.wins, 0);
                      const wr = totalBets > 0 ? totalWins / totalBets : null;
                      return (
                        <div key={sym} className="bg-background/40 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-sm">{sym}</span>
                            <span className={`text-xs font-semibold ${wr == null ? "text-muted-foreground" : wr >= 0.5 ? "text-emerald-400" : "text-red-400"}`}>
                              {wr == null ? "—" : `${Math.round(wr * 100)}%`}
                            </span>
                          </div>
                          <div className="space-y-1 text-[10px]">
                            {best && (
                              <div className="flex items-center gap-1 text-emerald-400/80">
                                <Trophy className="w-2.5 h-2.5" />
                                Best: {best.band} ({Math.round((best.winRate ?? 0) * 100)}%, {best.bets} bets)
                              </div>
                            )}
                            {worst && worst.band !== best?.band && (
                              <div className="flex items-center gap-1 text-red-400/60">
                                <XCircle className="w-2.5 h-2.5" />
                                Worst: {worst.band} ({Math.round((worst.winRate ?? 0) * 100)}%, {worst.bets} bets)
                              </div>
                            )}
                            {!best && <span className="text-muted-foreground">Not enough data</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Explanation note */}
              <div className="text-[10px] text-muted-foreground/50 leading-relaxed">
                Gap = |crypto spot price − Kalshi strike| ÷ strike × 100. Larger gap = price was further from the strike at entry.
                Color: <span className="text-emerald-400/70">green ≥65%</span> · <span className="text-sky-400/70">blue ≥50%</span> · <span className="text-amber-400/70">amber ≥40%</span> · <span className="text-red-400/70">red &lt;40%</span>.
                Bands with fewer than 2 bets show —.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
