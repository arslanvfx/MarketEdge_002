import { useState } from "react";
import { Brain, CheckCircle2, Clock, Loader2, ChevronDown, ChevronUp, ArrowUp, ArrowDown, Search, Cpu, Zap } from "lucide-react";
import type { PipelineResult, InFlightEntry, PipelinePhase, CoinSignals } from "./types";
import { wkToEst } from "./utils";

interface PipelineStatusPanelProps {
  results: PipelineResult[];
  inFlight: InFlightEntry[];
  liveSignals?: Record<string, CoinSignals>;
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

function PhaseLabel({ phase }: { phase: PipelinePhase }) {
  switch (phase) {
    case "waiting-target":
      return (
        <span className="flex items-center gap-1 text-amber-400">
          <Clock className="w-3 h-3 animate-pulse" />
          Waiting for strike…
        </span>
      );
    case "fetching-data":
      return (
        <span className="flex items-center gap-1 text-amber-400">
          <Search className="w-3 h-3 animate-spin" />
          Fetching data…
        </span>
      );
    case "claude-analyzing":
      return (
        <span className="flex items-center gap-1 text-violet-400">
          <Brain className="w-3 h-3 animate-pulse" />
          Claude thinking…
        </span>
      );
    case "ml-analyzing":
      return (
        <span className="flex items-center gap-1 text-blue-400">
          <Cpu className="w-3 h-3 animate-spin" />
          ML predicting…
        </span>
      );
    case "ready":
      return (
        <span className="flex items-center gap-1 text-emerald-400">
          <CheckCircle2 className="w-3 h-3" />
          Ready
        </span>
      );
  }
}

export function PipelineStatusPanel({ results, inFlight, liveSignals }: PipelineStatusPanelProps) {
  const [open, setOpen] = useState(true);

  const inFlightSyms = inFlight.map(e => e.sym);
  const allReady = inFlight.length === 0 && results.length > 0;
  const anyInFlight = inFlight.length > 0;

  // Show which phase most coins are waiting on for the header label
  const waitingForTarget = inFlight.filter(e => e.phase === "waiting-target");
  const claudeThinking = inFlight.filter(e => e.phase === "claude-analyzing");

  const headerLabel = waitingForTarget.length > 0
    ? `Waiting for Kalshi strike… (${waitingForTarget.map(e => e.sym).join(", ")})`
    : claudeThinking.length > 0
    ? `Claude analyzing… (${claudeThinking.map(e => e.sym).join(", ")})`
    : anyInFlight
    ? `Analyzing… (${inFlightSyms.join(", ")})`
    : null;

  const headerColor = anyInFlight
    ? "text-amber-400"
    : allReady
    ? "text-emerald-400"
    : "text-muted-foreground";

  const HeaderIcon = anyInFlight
    ? (waitingForTarget.length > 0 ? Clock : claudeThinking.length > 0 ? Brain : Loader2)
    : allReady ? CheckCircle2 : Brain;
  const headerIconClass = anyInFlight ? "animate-pulse" : "";

  const windowKey = results[0]?.windowKey ?? inFlight[0]?.windowKey ?? null;

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
          {headerLabel && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 animate-pulse">
              {headerLabel}
            </span>
          )}
          {allReady && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Zap className="w-3 h-3 inline mr-1" />
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
          {results.length === 0 && inFlight.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              Pipeline runs at window open. Waits for Kalshi to publish the new strike before analyzing.
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
                    const entry = inFlight.find(e => e.sym === r.sym);
                    const isRechecking = !!entry?.isRecheck;
                    // Prefer live unified signals (same source as predictor page) over
                    // stale pipeline result snapshots — eliminates mid-window display drift.
                    const live = liveSignals?.[r.sym];
                    const statAbove = live?.statAbove ?? r.statAbove;
                    const statConfidence = live?.statConfidence ?? r.statConfidence;
                    const claudeAbove = live?.claudeAbove ?? r.claudeAbove;
                    const claudeConfidence = live?.claudeConfidence ?? r.claudeConfidence;
                    const mlAbove = live?.mlAbove ?? r.mlAbove;
                    const mlConfidence = live?.mlConfidence ?? r.mlConfidence;
                    return (
                      <tr key={r.sym} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-3 font-bold text-foreground">{r.sym}</td>
                        <td className="py-2 pr-3">
                          {isRechecking ? (
                            <PhaseLabel phase={entry!.phase} />
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
                          <SignalDot above={statAbove} confidence={statConfidence} />
                        </td>
                        <td className="py-2 pr-3">
                          <SignalDot above={claudeAbove} confidence={claudeConfidence} />
                        </td>
                        <td className="py-2 pr-3">
                          <SignalDot above={mlAbove} confidence={mlConfidence} />
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
                  {inFlight
                    .filter(e => !results.some(r => r.sym === e.sym))
                    .map(entry => (
                      <tr key={`inflight-${entry.sym}`} className="border-b border-border/50 last:border-0 opacity-70">
                        <td className="py-2 pr-3 font-bold text-foreground">{entry.sym}</td>
                        <td className="py-2 pr-3" colSpan={7}>
                          <PhaseLabel phase={entry.phase} />
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
