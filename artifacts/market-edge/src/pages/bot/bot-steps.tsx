import { useState } from "react";
import {
  ListChecks, CheckCircle2, Clock, ChevronDown, ChevronUp,
  ArrowUp, ArrowDown, Ban, Brain, Cpu, BarChart2, Target,
} from "lucide-react";
import type { BotStepEntry, BotStepOpeningCall } from "./types";
import { wkToEstRange, ET_LABEL } from "./utils";

interface BotStepsPanelProps {
  steps: BotStepEntry[];
  minConfidence: number | null;
  decisionMode: string | null;
  windowKey: string | null;
}

const COIN_ORDER = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "HYPE"];

function CheckItem({
  label,
  icon: Icon,
  ok,
  detail,
}: {
  label: string;
  icon: typeof Target;
  ok: boolean;
  detail?: string | null;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${
        ok
          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
          : "bg-muted/30 text-muted-foreground/60 border-border"
      }`}
      title={`${label}${detail ? `: ${detail}` : ""}`}
    >
      <Icon className="w-3 h-3" />
      {label}
      {ok ? (
        <CheckCircle2 className="w-3 h-3" />
      ) : (
        <Clock className="w-3 h-3 animate-pulse" />
      )}
    </span>
  );
}

function DirBadge({ above, confidence }: { above: boolean | null; confidence: number | null }) {
  if (above === null) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold tabular-nums ${above ? "text-emerald-400" : "text-red-400"}`}>
      {above ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {confidence != null ? `${confidence.toFixed(0)}%` : above ? "YES" : "NO"}
    </span>
  );
}

function OriginalDecisionLabel({ decision, minConfidence }: { decision: string; minConfidence: number | null }) {
  switch (decision) {
    case "BET_YES":  return <span className="text-emerald-400/70"><ArrowUp className="inline w-2.5 h-2.5" /> YES</span>;
    case "BET_NO":   return <span className="text-red-400/70"><ArrowDown className="inline w-2.5 h-2.5" /> NO</span>;
    case "VETO":     return <span className="text-orange-400/70">ML Veto</span>;
    case "BELOW_MIN":return <span className="text-muted-foreground/50">Below {minConfidence != null ? `${minConfidence}%` : "min"}</span>;
    case "NO_MARKET":return <span className="text-muted-foreground/50">No market</span>;
    case "WAITING":  return <span className="text-amber-400/50">Waiting</span>;
    default:         return <span className="text-muted-foreground/50">{decision}</span>;
  }
}

function DecisionBadge({ step, minConfidence }: { step: BotStepEntry; minConfidence: number | null }) {
  switch (step.decision) {
    case "BET_YES":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          <ArrowUp className="w-3 h-3" /> BET YES
        </span>
      );
    case "BET_NO":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
          <ArrowDown className="w-3 h-3" /> BET NO
        </span>
      );
    case "VETO":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30">
          <Ban className="w-3 h-3" /> ML VETO
        </span>
      );
    case "BELOW_MIN":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground border border-border">
          Below {minConfidence != null ? `${minConfidence}%` : "min"}
        </span>
      );
    case "NO_MARKET":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground border border-border">
          <Ban className="w-3 h-3" /> No market
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <Clock className="w-3 h-3 animate-pulse" /> Waiting
        </span>
      );
  }
}

function MathBreakdown({ step, minConfidence }: { step: BotStepEntry; minConfidence: number | null }) {
  if (step.decision === "VETO") {
    return (
      <span className="text-[11px] text-orange-400/90">{step.vetoReason}</span>
    );
  }
  if (step.decision === "NO_MARKET") {
    return (
      <span className="text-[11px] text-muted-foreground/60">
        no Kalshi market for this window — skipped
      </span>
    );
  }
  const m = step.math;
  if (!m) {
    const missing: string[] = [];
    if (step.stat.above === null) missing.push("Stat");
    if (step.claude.above === null) missing.push("Claude");
    if (step.ml.above === null) missing.push("ML");
    return (
      <span className="text-[11px] text-muted-foreground/60">
        waiting for {missing.join(", ") || "signals"}…
      </span>
    );
  }
  const passes = step.decision === "BET_YES" || step.decision === "BET_NO";
  return (
    <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
      <span className="text-violet-400" title="Claude confidence (base)">{m.base.toFixed(0)}</span>
      <span className={m.mlAgrees ? "text-blue-400" : "text-muted-foreground/50"} title={m.mlAgrees ? "ML agrees" : "ML dissents (no boost)"}>
        {" "}{m.mlAgrees ? `+${m.mlBoost}` : "+0"}
        <span className="text-[9px] align-top">ML</span>
      </span>
      <span className={m.statAgrees ? "text-cyan-400" : "text-amber-400"} title={m.statAgrees ? "Stat agrees" : "Stat dissents"}>
        {" "}{m.statMod >= 0 ? `+${m.statMod}` : `−${Math.abs(m.statMod)}`}
        <span className="text-[9px] align-top">St</span>
      </span>
      <span className="text-muted-foreground"> = </span>
      <span className={`font-bold ${passes ? "text-emerald-400" : "text-muted-foreground"}`}>
        {m.composite.toFixed(0)}%
      </span>
      {minConfidence != null && (
        <span className={passes ? "text-emerald-400/70" : "text-red-400/70"}>
          {" "}{passes ? "≥" : "<"} {minConfidence}%
        </span>
      )}
    </span>
  );
}

export function BotStepsPanel({ steps, minConfidence, decisionMode, windowKey }: BotStepsPanelProps) {
  const [open, setOpen] = useState(true);

  const ordered = COIN_ORDER.filter(s => steps.some(st => st.sym === s))
    .map(s => steps.find(st => st.sym === s)!)
    .concat(steps.filter(st => !COIN_ORDER.includes(st.sym)));

  const readyCount = ordered.filter(s => s.ready).length;
  const allReady = ordered.length > 0 && readyCount === ordered.length;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <ListChecks className={`w-4 h-4 ${allReady ? "text-emerald-400" : "text-amber-400"}`} />
          <span className="text-sm font-semibold text-foreground">Bot Steps</span>
          {windowKey && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/25 font-mono">
              {wkToEstRange(windowKey)} {ET_LABEL}
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            allReady
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
          }`}>
            {readyCount}/{ordered.length} ready
          </span>
          {decisionMode && decisionMode !== "ml_gate" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/25">
              mode is {decisionMode} — steps show ML Gate math
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-5 pb-4 pt-1">
          <p className="text-[11px] text-muted-foreground mb-2">
            Claude sets direction · ML vetoes only if it disagrees with higher confidence · composite =
            Claude + ML boost + Stat modifier · EV &amp; price gates still checked at entry.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-1.5 pr-3 font-medium w-14">Coin</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Inputs</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Direction</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Math</th>
                  <th className="text-left py-1.5 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map(step => (
                  <tr key={step.sym} className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="py-2.5 pr-3 font-bold text-foreground">{step.sym}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <CheckItem
                          label="Strike"
                          icon={Target}
                          ok={step.strike != null}
                          detail={step.strike != null ? `$${step.strike >= 1000 ? step.strike.toLocaleString() : step.strike}` : null}
                        />
                        <CheckItem
                          label="Stat"
                          icon={BarChart2}
                          ok={step.stat.above !== null}
                          detail={step.stat.above !== null ? `${step.stat.above ? "↑" : "↓"} ${step.stat.confidence?.toFixed(0) ?? "?"}%` : null}
                        />
                        <CheckItem
                          label="Claude"
                          icon={Brain}
                          ok={step.claude.above !== null}
                          detail={step.claude.above !== null ? `${step.claude.above ? "↑" : "↓"} ${step.claude.confidence?.toFixed(0) ?? "?"}%` : null}
                        />
                        <CheckItem
                          label="ML"
                          icon={Cpu}
                          ok={step.ml.above !== null}
                          detail={step.ml.above !== null ? `${step.ml.above ? "↑" : "↓"} ${step.ml.confidence?.toFixed(0) ?? "?"}%` : null}
                        />
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-col gap-0.5">
                        {step.direction ? (
                          <span className={`inline-flex items-center gap-1 font-bold ${step.direction === "YES" ? "text-emerald-400" : "text-red-400"}`}>
                            {step.direction === "YES" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                            {step.direction}
                            <span className="font-normal text-muted-foreground/60 text-[10px]">(Claude)</span>
                          </span>
                        ) : (
                          <DirBadge above={step.claude.above} confidence={null} />
                        )}
                        {step.openingCall && step.openingCall.direction && (
                          step.openingCall.direction !== step.direction ? (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-400/80" title="Direction changed since window open">
                              <span className="text-muted-foreground/50">was</span>
                              {step.openingCall.direction === "YES"
                                ? <><ArrowUp className="w-2.5 h-2.5" />YES</>
                                : <><ArrowDown className="w-2.5 h-2.5" />NO</>}
                              <span className="text-amber-400/60">↻</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/40" title="Same direction since window open">
                              same since open
                            </span>
                          )
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <MathBreakdown step={step} minConfidence={minConfidence} />
                    </td>
                    <td className="py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <DecisionBadge step={step} minConfidence={minConfidence} />
                        {step.openingCall?.decision && step.openingCall.decision !== step.decision && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/80" title="Decision changed since window open">
                            <span className="text-muted-foreground/50">was</span>
                            <OriginalDecisionLabel decision={step.openingCall.decision} minConfidence={minConfidence} />
                            <span className="text-amber-400/60">↻</span>
                          </span>
                        )}
                        {step.openingCall?.decision && step.openingCall.decision === step.decision && step.ready && (
                          <span className="text-[10px] text-muted-foreground/40" title="Same decision since window open">
                            same since open
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
