import { ArrowUp, ArrowDown, Minus, Brain, Cpu, BarChart2, Activity } from "lucide-react";
import type { CoinSignals } from "./types";

interface CoinSignalBoardProps {
  liveSignals: Record<string, CoinSignals>;
  kalshiTargets: Record<string, number | null>;
}

function Dir({
  above,
  confidence,
  dim,
}: {
  above: boolean | null;
  confidence: number | null;
  dim?: boolean;
}) {
  if (above === null) {
    return <span className="text-muted-foreground/50 text-xs font-mono">—</span>;
  }
  const up = above;
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-semibold text-xs tabular-nums ${
        dim ? "opacity-40" : up ? "text-emerald-400" : "text-red-400"
      }`}
    >
      {up ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {confidence != null ? `${confidence.toFixed(0)}%` : up ? "YES" : "NO"}
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
  if (votes.length === 3) {
    return (
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
        {upVotes}↑ {downVotes}↓ Split
      </span>
    );
  }
  return (
    <span className="text-[10px] text-muted-foreground font-mono">
      {upVotes}↑ {downVotes}↓
    </span>
  );
}

function fmtStrike(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

const COIN_ORDER = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "HYPE", "LINK"];

export function CoinSignalBoard({ liveSignals, kalshiTargets }: CoinSignalBoardProps) {
  const syms = COIN_ORDER.filter((s) => s in liveSignals);
  if (syms.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border">
        <Activity className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm text-foreground">Live Signals</h2>
        <span className="text-xs text-muted-foreground">
          — predictor output per coin, updated every 5 s
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
              const target = kalshiTargets[sym] ?? null;
              const hasAny =
                s.statAbove !== null || s.claudeAbove !== null || s.mlAbove !== null;

              return (
                <tr
                  key={sym}
                  className={`border-b border-border/40 last:border-0 transition-colors ${
                    hasAny ? "hover:bg-muted/20" : "opacity-50"
                  }`}
                >
                  <td className="px-5 py-2.5 font-bold text-foreground">{sym}</td>
                  <td className="px-3 py-2.5 font-mono text-foreground/70">
                    {fmtStrike(target)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Dir above={s.statAbove} confidence={s.statConfidence} />
                  </td>
                  <td className="px-3 py-2.5">
                    {s.claudeEnabled ? (
                      <Dir above={s.claudeAbove} confidence={s.claudeConfidence} />
                    ) : (
                      <span className="text-muted-foreground/40 text-[10px]">off</span>
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
