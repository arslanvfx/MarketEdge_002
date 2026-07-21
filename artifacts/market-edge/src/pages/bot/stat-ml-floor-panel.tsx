import React, { useState } from "react";
import { FlaskConical, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Info } from "lucide-react";
import type { StatMLFloorAnalysis, StatMLFloorCell, StatMLCoinResult, SignalAccuracyBreakdown } from "./types";

const FLOORS = [50, 53, 55, 58, 60, 62] as const;

function wrColor(wr: number | null, bets: number): string {
  if (wr == null || bets < 3) return "text-muted-foreground/40";
  if (wr >= 0.6)  return "text-emerald-400";
  if (wr >= 0.5)  return "text-amber-400";
  return "text-red-400";
}

function cellBg(wr: number | null, bets: number, isGlobalBest: boolean): string {
  if (isGlobalBest) return "bg-violet-500/25 ring-1 ring-violet-400/60";
  if (bets < 3)     return "bg-muted/10";
  if (wr == null)   return "bg-muted/10";
  if (wr >= 0.6)  return "bg-emerald-500/15";
  if (wr >= 0.5)  return "bg-amber-500/10";
  return "bg-red-500/10";
}

interface HeatGridProps {
  cells: StatMLFloorCell[];
  bestCell: StatMLFloorCell | null;
  currentStatFloor?: number | null;
  currentMLFloor?: number | null;
  compact?: boolean;
}

function HeatGrid({ cells, bestCell, currentStatFloor, currentMLFloor, compact }: HeatGridProps) {
  const lookup = new Map<string, StatMLFloorCell>();
  for (const c of cells) lookup.set(`${c.statFloor}:${c.mlFloor}`, c);

  const cellSize = compact ? "w-11 h-9" : "w-14 h-11";
  const textSz   = compact ? "text-[9px]" : "text-[10px]";

  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-center">
        <thead>
          <tr>
            <th className="w-14 text-[9px] text-muted-foreground/60 text-right pr-1 font-normal pb-0.5">
              Stat\ML
            </th>
            {FLOORS.map(mf => (
              <th key={mf} className={`${textSz} text-muted-foreground/70 font-semibold pb-0.5`}>
                {mf}%
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FLOORS.map(sf => (
            <tr key={sf}>
              <td className={`${textSz} text-muted-foreground/70 font-semibold text-right pr-1`}>
                {sf}%
              </td>
              {FLOORS.map(mf => {
                const c = lookup.get(`${sf}:${mf}`);
                const isGlobalBest = bestCell?.statFloor === sf && bestCell?.mlFloor === mf;
                const isCurrent    = currentStatFloor === sf && currentMLFloor === mf;
                const wr = c?.winRate ?? null;
                const bets = c?.bets ?? 0;
                return (
                  <td key={mf} className="p-0">
                    <div
                      className={`${cellSize} rounded flex flex-col items-center justify-center gap-px transition-colors ${cellBg(wr, bets, isGlobalBest)} ${isCurrent ? "ring-1 ring-sky-400/70" : ""}`}
                      title={c ? `Stat≥${sf}% ML≥${mf}% — ${bets} bets, ${c.wins}W/${c.losses}L, WR ${wr != null ? Math.round(wr * 100) : "—"}%` : ""}
                    >
                      <span className={`font-bold ${textSz} ${wrColor(wr, bets)}`}>
                        {wr != null && bets >= 3 ? `${Math.round(wr * 100)}%` : "—"}
                      </span>
                      <span className="text-[8px] text-muted-foreground/50">{bets > 0 ? `${bets}b` : ""}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function accuracyColor(pct: number): string {
  if (pct >= 60) return "text-emerald-400";
  if (pct >= 45) return "text-amber-400";
  return "text-red-400";
}

function SignalAccuracyTable({ data }: { data: SignalAccuracyBreakdown }) {
  const total = data.bothRight + data.statOnly + data.mlOnly + data.bothWrong;

  function Cell({ count, label, highlight }: { count: number; label: string; highlight?: boolean }) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return (
      <div className={`flex flex-col items-center justify-center rounded p-2 gap-0.5 ${highlight ? "bg-emerald-500/15 ring-1 ring-emerald-500/30" : "bg-muted/15"}`}>
        <span className={`text-sm font-bold ${accuracyColor(pct)}`}>{count}</span>
        <span className="text-[8px] text-muted-foreground/60">{pct}%</span>
        <span className="text-[8px] text-muted-foreground/50 text-center leading-tight">{label}</span>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[10px] text-muted-foreground/70 font-semibold uppercase tracking-wide">
        Signal accuracy — who called it right?
      </div>
      <div className="grid grid-cols-2 gap-1.5 max-w-[240px]">
        <Cell count={data.bothRight} label="Stat✓  ML✓" highlight={data.bothRight === Math.max(data.bothRight, data.statOnly, data.mlOnly, data.bothWrong)} />
        <Cell count={data.statOnly} label="Stat✓  ML✗" />
        <Cell count={data.mlOnly}   label="Stat✗  ML✓" />
        <Cell count={data.bothWrong} label="Stat✗  ML✗" />
      </div>
      {(data.bothAgreeWinRate !== null || data.bothDisagreeWinRate !== null) && (
        <div className="flex gap-4 text-[9px] text-muted-foreground/70 pt-0.5">
          {data.bothAgreeWinRate !== null && (
            <span>
              Signals agree:{" "}
              <span className={`font-semibold ${accuracyColor(Math.round(data.bothAgreeWinRate * 100))}`}>
                {Math.round(data.bothAgreeWinRate * 100)}% WR
              </span>
            </span>
          )}
          {data.bothDisagreeWinRate !== null && (
            <span>
              Disagree:{" "}
              <span className={`font-semibold ${accuracyColor(Math.round(data.bothDisagreeWinRate * 100))}`}>
                {Math.round(data.bothDisagreeWinRate * 100)}% WR
              </span>
            </span>
          )}
        </div>
      )}
      <div className="text-[8px] text-muted-foreground/40">{total} bets</div>
    </div>
  );
}

interface CoinRowProps {
  coin: StatMLCoinResult;
  currentStatFloor?: number | null;
  currentMLFloor?: number | null;
}

function CoinRow({ coin, currentStatFloor, currentMLFloor }: CoinRowProps) {
  const [open, setOpen] = useState(false);
  const bc = coin.bestCell;
  const bcWr = bc?.winRate != null ? Math.round(bc.winRate * 100) : null;
  const wrC = bcWr != null ? (bcWr >= 60 ? "text-emerald-400" : bcWr >= 50 ? "text-amber-400" : "text-red-400") : "text-muted-foreground/50";

  const recChanged =
    coin.recommendedStatFloor !== null &&
    coin.recommendedMLFloor   !== null &&
    (coin.recommendedStatFloor !== currentStatFloor || coin.recommendedMLFloor !== currentMLFloor);

  return (
    <div className="border border-border/40 rounded-lg overflow-hidden">
      <button
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-muted/20 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <span className="text-xs font-bold w-10">{coin.symbol}</span>
        <span className="text-[10px] text-muted-foreground">{coin.totalBets} bets</span>

        {bc && bcWr != null ? (
          <>
            <span className={`text-xs font-semibold ml-auto ${wrC}`}>{bcWr}% WR</span>
            <span className="text-[10px] text-muted-foreground ml-1">
              @ Stat≥{bc.statFloor}% / ML≥{bc.mlFloor}%
            </span>
            {recChanged && (
              <span className="ml-1 text-[9px] bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded-full font-semibold">
                SUGGESTED
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-muted-foreground/50 ml-auto italic">not enough data</span>
        )}
        {open ? <ChevronUp className="w-3 h-3 text-muted-foreground ml-1 shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground ml-1 shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-border/40 pt-3">
          <HeatGrid
            cells={coin.cells}
            bestCell={coin.bestCell}
            currentStatFloor={currentStatFloor}
            currentMLFloor={currentMLFloor}
            compact
          />
          {coin.signalAccuracy && (
            <SignalAccuracyTable data={coin.signalAccuracy} />
          )}
        </div>
      )}
    </div>
  );
}

interface StatMLFloorPanelProps {
  data: StatMLFloorAnalysis | undefined;
  currentStatFloor?: number | null;
  currentMLFloor?: number | null;
  isStatMLMode?: boolean;
}

export function StatMLFloorPanel({ data, currentStatFloor, currentMLFloor, isStatMLMode }: StatMLFloorPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (!data) {
    return (
      <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-3">
        <FlaskConical className="w-4 h-4 text-violet-400 animate-pulse" />
        <span className="text-sm text-muted-foreground">Loading stat_ml floor analysis…</span>
      </div>
    );
  }

  const bc = data.globalBestCell;
  const bcWr = bc?.winRate != null ? Math.round(bc.winRate * 100) : null;
  const eligible = data.eligibleBets;
  const hasData  = eligible >= 3;

  const currentDesc = (currentStatFloor != null && currentMLFloor != null)
    ? `Stat≥${currentStatFloor}% / ML≥${currentMLFloor}%`
    : "defaults (53% / 67%)";

  const suggestsDiff =
    bc &&
    ((currentStatFloor ?? 53) !== bc.statFloor || (currentMLFloor ?? 67) !== bc.mlFloor);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <FlaskConical className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm">stat_ml Floor Analysis</h2>
        <span className="text-xs text-muted-foreground">
          confidence floor tuning grid
          {data.sinceDays ? ` · last ${data.sinceDays}d` : ""}
        </span>
        {isStatMLMode && (
          <span className="text-[9px] bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded-full font-bold ml-1">ACTIVE MODE</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground">{eligible} eligible bets</span>
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] font-semibold px-2.5 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {!hasData && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground/70 italic">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Not enough settled bets with Stat + ML signals yet ({eligible} found, need ≥ 3).
              The grid will populate as the bot collects more history in stat_ml mode.
            </span>
          </div>
        )}

        {hasData && (
          <>
            {/* Summary row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-muted/10 rounded-lg p-3 border border-border/40">
                <div className="text-[10px] text-muted-foreground mb-1">Current floors</div>
                <div className="text-sm font-bold">{currentDesc}</div>
                {(() => {
                  const curCell = data.grid.find(c => c.statFloor === (currentStatFloor ?? 53) && c.mlFloor === (currentMLFloor ?? 67));
                  const curWr = curCell?.winRate != null ? Math.round(curCell.winRate * 100) : null;
                  return curWr != null ? (
                    <div className={`text-xs font-semibold mt-1 ${curWr >= 60 ? "text-emerald-400" : curWr >= 50 ? "text-amber-400" : "text-red-400"}`}>
                      {curWr}% WR · {curCell?.bets ?? 0} bets
                    </div>
                  ) : <div className="text-xs text-muted-foreground/50 mt-1">no coverage data yet</div>;
                })()}
              </div>

              <div className={`rounded-lg p-3 border ${bc ? "bg-violet-500/10 border-violet-500/30" : "bg-muted/10 border-border/40"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Best overall combo</div>
                {bc ? (
                  <>
                    <div className="text-sm font-bold">
                      Stat≥{bc.statFloor}% / ML≥{bc.mlFloor}%
                    </div>
                    <div className={`text-xs font-semibold mt-1 ${bcWr != null && bcWr >= 60 ? "text-emerald-400" : bcWr != null && bcWr >= 50 ? "text-amber-400" : "text-red-400"}`}>
                      {bcWr != null ? `${bcWr}% WR` : "—"} · {bc.bets} bets · {Math.round(bc.coverage * 100)}% coverage
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground/50 italic">need ≥5 bets per combo</div>
                )}
              </div>

              <div className={`rounded-lg p-3 border ${suggestsDiff ? "bg-amber-500/10 border-amber-500/30" : "bg-muted/10 border-border/40"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Recommendation</div>
                {bc && suggestsDiff ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <TrendingUp className="w-3 h-3 text-amber-400" />
                      <span className="text-sm font-bold">Change suggested</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/70 mt-1">
                      Try Stat≥{bc.statFloor}% / ML≥{bc.mlFloor}% in Bot Configuration
                    </div>
                  </>
                ) : bc ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <TrendingDown className="w-3 h-3 text-emerald-400" />
                      <span className="text-sm font-bold">Floors look good</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/70 mt-1">Current floors match the best-WR combo</div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground/50 italic">insufficient data</div>
                )}
              </div>
            </div>

            {/* Global heatgrid */}
            <div>
              <div className="text-[10px] text-muted-foreground/70 mb-2 font-semibold uppercase tracking-wide">
                Win-rate heatmap (all coins) — rows = Stat floor, cols = ML floor
              </div>
              <HeatGrid
                cells={data.grid}
                bestCell={data.globalBestCell}
                currentStatFloor={currentStatFloor}
                currentMLFloor={currentMLFloor}
              />
              <div className="mt-2 flex items-center gap-4 text-[9px] text-muted-foreground/60">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/30 inline-block" /> ≥60% WR</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/20 inline-block" /> 50–60% WR</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/15 inline-block" /> &lt;50% WR</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-500/25 ring-1 ring-violet-400/60 inline-block" /> best combo</span>
                {currentStatFloor != null && (
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm ring-1 ring-sky-400/70 inline-block" /> current</span>
                )}
              </div>
            </div>

            {/* Per-coin section */}
            {expanded && data.byCoin.length > 0 && (
              <div>
                <div className="text-[10px] text-muted-foreground/70 mb-2 font-semibold uppercase tracking-wide">
                  Per-coin breakdown
                </div>
                <div className="space-y-2">
                  {data.byCoin.map(coin => (
                    <CoinRow
                      key={coin.symbol}
                      coin={coin}
                      currentStatFloor={currentStatFloor}
                      currentMLFloor={currentMLFloor}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <p className="text-[9px] text-muted-foreground/50 leading-relaxed">
          Replays settled bets with Stat+ML signals through each floor combination (36 combos).
          Price-dependent gates (min-return, orderbook) are omitted — historical entry costs aren't
          reliable enough to replay. The recommended floors are the combo with the highest win rate
          across ≥5 bets. Adjust in Bot Configuration → stat_ml mode settings.
          Computed at {data.computedAt ? new Date(data.computedAt).toLocaleString() : "—"}.
        </p>
      </div>
    </div>
  );
}
