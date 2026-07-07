import { useState } from "react";
import { Brain, CheckCircle2, Clock, Loader2, ChevronDown, ChevronUp, ArrowUp, ArrowDown, Minus } from "lucide-react";
import type { PipelineResult } from "./types";
import { wkToEst } from "./utils";

interface PipelineStatusPanelProps {
  results: PipelineResult[];
  inFlightSyms: string[];
}

function SignalDot({ above, confidence }: { above: boolean | null; confidence: number | null }) {
  if (above === null) return <span className="text-muted-foreground text-xs">—</span>;
  const color = above ? "text-emerald-400" : "text-red-400";
  const Icon = above ? ArrowUp : ArrowDown;
  return (
    <span className={`flex items-center gap-0.5 font-semibold text-xs ${color}`}>
      <Icon className="w-3 h-3" />
      {above ? "↑" : "↓"}
      {confidence != null && <span className="font-mono">{confidence.toFixed(0)}%</span>}
    </span>
  );
}

function LatencyBadge({ ms }: { ms: number }) {
  const color = ms === 0 ? "text-muted-foreground" : ms < 5000 ? "text-emerald-400" : ms < 15000 ? "text-amber-400" : "text-red-400";
  if (ms === 0) return <span className="text-muted-foreground text-xs">—</span>;
  return <span className={`font-mono text-xs ${color}`}>{ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</span>;
}

export function PipelineStatusPanel({ results, inFlightSyms }: PipelineStatusPanelProps) {
  const [open, setOpen] = useState(true);

  const allReady = inFlightSyms.length === 0 && results.length > 0;
  const anyInFlight = inFlightSyms.length > 0;

  const headerColor = anyInFlight
    ? "text-amber-400"
    : allReady
    ? "text-emerald-400"
    : "text-muted-foreground";

  const HeaderIcon = anyInFlight ? Loader2 : allReady ? CheckCircle2 : Brain;
  const headerIconClass = anyInFlight ? "animate-spin" : "";

  const windowKey = results[0]?.windowKey ?? null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <HeaderIcon className={`w-4 h-4 ${headerColor} ${headerIconClass}`} />
          <span className="text-sm font-semibold text-foreground">Pipeline Status</span>
          {windowKey && (
            <span className="text-xs text-muted-foreground font-mono">
              window {wkToEst(windowKey)} ET
            </span>
          )}
          {anyInFlight && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 animate-pulse">
              Awaiting Claude… ({inFlightSyms.join(", ")})
            </span>
          )}
          {allReady && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Pipeline ready ✓
            </span>
          )}
          {!anyInFlight && results.length === 0 && (
            <span className="text-xs text-muted-foreground">No data yet for this window</span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-5 pb-4 pt-1">
          {results.length === 0 && inFlightSyms.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              Pipeline runs at window open. Results will appear here once the first coin completes.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-3 font-medium">Coin</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Status</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Strike</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Stat</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Claude</th>
                    <th className="text-left py-1.5 pr-3 font-medium">ML</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Latency</th>
                    <th className="text-left py-1.5 font-medium">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => {
                    const isInFlight = inFlightSyms.includes(r.sym);
                    return (
                      <tr key={r.sym} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-3 font-bold text-foreground">{r.sym}</td>
                        <td className="py-2 pr-3">
                          {isInFlight ? (
                            <span className="flex items-center gap-1 text-amber-400">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Re-checking
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-emerald-400">
                              <CheckCircle2 className="w-3 h-3" />
                              Ready{r.isRecheck ? " (re-check)" : ""}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-foreground">
                          ${r.kalshiTarget >= 1000
                            ? r.kalshiTarget.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : r.kalshiTarget >= 1
                            ? r.kalshiTarget.toFixed(4)
                            : r.kalshiTarget.toFixed(6)}
                        </td>
                        <td className="py-2 pr-3">
                          <SignalDot above={r.statAbove} confidence={r.statConfidence} />
                        </td>
                        <td className="py-2 pr-3">
                          <SignalDot above={r.claudeAbove} confidence={r.claudeConfidence} />
                        </td>
                        <td className="py-2 pr-3">
                          <SignalDot above={r.mlAbove} confidence={r.mlConfidence} />
                        </td>
                        <td className="py-2 pr-3">
                          <LatencyBadge ms={r.claudeCallMs} />
                        </td>
                        <td className="py-2 text-muted-foreground font-mono">
                          {new Date(r.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </td>
                      </tr>
                    );
                  })}
                  {inFlightSyms
                    .filter(sym => !results.some(r => r.sym === sym))
                    .map(sym => (
                      <tr key={`inflight-${sym}`} className="border-b border-border/50 last:border-0 opacity-60">
                        <td className="py-2 pr-3 font-bold text-foreground">{sym}</td>
                        <td className="py-2 pr-3" colSpan={7}>
                          <span className="flex items-center gap-1 text-amber-400">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Awaiting Claude…
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
