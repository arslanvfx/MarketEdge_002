import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calculator, ChevronDown, ChevronUp, Info, TrendingDown, TrendingUp } from "lucide-react";
import { API_BASE, fmt$ } from "./utils";

interface PnlSimulationBreakdown {
  hypotheticalStakePerBet?: number;
  includedCount: number;
  excludedCount: number;
  unresolvedCount: number;
  actualStake: number;
  actualPnl: number;
  actualRoiPct: number | null;
  hypotheticalStake: number;
  hypotheticalPnl: number;
  hypotheticalRoiPct: number | null;
  deltaPnl: number;
  deltaPct: number | null;
}

interface DailyPnlSimulation {
  mode: "paper" | "live";
  timeZone: "America/New_York";
  dayStartAt: string;
  nextResetAt: string;
  regular: PnlSimulationBreakdown;
  scalper: PnlSimulationBreakdown;
  totals: PnlSimulationBreakdown;
  assumptions: string[];
}

function pct(value: number | null): string {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : "−"}${fmt$(Math.abs(value))}`;
}

function PnlValue({ value, large = false }: { value: number; large?: boolean }) {
  const positive = value >= 0;
  return (
    <span className={`${large ? "text-lg" : "text-sm"} font-mono font-bold ${positive ? "text-emerald-400" : "text-red-400"}`}>
      {signedMoney(value)}
    </span>
  );
}

function StrategyRow({
  label,
  data,
}: {
  label: string;
  data: PnlSimulationBreakdown;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/50 bg-muted/10 p-3 sm:grid-cols-5">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Strategy</div>
        <div className="mt-1 text-xs font-semibold">{label}</div>
        <div className="text-[10px] text-muted-foreground">{data.includedCount} settled bets</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Actual P&amp;L</div>
        <div className="mt-1"><PnlValue value={data.actualPnl} /></div>
        <div className="text-[10px] text-muted-foreground">ROI {pct(data.actualRoiPct)}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">What-if P&amp;L</div>
        <div className="mt-1"><PnlValue value={data.hypotheticalPnl} /></div>
        <div className="text-[10px] text-muted-foreground">ROI {pct(data.hypotheticalRoiPct)}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Stake compared</div>
        <div className="mt-1 text-xs font-mono">{fmt$(data.actualStake)} → {fmt$(data.hypotheticalStake)}</div>
        <div className="text-[10px] text-muted-foreground">total capital used</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Difference</div>
        <div className="mt-1 flex items-center gap-1">
          {data.deltaPnl >= 0
            ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
            : <TrendingDown className="h-3.5 w-3.5 text-red-400" />}
          <PnlValue value={data.deltaPnl} />
        </div>
        <div className="text-[10px] text-muted-foreground">{pct(data.deltaPct)} vs actual</div>
      </div>
    </div>
  );
}

export function PnlWhatIfCalculator({
  mode,
  isProduction,
}: {
  mode: "paper" | "live";
  isProduction: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [regularStake, setRegularStake] = useState("1");
  const [scalperStake, setScalperStake] = useState("50");
  const regularValue = Number(regularStake);
  const scalperValue = Number(scalperStake);
  const inputsValid =
    Number.isFinite(regularValue) && regularValue >= 0.01 && regularValue <= 10_000
    && Number.isFinite(scalperValue) && scalperValue >= 0.01 && scalperValue <= 10_000;

  const { data, isFetching, isError, error } = useQuery<DailyPnlSimulation>({
    queryKey: ["bot-daily-pnl-simulation", mode, regularValue, scalperValue],
    queryFn: async () => {
      const params = new URLSearchParams({
        mode,
        regularStake: String(regularValue),
        scalperStake: String(scalperValue),
      });
      const response = await fetch(`${API_BASE}/crypto/bot/daily-pnl-simulation?${params}`);
      const body = await response.json() as DailyPnlSimulation | { error?: string };
      if (!response.ok) {
        throw new Error("error" in body && body.error ? body.error : "Unable to calculate P&L");
      }
      return body as DailyPnlSimulation;
    },
    enabled: open && inputsValid,
    refetchInterval: open ? 30_000 : false,
  });

  const dateLabel = data
    ? new Date(data.dayStartAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/New_York",
      })
    : null;

  return (
    <div className="overflow-hidden rounded-xl border border-sky-500/20 bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/30 sm:px-5"
      >
        <Calculator className="h-4 w-4 flex-shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Daily P&amp;L What-If Calculator</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {isProduction ? "Production" : "Development"} · {mode} · midnight-to-midnight Eastern
          </div>
        </div>
        {data && !open && (
          <div className="hidden items-center gap-2 text-xs sm:flex">
            <span className="text-muted-foreground">Estimate</span>
            <PnlValue value={data.totals.hypotheticalPnl} />
          </div>
        )}
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-4 sm:px-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Regular bet size per settled bet</span>
              <div className="flex items-center rounded-lg border border-border bg-background px-3 focus-within:border-sky-500/60">
                <span className="text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  min="0.01"
                  max="10000"
                  step="0.01"
                  value={regularStake}
                  onChange={(event) => setRegularStake(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm font-mono outline-none"
                />
              </div>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Scalper bet size per settled bet</span>
              <div className="flex items-center rounded-lg border border-border bg-background px-3 focus-within:border-sky-500/60">
                <span className="text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  min="0.01"
                  max="10000"
                  step="0.01"
                  value={scalperStake}
                  onChange={(event) => setScalperStake(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm font-mono outline-none"
                />
              </div>
            </label>
          </div>

          {!inputsValid && (
            <div className="text-xs text-amber-300">Enter a value from $0.01 to $10,000 for both strategies.</div>
          )}
          {isError && (
            <div className="text-xs text-red-300">{error instanceof Error ? error.message : "Unable to calculate P&L."}</div>
          )}

          {data && inputsValid && (
            <>
              <div className="grid gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 sm:grid-cols-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Actual P&amp;L</div>
                  <div className="mt-1"><PnlValue value={data.totals.actualPnl} large /></div>
                  <div className="text-[10px] text-muted-foreground">ROI {pct(data.totals.actualRoiPct)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">What-if P&amp;L</div>
                  <div className="mt-1"><PnlValue value={data.totals.hypotheticalPnl} large /></div>
                  <div className="text-[10px] text-muted-foreground">ROI {pct(data.totals.hypotheticalRoiPct)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">P&amp;L difference</div>
                  <div className="mt-1"><PnlValue value={data.totals.deltaPnl} large /></div>
                  <div className="text-[10px] text-muted-foreground">{pct(data.totals.deltaPct)} vs actual</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sample</div>
                  <div className="mt-1 text-sm font-bold">{data.totals.includedCount} settlements</div>
                  <div className="text-[10px] text-muted-foreground">
                    {dateLabel} ET · {data.totals.excludedCount} excluded
                  </div>
                </div>
              </div>

              <StrategyRow label="Regular bot" data={data.regular} />
              <StrategyRow label="High-Value Scalper" data={data.scalper} />

              <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[10px] leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
                <div>
                  Each settlement keeps its actual realized return rate and is rescaled to the selected fixed stake.
                  This is a historical estimate—not a promise of future results—and cannot model changed fills, liquidity,
                  slippage, fees, or market impact. Manual, Contrarian, shadow, legacy mirrored, and unresolved trades are excluded.
                  {data.totals.unresolvedCount > 0 && ` ${data.totals.unresolvedCount} unresolved Scalper order(s) are currently excluded.`}
                </div>
              </div>
            </>
          )}

          {isFetching && (
            <div className="text-[10px] text-muted-foreground">Refreshing settlement-level estimate…</div>
          )}
        </div>
      )}
    </div>
  );
}