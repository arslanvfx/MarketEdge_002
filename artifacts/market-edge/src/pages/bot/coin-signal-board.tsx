import { useRef } from "react";
import { ArrowUp, ArrowDown, Brain, Cpu, BarChart2, Activity } from "lucide-react";
import type { CoinSignals } from "./types";
import { wkToEstRange, ET_LABEL } from "./utils";

interface CoinSignalBoardProps {
  liveSignals: Record<string, CoinSignals>;
  kalshiTargets: Record<string, number | null>;
  windowKey?: string | null;
}

function Dir({
  above,
  confidence,
}: {
  above: boolean | null;
  confidence: number | null;
}) {
  if (above === null) {
    return <span className="text-muted-foreground/40 text-xs font-mono">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-semibold text-xs tabular-nums ${
        above ? "text-emerald-400" : "text-red-400"
      }`}
    >
      {above ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {confidence != null ? `${confidence.toFixed(0)}%` : above ? "YES" : "NO"}
    </span>
  );
}

function AgreementBadge({ signals }: { signals: CoinSignals }) {
  const votes = [signals.statAbove, signals.claudeAbove, signals.mlAbove].filter(
    (v) => v !== null
  );
  if (votes.length === 0) {
    return <span className="text-muted-foreground/40 text-xs">—</span>;
  }
  const upVotes = votes.filter(Boolean).length;
  const downVotes = votes.filter((v) => !v).length;

  if (upVotes === votes.length) {
    return (
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
        ↑ All agree
      </span>
    );
  }
  if (downVotes === votes.length) {
    return (
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/25">
        ↓ All agree
      </span>
    );
  }
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
      {upVotes}↑ {downVotes}↓ Split
    </span>
  );
}

function fmtStrike(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

const COIN_ORDER = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "HYPE", "LINK"];

export function CoinSignalBoard({ liveSignals, kalshiTargets, windowKey }: CoinSignalBoardProps) {
  // Pin strikes: once we see a non-null value for a coin, never clear it.
  // Kalshi strike is fixed per window so there's no reason to blank it on refetch.
  const pinnedStrikes = useRef<Record<string, number>>({});
  for (const [sym, val] of Object.entries(kalshiTargets)) {
    if (val != null) pinnedStrikes.current[sym] = val;
  }

  const syms = COIN_ORDER.filter((s) => s in liveSignals);
  if (syms.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border">
        <Activity className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm text-foreground">Live Signals</h2>
        {windowKey && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/25 font-mono">
            Window {wkToEstRange(windowKey)} {ET_LABEL}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-1">
          mirrored from predictor · updates every 5 s
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left px-5 py-2 font-medium w-16">Coin</th>
              <th className="text-left px-3 py-2 font-medium">Strike</th>
              <th className="text-left px-3 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  <BarChart2 className="w-3 h-3" />
                  Stat
                </span>
              </th>
              <th className="text-left px-3 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  <Brain className="w-3 h-3" />
                  Claude
                </span>
              </th>
              <th className="text-left px-3 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  ML
                </span>
              </th>
              <th className="text-left px-3 py-2 font-medium">Agreement</th>
            </tr>
          </thead>
          <tbody>
            {syms.map((sym) => {
              const s = liveSignals[sym];
              const strike = pinnedStrikes.current[sym] ?? null;

              return (
                <tr
                  key={sym}
                  className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-5 py-2.5 font-bold text-foreground">{sym}</td>
                  <td className="px-3 py-2.5 font-mono text-foreground/60 text-[11px]">
                    {fmtStrike(strike)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Dir above={s.statAbove} confidence={s.statConfidence} />
                  </td>
                  <td className="px-3 py-2.5">
                    {s.claudeAbove !== null ? (
                      <span className={s.claudeEnabled ? "" : "opacity-60"} title={s.claudeEnabled ? undefined : "Claude running (passive — auto-pilot slot not active)"}>
                        <Dir above={s.claudeAbove} confidence={s.claudeConfidence} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs font-mono">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Dir above={s.mlAbove} confidence={s.mlConfidence} />
                  </td>
                  <td className="px-3 py-2.5">
                    <AgreementBadge signals={s} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
