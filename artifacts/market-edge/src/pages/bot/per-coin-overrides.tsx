import { Pause, Sliders } from "lucide-react";
import type { BotConfig } from "./types";
import { REGULAR_BOT_SYMBOLS } from "./regular-symbols";

interface PerCoinOverridesProps {
  value: BotConfig["coinOverrides"];
  globalMax: number;
  onChange: (value: NonNullable<BotConfig["coinOverrides"]>) => void;
}

export function PerCoinOverrides({ value, globalMax, onChange }: PerCoinOverridesProps) {
  const overrides = value ?? {};

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sliders className="h-3 w-3" />
        Per-Coin Overrides
      </span>
      <div className="overflow-hidden rounded-xl border border-border">
        {REGULAR_BOT_SYMBOLS.map((coin, i) => {
          const current = overrides[coin] ?? {};
          const isPaused = current.paused === true;
          const perMax = current.maxBetSize;
          const update = (nextValue: { paused?: boolean; maxBetSize?: number }) => {
            const next = { ...overrides, [coin]: nextValue };
            if (!nextValue.paused && nextValue.maxBetSize == null) delete next[coin];
            onChange(next);
          };

          return (
            <div
              key={coin}
              className={`flex min-w-0 flex-wrap items-center gap-3 px-3 py-2 ${i > 0 ? "border-t border-border" : ""} ${isPaused ? "bg-muted/30" : ""}`}
            >
              <span className={`w-12 text-xs font-mono font-semibold ${isPaused ? "text-muted-foreground/40 line-through" : "text-foreground"}`}>
                {coin}
              </span>
              <button
                type="button"
                onClick={() => update({ ...current, paused: !isPaused })}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                  isPaused
                    ? "border-amber-500/40 bg-amber-500/15 text-amber-400"
                    : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"
                }`}
              >
                <Pause className="h-2.5 w-2.5" />
                {isPaused ? "Paused" : "Pause"}
              </button>
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground/60">Max $</span>
                <input
                  type="number"
                  min={0.5}
                  max={100}
                  step={0.5}
                  placeholder={globalMax.toFixed(2)}
                  value={perMax ?? ""}
                  className="w-20 rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/40"
                  onChange={event => {
                    const maxBetSize = event.target.value === "" ? undefined : parseFloat(event.target.value);
                    const updated = { ...current, maxBetSize };
                    if (maxBetSize == null) delete updated.maxBetSize;
                    update(updated);
                  }}
                />
              </div>
              {perMax != null && (
                <span className={`text-[10px] font-mono ${perMax < globalMax ? "text-sky-400" : "text-muted-foreground/50"}`}>
                  {perMax < globalMax ? "↓ capped" : "= global"}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <span className="text-[10px] text-muted-foreground/60">
        Pause stops all new bets for that coin. Max $ caps the bet size per contract (blank = use global max). Save to apply.
      </span>
    </div>
  );
}
