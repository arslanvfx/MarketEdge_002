import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, AlertTriangle, PowerOff, Trash2 } from "lucide-react";
import { API_BASE, fmt$, fmtDateTime } from "./utils";
import type {
  ScalperSmartExitConfig, ScalperSmartExitLifecycleLedger, ScalperSmartExitReplayReport,
  ScalperSmartExitStatus, SmartExitStatus, SmartExitEvaluation, SmartExitReplayReport,
  SmartExitCapability, SmartExitConfig, SmartExitComponentHealth, SmartExitLifecycleLedger,
  SmartExitSensitivity,
} from "./types";

const fmtConf = (n: number | undefined | null) => n != null ? `${(n * 100).toFixed(1)}%` : "—";
const sensitivityLabel = (value: SmartExitSensitivity | undefined) =>
  value === "more_aggressive" ? "More Aggressive"
    : value === "less_aggressive" ? "Less Aggressive" : "Default";
const RESET_CONFIRMATION = "RESET SMART EXIT HISTORY";
const fmtTime = (iso: string) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour12: true,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
};
const fmtEasternDate = (iso: string) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
};

function HealthDot({ label, health }: { label: string; health?: SmartExitComponentHealth }) {
  const safeHealth = health ?? {
    status: "unavailable" as const,
    receiptAgeMs: null,
    eventAgeMs: null,
  };
  const colors = {
    fresh: "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]",
    delayed: "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]",
    quiet: "bg-slate-600",
    unavailable: "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"
  };
  const receipt = safeHealth.receiptAgeMs != null ? `rec ${Math.max(0, safeHealth.receiptAgeMs / 1000).toFixed(1)}s` : "no rec";
  const event = safeHealth.eventAgeMs != null ? `evt ${Math.max(0, safeHealth.eventAgeMs / 1000).toFixed(1)}s` : "no evt";
  const title = `${label}: ${safeHealth.status} (${receipt}, ${event})`;
  return (
    <div className="flex flex-col items-center gap-1.5 group cursor-default" title={title}>
      <span className="text-[8px] font-mono text-slate-600 group-hover:text-slate-400 transition-colors leading-none">{label}</span>
      <div className={`w-1.5 h-1.5 rounded-full ${colors[safeHealth.status] || "bg-slate-700"}`} />
    </div>
  );
}

function getRecStyle(rec: string, executed?: boolean) {
  switch (rec) {
    case "hold": return "bg-slate-800 text-slate-400 border-slate-700";
    case "watch": return "bg-blue-900/40 text-blue-400 border-blue-800/50";
    case "prepare_exit": return "bg-amber-900/40 text-amber-400 border-amber-800/50";
    case "exit": return executed ? "bg-red-900/40 text-red-400 border-red-800/50" : "bg-indigo-900/40 text-indigo-400 border-indigo-800/50";
    case "unavailable": return "bg-red-950/40 text-red-500 border-red-900/50";
    default: return "bg-slate-800 text-slate-400 border-slate-700";
  }
}

function RecBadge({ ev, mode }: { ev: SmartExitEvaluation, mode: string }) {
  const style = getRecStyle(ev.recommendation, ev.executed);
  let sub = "";
  if (ev.recommendation === "exit" && !ev.executed) {
    sub = ev.executionStatus === "unknown" ? "Unknown" : ev.executionStatus === "blocked" ? "Blocked" : mode === "shadow" ? "Shadow" : "Pending";
  }
  return (
    <div className={`inline-flex items-center px-2 py-0.5 rounded-[4px] text-[9px] font-bold uppercase tracking-wider border ${style}`}>
      {ev.recommendation === "unavailable" ? "UNAVAILABLE" : ev.recommendation}
      {sub && <span className="ml-1.5 pl-1.5 border-l border-current opacity-70">{sub}</span>}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-4 py-2 border-b border-white/10 bg-white/[0.02] text-[10px] font-bold uppercase tracking-widest text-slate-400">
      {title}
    </div>
  );
}

interface Props {
  authPost: (path: string, body: object) => Promise<unknown>;
}

function ScalperSmartExitSection({
  authPost,
  canManage,
}: {
  authPost: Props["authPost"];
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data: status } = useQuery<ScalperSmartExitStatus>({
    queryKey: ["scalper-smart-exit-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/smart-exit/status`).then((r) => r.json()),
    refetchInterval: 1_000,
  });
  const { data: lifecycle } = useQuery<ScalperSmartExitLifecycleLedger>({
    queryKey: ["scalper-smart-exit-lifecycle"],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/smart-exit/lifecycle?limit=100`).then((r) => r.json()),
    refetchInterval: 15_000,
  });
  const { data: replay } = useQuery<{
    reports: ScalperSmartExitReplayReport[];
    disclaimer: string;
  }>({
    queryKey: ["scalper-smart-exit-replay"],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/smart-exit/replay`).then((r) => r.json()),
    refetchInterval: 60_000,
  });
  const update = async (patch: Partial<ScalperSmartExitConfig>) => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      await authPost("/crypto/scalper/smart-exit/config", patch);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["scalper-smart-exit-status"] }),
        qc.invalidateQueries({ queryKey: ["scalper-smart-exit-lifecycle"] }),
      ]);
    } finally {
      setBusy(false);
    }
  };
  const activateMode = (mode: ScalperSmartExitConfig["mode"]) => {
    // Live activation deliberately carries both fields in one authenticated request.
    void update({ mode, enabled: mode !== "off" });
  };
  const actual = lifecycle?.summary.actual;
  const shadow = lifecycle?.summary.shadowObserved;

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-amber-300/25 bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.11),transparent_38%),#070706] shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-amber-200/15 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-300/30 bg-amber-400/10 shadow-[inset_0_0_18px_rgba(251,191,36,0.08)]">
            <Shield className="h-4 w-4 text-amber-200" />
          </div>
          <div>
            <h2 className="text-sm font-bold tracking-tight text-amber-50">High-Value Scalper · Fast Smart Exit</h2>
            <p className="mt-0.5 text-[10px] text-amber-100/50">
              Dedicated 1-second owner, ledger, authenticated depth and reconciliation boundary.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-amber-200/15 bg-black/50 p-0.5">
            {(["off", "shadow", "paper-exit", "live-exit"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={busy || !canManage}
                onClick={() => activateMode(mode)}
                className={`rounded-md px-2.5 py-1 text-[9px] font-black uppercase tracking-wider transition ${
                  status?.config.mode === mode
                    ? mode === "live-exit"
                      ? "bg-red-500 text-white"
                      : "bg-amber-300 text-black"
                    : "text-amber-100/45 hover:bg-amber-200/10 hover:text-amber-50"
                } disabled:opacity-40`}
              >
                {mode.replace("-", " ")}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy || !canManage || !status?.config.enabled}
            onClick={() => void authPost("/crypto/scalper/smart-exit/emergency-disable", {})
              .then(() => qc.invalidateQueries({ queryKey: ["scalper-smart-exit-status"] }))}
            className="rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-wider text-red-200 disabled:opacity-40"
          >
            E-Stop
          </button>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="border-b border-amber-200/10 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200/10 px-4 py-3">
            <div>
              <div className="text-[9px] font-black uppercase tracking-[0.18em] text-amber-200/65">Current fast evaluations</div>
              <div className="mt-1 font-mono text-[9px] text-amber-50/35">
                {status?.started ? "MONITOR ONLINE" : "MONITOR OFFLINE"} · {status?.schedulerMs ?? 1_000}ms · v{status?.configVersion ?? 0}
              </div>
            </div>
            <div className="flex rounded-md border border-amber-200/10 bg-black/40 p-0.5">
              {(["more_aggressive", "default", "less_aggressive"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy || !canManage}
                  onClick={() => void update({ sensitivity: value })}
                  className={`rounded px-2 py-1 text-[8px] font-bold uppercase ${
                    status?.config.sensitivity === value
                      ? "bg-amber-300 text-black"
                      : "text-amber-100/45 hover:text-amber-50"
                  } disabled:opacity-40`}
                >
                  {value.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full min-w-[720px] text-left text-[10px]">
              <thead className="sticky top-0 bg-[#0a0907] text-[8px] uppercase tracking-wider text-amber-100/35">
                <tr><th className="px-4 py-2">Market</th><th className="px-3 py-2">Decision</th><th className="px-3 py-2">Velocity / Accel</th><th className="px-3 py-2">Crossing</th><th className="px-3 py-2">Kalshi</th><th className="px-3 py-2">Qty</th></tr>
              </thead>
              <tbody>
                {(status?.evaluations ?? []).map((evaluation) => (
                  <tr key={evaluation.orderId} className="border-t border-amber-200/[0.06] text-amber-50/75">
                    <td className="px-4 py-2"><span className="font-bold text-amber-100">{evaluation.symbol}</span><div className="max-w-32 truncate font-mono text-[8px] text-amber-100/35">{evaluation.ticker}</div></td>
                    <td className="px-3 py-2"><span className={`rounded border px-1.5 py-0.5 font-black uppercase ${evaluation.disposition === "exit" ? "border-red-400/40 bg-red-500/15 text-red-200" : evaluation.disposition === "blocked" ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-white/10 bg-white/5 text-white/55"}`}>{evaluation.disposition}</span><div className="mt-1 max-w-48 truncate text-[8px] text-amber-50/35" title={evaluation.reason}>{evaluation.reason}</div></td>
                    <td className="px-3 py-2 font-mono">{evaluation.adverseVelocityPerSecond?.toFixed(3) ?? "—"} / {evaluation.adverseAccelerationPerSecond2?.toFixed(3) ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{evaluation.projectedCrossingSeconds?.toFixed(1) ?? "—"}s <span className="text-amber-100/30">/ {evaluation.secondsRemaining.toFixed(1)}s</span></td>
                    <td className="px-3 py-2 font-mono">{evaluation.marketDeterioration == null ? "—" : `${(evaluation.marketDeterioration * 100).toFixed(1)}¢`}</td>
                    <td className="px-3 py-2 font-mono">{evaluation.remainingQuantity}</td>
                  </tr>
                ))}
                {!status?.evaluations?.length && <tr><td colSpan={6} className="px-4 py-8 text-center font-mono text-amber-50/30">No filled Scalper positions are currently being monitored.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-4">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-amber-200/65">Effectiveness ledger</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              ["ACTUAL NET", actual?.netValue, actual?.scoreable ?? 0],
              ["SHADOW NET", shadow?.netValue, shadow?.scoreable ?? 0],
              ["GROSS SAVED", actual?.grossMoneySaved, actual?.helped ?? 0],
              ["FORFEITED", actual?.grossMoneyForfeited, actual?.harmed ?? 0],
            ].map(([label, value, count]) => (
              <div key={String(label)} className="rounded-lg border border-amber-200/10 bg-amber-100/[0.035] p-3">
                <div className="text-[8px] font-bold uppercase tracking-wider text-amber-100/40">{label}</div>
                <div className={`mt-1 font-mono text-sm font-black ${Number(value ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}`}>{value == null ? "—" : fmt$(Number(value))}</div>
                <div className="mt-0.5 text-[8px] text-amber-100/30">{count} scoreable outcomes</div>
              </div>
            ))}
          </div>
          <div className="mt-4 text-[9px] font-black uppercase tracking-[0.18em] text-amber-200/65">Same-snapshot replay</div>
          <div className="mt-2 space-y-1.5">
            {(replay?.reports ?? []).map((report) => (
              <div key={report.sensitivity} className="flex items-center justify-between rounded-md border border-amber-200/10 bg-black/30 px-2.5 py-2 text-[9px]">
                <span className="font-bold uppercase text-amber-100/60">{report.sensitivity.replace("_", " ")}</span>
                <span className="font-mono text-amber-50/45">{report.triggered} exits · {report.helped} helped · {report.harmed} harmed</span>
                <span className={`font-mono font-black ${report.netValue >= 0 ? "text-emerald-300" : "text-red-300"}`}>{fmt$(report.netValue)}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[8px] leading-relaxed text-amber-100/30">{replay?.disclaimer ?? "Replay waits for settled positions with persisted post-entry evidence."}</p>
        </div>
      </div>
    </div>
  );
}

export function BotSmartExitPanel({ authPost }: Props) {
  const { getToken, isLoaded: authLoaded } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [applyForm, setApplyForm] = useState({ symbol: "", owner: "", version: "" });

  const { data: capability } = useQuery<SmartExitCapability>({
    queryKey: ["smart-exit-capability"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/crypto/smart-exit/capability`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (!res.ok) throw new Error("Capability fetch failed");
      return res.json();
    },
    enabled: authLoaded,
  });

  const { data: status } = useQuery<SmartExitStatus>({
    queryKey: ["smart-exit-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/smart-exit/status`).then(r => r.json()),
    refetchInterval: 1000,
  });

  const { data: lifecycle } = useQuery<SmartExitLifecycleLedger>({
    queryKey: ["smart-exit-lifecycle"],
    queryFn: () => fetch(`${API_BASE}/crypto/smart-exit/lifecycle?limit=100`).then(r => r.json()),
    refetchInterval: 15000,
  });

  const { data: replay } = useQuery<{ reports: SmartExitReplayReport[] }>({
    queryKey: ["smart-exit-replay"],
    queryFn: () => fetch(`${API_BASE}/crypto/smart-exit/replay`).then(r => r.json()),
    refetchInterval: 60000,
  });
  
  async function updateConfig(patch: Partial<SmartExitConfig>) {
    if (!capability?.canManage || busy) return;
    setBusy(true);
    try {
      await authPost("/crypto/smart-exit/config", patch);
      await qc.invalidateQueries({ queryKey: ["smart-exit-status"] });
    } finally {
      setBusy(false);
    }
  }

  async function emergencyDisable() {
    if (!capability?.canManage || busy) return;
    setBusy(true);
    try {
      await authPost("/crypto/smart-exit/emergency-disable", {});
      await qc.invalidateQueries({ queryKey: ["smart-exit-status"] });
    } finally {
      setBusy(false);
    }
  }
  
  async function applyParams() {
    if (!capability?.canManage || !applyForm.symbol || busy) return;
    setBusy(true);
    try {
      await authPost("/crypto/smart-exit/apply-parameters", applyForm);
      await qc.invalidateQueries({ queryKey: ["smart-exit-status"] });
      setApplyForm({ symbol: "", owner: "", version: "" });
    } finally {
      setBusy(false);
    }
  }

  async function resetExitHistory() {
    if (!capability?.canManage || busy || resetBusy) return;
    const confirmation = window.prompt(
      "This permanently deletes everything shown in Exit Lifecycle & Effectiveness, "
      + "including all per-mode replay and calibration statistics.\n\n"
      + "It does not delete Smart Exit settings/applied versions, positions, bets, orders, "
      + "or execution requests.\n\n"
      + `Type ${RESET_CONFIRMATION} to continue:`,
    );
    if (confirmation !== RESET_CONFIRMATION) {
      if (confirmation !== null) {
        setResetFeedback({ kind: "error", text: "Reset cancelled: confirmation text did not match." });
      }
      return;
    }
    setResetBusy(true);
    setResetFeedback(null);
    try {
      const result = await authPost("/crypto/smart-exit/history/reset", {
        confirmation: RESET_CONFIRMATION,
      }) as {
        ok?: boolean;
        deleted?: Record<string, number>;
        error?: string;
      };
      if (!result.ok || !result.deleted) {
        throw new Error(result.error ?? "The server did not confirm the history reset.");
      }
      await Promise.all([
        qc.cancelQueries({ queryKey: ["smart-exit-lifecycle"] }),
        qc.cancelQueries({ queryKey: ["smart-exit-replay"] }),
        qc.cancelQueries({ queryKey: ["smart-exit-status"] }),
      ]);
      const emptyAccounting = {
        triggered: 0,
        settled: 0,
        scoreable: 0,
        pending: 0,
        helped: 0,
        harmed: 0,
        grossMoneySaved: 0,
        grossMoneyForfeited: 0,
        netValue: 0,
      };
      qc.setQueryData<SmartExitLifecycleLedger>(["smart-exit-lifecycle"], {
        records: [],
        coverage: [],
        summary: {
          triggered: 0,
          sold: 0,
          settled: 0,
          helped: 0,
          harmed: 0,
          grossMoneySaved: 0,
          grossMoneyForfeited: 0,
          netValue: 0,
          scoreable: 0,
          pending: 0,
          coverageTotal: 0,
          unavailable: 0,
          totalValueSaved: 0,
          actual: emptyAccounting,
          shadowObserved: emptyAccounting,
        },
      });
      qc.setQueryData<{ reports: SmartExitReplayReport[] }>(
        ["smart-exit-replay"],
        { reports: [] },
      );
      qc.setQueryData<SmartExitStatus>(
        ["smart-exit-status"],
        current => current ? {
          ...current,
          evaluations: [],
          health: { ...current.health, activeEvaluations: 0 },
        } : current,
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["smart-exit-lifecycle"] }),
        qc.invalidateQueries({ queryKey: ["smart-exit-replay"] }),
        qc.invalidateQueries({ queryKey: ["smart-exit-status"] }),
      ]);
      const total = Object.values(result.deleted).reduce((sum, count) => sum + count, 0);
      setResetFeedback({
        kind: "success",
        text: `Smart Exit history cleared (${total} historical rows deleted).`,
      });
    } catch (error) {
      setResetFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : "Smart Exit history could not be reset.",
      });
    } finally {
      setResetBusy(false);
    }
  }

  const mode = status?.config?.enabled ? status.config.mode : "off";
  
  const modeColors = {
    "off": "bg-white/10 text-white shadow-sm",
    "shadow": "bg-indigo-600 text-white shadow-sm",
    "paper-exit": "bg-amber-600 text-white shadow-sm",
    "live-exit": "bg-red-600 text-white shadow-sm"
  };

  const modeLabels = {
    "off": "Disabled",
    "shadow": "Shadow",
    "paper-exit": "Paper",
    "live-exit": "Live"
  };

  const lifecycleRows = (() => {
    const windowBands = new Map<string, number>();
    let previousWindow: string | null = null;

    return (lifecycle?.records ?? []).map((item) => {
      if (!windowBands.has(item.ticker)) {
        windowBands.set(item.ticker, windowBands.size);
      }
      const startsWindow = previousWindow !== null && previousWindow !== item.ticker;
      previousWindow = item.ticker;

      return {
        item,
        startsWindow,
        windowBand: windowBands.get(item.ticker) ?? 0,
      };
    });
  })();
  const exitSummary = lifecycle?.summary;
  const regularEvaluations = (status?.evaluations ?? []).filter((evaluation) =>
    evaluation.owner === "regular");
  const counterfactual = replay?.reports?.find((report) =>
    report.kind === "global_counterfactual"
    && report.owner === "regular"
    && report.symbol === "GLOBAL"
    && report.version === "global-counterfactual-v1",
  )?.globalComparison;

  return (
    <>
    <div className="bg-[#0b0d13] border border-white/10 rounded-xl overflow-hidden mb-6 flex flex-col shadow-2xl [&_.text-slate-700]:!text-slate-400 [&_.text-slate-600]:!text-slate-400 [&_.text-slate-500]:!text-slate-300 [&_.text-slate-400]:!text-slate-200">
      <div className="px-4 py-3 border-b border-white/10 flex flex-wrap items-center justify-between gap-4 bg-white/[0.02]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
            <Shield className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-slate-200 tracking-tight leading-tight">Smart Exit Subsystem</h2>
            <div className="text-[10px] font-mono text-slate-500 flex items-center gap-2 mt-0.5 tabular-nums leading-tight">
               <span className="flex items-center gap-1.5">
                 <div className={`w-1.5 h-1.5 rounded-full ${status?.health?.dataReadiness === 'ready' ? 'bg-emerald-500' : status?.health?.dataReadiness === 'degraded' ? 'bg-amber-500' : 'bg-red-500'}`} />
                 {status?.health?.dataReadiness?.toUpperCase() || 'UNAVAILABLE'}
               </span>
               <span className="text-slate-700 px-0.5">|</span>
               <span>EVALS: <span className="text-slate-300">{regularEvaluations.length}</span></span>
               <span className="text-slate-700 px-0.5">|</span>
               <span>
                 HOT: <span className="text-slate-300">{status?.health?.targetCadenceMs ?? 500}ms</span>
                 {status?.health?.lastHotCycleDurationMs != null
                   ? <span className="text-slate-500"> / {status.health.lastHotCycleDurationMs}ms</span>
                   : null}
               </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex bg-black/40 border border-white/10 rounded-lg overflow-hidden p-0.5">
            {(["off", "shadow", "paper-exit", "live-exit"] as const).map(m => (
              <button
                key={m}
                onClick={() => updateConfig({ mode: m })}
                disabled={busy || !capability?.canManage}
                className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${
                  mode === m 
                    ? modeColors[m] 
                    : "text-slate-500 hover:text-slate-300 hover:bg-white/5 disabled:opacity-50"
                }`}
              >
                {modeLabels[m]}
              </button>
            ))}
          </div>
          <button
            onClick={emergencyDisable}
            disabled={busy || !capability?.canManage || mode === "off"}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 disabled:grayscale transition-all"
          >
            <PowerOff className="w-3 h-3" /> E-Stop
          </button>
        </div>
      </div>
      
      {!capability?.canManage && capability?.message && (
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-[10px] font-mono flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          {capability.message}
        </div>
      )}

      <div className="flex flex-col divide-y divide-white/10">
        <div className="px-4 py-3 bg-[#0d1017]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Smart Exit sensitivity · {sensitivityLabel(status?.config?.sensitivity)}
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                Changes how quickly credible target-crossing risk becomes actionable. All liquidity, economics, ownership, freshness, and loss guards remain enforced.
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
              {([
                ["more_aggressive", "More Aggressive", "Fewer sustained samples; reacts to smaller credible deterioration."],
                ["default", "Default", "Current balanced behavior."],
                ["less_aggressive", "Less Aggressive", "Waits for stronger, sustained deterioration and more recovery room."],
              ] as const).map(([value, label, description]) => (
                <button
                  key={value}
                  type="button"
                  title={description}
                  aria-label={`${label}: ${description}`}
                  onClick={() => updateConfig({ sensitivity: value })}
                  disabled={busy || !capability?.canManage}
                  className={`flex max-w-[150px] flex-col rounded-md px-2.5 py-1.5 text-left transition-colors disabled:opacity-50 ${
                    (status?.config?.sensitivity ?? "default") === value
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="text-[9px] font-bold uppercase tracking-wide">{label}</span>
                  <span className="mt-0.5 whitespace-normal text-[8px] font-normal leading-tight opacity-70">
                    {description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        
        {/* Full-width active area */}
        <div className="flex flex-col h-full bg-[#0d1017]">
          <SectionHeader title="Current Evaluations" />
          <div className="overflow-x-auto overflow-y-auto min-h-[252px] max-h-[704px]">
            <table className="w-full min-w-[760px] table-fixed text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5 text-[9px] text-slate-500 uppercase tracking-wider">
                  <th className="w-[110px] px-4 py-2 font-medium">Market</th>
                  <th className="w-[160px] px-4 py-2 font-medium">Action & Status</th>
                  <th className="w-[160px] px-4 py-2 font-medium">Risk & Timing</th>
                  <th className="w-[180px] px-4 py-2 font-medium">Pricing & Liq</th>
                  <th className="w-[150px] px-4 py-2 font-medium">Telemetry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                 {regularEvaluations.map(ev => (
                  <tr key={ev.id || `${ev.symbol}-${ev.windowKey}`} className="hover:bg-white/[0.02] transition-colors h-[84px]">
                    <td className="px-4 py-3 align-middle">
                      <div className="flex flex-col gap-1 w-full pr-2">
                        <span className="font-bold text-slate-200 text-xs truncate">{ev.symbol}</span>
                        {ev.ticker ? (
                          <span className="text-[9px] text-slate-500 font-mono truncate" title={ev.ticker}>{ev.ticker}</span>
                        ) : (
                          <span className="text-[9px] text-slate-700 font-mono">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <div className="flex flex-col gap-2 w-full pr-4">
                        <div className="flex items-center h-5">
                          <RecBadge ev={ev} mode={mode} />
                        </div>
                        <div className="h-4 flex items-center">
                          {ev.recommendation === "unavailable" ? (
                            <span
                              className="truncate text-[9px] font-mono text-red-400"
                              title={ev.reason}
                            >
                              Missing: {ev.degradedComponents?.length
                                ? ev.degradedComponents.join(", ").replaceAll("_", " ")
                                : ev.reason}
                            </span>
                          ) : ev.debounceTarget && ev.debounceTarget > 1 ? (
                            <div className="flex items-center gap-2 w-full">
                              <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                                <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, ((ev.debounceProgress || 0) / ev.debounceTarget) * 100)}%` }} />
                              </div>
                              <span className="text-[10px] font-mono text-slate-400 tabular-nums leading-none">
                                {ev.debounceProgress}/{ev.debounceTarget}
                              </span>
                            </div>
                          ) : ev.confidence != null ? (
                             <span className="text-[10px] font-mono text-slate-400">Conf: {fmtConf(ev.confidence)}</span>
                          ) : (
                             <span className="text-[10px] font-mono text-slate-600">—</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle text-[10px] font-mono tabular-nums">
                      <div className="flex flex-col gap-1 w-full pr-4">
                         <div className="flex justify-between items-center w-full">
                            <span className="text-slate-500">Sale loss</span>
                            {(ev.capitalLossFraction ?? ev.marketLossFraction) != null ? (
                              <span className={(ev.capitalLossFraction ?? ev.marketLossFraction ?? 0) > 0 ? "text-red-400" : "text-emerald-400"}>
                                {((ev.capitalLossFraction ?? ev.marketLossFraction ?? 0) * 100).toFixed(1)}%
                              </span>
                           ) : <span className="text-slate-600">—</span>}
                        </div>
                         {ev.deepLossHoldActive && (
                           <div className="flex justify-between items-center w-full">
                             <span className="text-amber-300">Guard</span>
                             <span className="text-amber-300 uppercase">
                               {ev.deepLossHoldKind === "terminal" ? "90% hold" : "Recovery hold"}
                             </span>
                           </div>
                         )}
                        <div className="flex justify-between items-center w-full">
                            <span className="text-slate-500">Band</span>
                            <span className={`uppercase ${
                              ev.timeBand === "critical" ? "text-red-400"
                                : ev.timeBand === "urgent" ? "text-amber-300"
                                  : ev.timeBand === "escalation" ? "text-blue-300"
                                    : "text-slate-300"
                            }`}>{ev.timeBand ?? "—"}</span>
                         </div>
                         <div className="flex justify-between items-center w-full">
                           <span className="text-slate-500">Rem</span>
                           {ev.secondsRemaining != null ? (
                             <span className="text-slate-300">{ev.secondsRemaining}s</span>
                           ) : <span className="text-slate-600">—</span>}
                        </div>
                        <div className="flex justify-between items-center w-full">
                           <span className="text-slate-500">Cross</span>
                           {ev.projectedCrossingSeconds != null ? (
                             <span className="text-slate-300">{ev.projectedCrossingSeconds.toFixed(1)}s</span>
                           ) : ev.projectedCrossBeforeExpiry != null ? (
                             <span className={ev.projectedCrossBeforeExpiry ? "text-red-400" : "text-emerald-400"}>
                               {ev.projectedCrossBeforeExpiry ? "< Expiry" : "None"}
                             </span>
                           ) : <span className="text-slate-600">—</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle text-[10px] font-mono tabular-nums">
                      <div className="flex flex-col gap-1 w-full pr-4">
                        <div className="flex justify-between items-center w-full">
                           <span className="text-slate-500">Hold / Sale</span>
                           <span>
                             <span className="text-slate-300">{ev.expectedHoldValue != null ? fmt$(ev.expectedHoldValue) : "—"}</span>
                             <span className="text-slate-600 mx-1.5">/</span>
                             <span className="text-slate-300">{ev.estimatedSaleValue != null ? fmt$(ev.estimatedSaleValue) : "—"}</span>
                           </span>
                        </div>
                        <div className="flex justify-between items-center w-full">
                           <span className="text-slate-500">Bid / Ask</span>
                           <span>
                             <span className="text-slate-300">{ev.marketBestBid != null ? (ev.marketBestBid * 100).toFixed(1) + '¢' : "—"}</span>
                             <span className="text-slate-600 mx-1.5">/</span>
                             <span className="text-slate-300">{ev.marketBestAsk != null ? (ev.marketBestAsk * 100).toFixed(1) + '¢' : "—"}</span>
                           </span>
                        </div>
                        <div className="flex justify-between items-center w-full">
                           <span className="text-slate-500">Liq Cover</span>
                           {ev.liquidityCoverage != null ? (
                             <span className="text-slate-300">{(ev.liquidityCoverage * 100).toFixed(0)}%</span>
                           ) : <span className="text-slate-600">—</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <div className="flex flex-col gap-2 w-full">
                        <div className="flex items-center gap-2">
                          <div className={`px-1.5 py-0.5 rounded-[3px] text-[9px] font-bold tracking-wider uppercase border ${
                            ev.currentDataStatus === "fresh" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                            ev.currentDataStatus === "degraded" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                            "bg-slate-800 text-slate-500 border-slate-700"
                          }`}>
                            {ev.currentDataStatus || "UNK"}
                          </div>
                         <div className="text-[9px] font-mono text-indigo-300">
                           Sensitivity: {sensitivityLabel(ev.effectiveSensitivity)}
                         </div>
                          <div className="text-[9px] font-mono text-slate-500 truncate flex-1" title={ev.currentUnavailableReason || ""}>
                            {ev.currentUnavailableReason || "Healthy"}
                          </div>
                        </div>
                          <div
                            className="text-[9px] font-mono text-slate-500"
                            title={ev.adverseLatchExpiresAtSeconds != null
                              ? `Adverse latch expires ${new Date(ev.adverseLatchExpiresAtSeconds * 1000).toISOString()}`
                              : "No adverse trajectory latch"}
                          >
                            {ev.adverseLatchActive ? (
                              <span className="text-amber-300">
                                LATCH {(100 * (ev.adverseExcursionFraction ?? 0)).toFixed(3)}%
                                {" · "}{ev.trajectorySampleCount ?? 0} samples
                              </span>
                            ) : (
                              <span>
                                Trajectory {ev.trajectorySampleCount ?? 0} samples
                                {ev.recoveryProgress ? ` · recovery ${ev.recoveryProgress}/2` : ""}
                              </span>
                            )}
                          </div>
                          <div className="text-[9px] font-mono text-slate-600">
                            Spot evt {ev.spotEventAgeMs == null ? "—" : `${Math.max(0, ev.spotEventAgeMs).toFixed(0)}ms`}
                            {" · "}decision {ev.decisionLatencyMs == null ? "—" : `${ev.decisionLatencyMs}ms`}
                          </div>
                        <div className="flex items-center justify-between w-full pr-2">
                           <HealthDot label="SPT" health={ev.liveComponentHealth?.spot} />
                           <HealthDot label="TPE" health={ev.liveComponentHealth?.tape} />
                           <HealthDot label="CBK" health={ev.liveComponentHealth?.coinbaseBook} />
                           <HealthDot label="KQU" health={ev.liveComponentHealth?.kalshiQuote} />
                           <HealthDot label="KBK" health={ev.liveComponentHealth?.kalshiBook} />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
                 {regularEvaluations.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-4 text-center text-slate-600 text-[10px] font-mono italic h-[84px] align-middle">No active evaluations</td></tr>
                )}
              </tbody>
            </table>
          </div>

        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(420px,1fr)] divide-y xl:divide-y-0 xl:divide-x divide-white/10">
        <div className="flex flex-col h-full bg-[#0d1017]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/[0.02] px-4 py-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Exit Lifecycle &amp; Effectiveness · {lifecycle?.summary.triggered ?? 0} triggered · {lifecycle?.summary.sold ?? 0} sold · {lifecycle?.summary.settled ?? 0} settled
            </div>
            <button
              type="button"
              data-testid="button-reset-smart-exit-history"
              onClick={resetExitHistory}
              disabled={busy || resetBusy || !capability?.canManage}
              className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-950/30 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-red-400 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              {resetBusy ? "Resetting…" : "Reset Exit History"}
            </button>
          </div>
          {resetFeedback && (
            <div
              data-testid="status-reset-smart-exit-history"
              role="status"
              className={`border-b px-4 py-2 text-[10px] font-mono ${
                resetFeedback.kind === "success"
                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                  : "border-red-500/20 bg-red-500/10 text-red-400"
              }`}
            >
              {resetFeedback.text}
            </div>
          )}
          <div className="border-b border-white/10 bg-[#0a0d14] p-5 lg:p-6">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-200">
                  Exit Decision Scorecard
                </div>
                <div className="mt-1 text-[10px] text-slate-500">
                  Compares each exit signal with what holding that same position to settlement produced.
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[8px] font-bold uppercase tracking-wider">
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-slate-300">
                  {exitSummary?.scoreable ?? 0} settled &amp; scoreable
                </span>
                {(exitSummary?.pending ?? 0) > 0 && (
                  <span className="rounded-full border border-amber-300/20 bg-amber-300/5 px-2 py-1 text-amber-200">
                    {exitSummary?.pending ?? 0} pending
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
              {([
                [
                  "TOTAL SAVED",
                  exitSummary?.grossMoneySaved ?? 0,
                  exitSummary?.helped ?? 0,
                  "Loss avoided by exiting instead of holding to settlement.",
                  "metric-total-saved",
                ],
                [
                  "PROFIT LEFT ON THE TABLE",
                  exitSummary?.grossMoneyForfeited ?? 0,
                  exitSummary?.harmed ?? 0,
                  "Extra profit holding would have produced when an exit was premature.",
                  "metric-profit-left-on-table",
                ],
              ] as const).map(([label, value, outcomes, description, testId]) => (
                <div key={label} className="rounded-lg border border-white/[0.04] bg-[#11141c] p-4 shadow-sm transition-colors hover:bg-[#141822]">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2.5">{label}</div>
                  <div className={`font-mono text-[24px] leading-none font-bold tabular-nums ${
                    label === "PROFIT LEFT ON THE TABLE" ? "text-rose-400" : "text-[#4ade80]"
                  }`} data-testid={testId}>
                    {fmt$(value)}
                  </div>
                  <div className="mt-3 text-[10px] font-medium text-slate-500">
                    {outcomes} of {exitSummary?.scoreable ?? 0} exits · {description}
                  </div>
                </div>
              ))}
            </div>

            <div className="mb-4 text-[11px] font-bold uppercase tracking-[0.18em] text-[#d6b976]">
              SAME-SNAPSHOT REPLAY
            </div>

            {counterfactual ? (
              <div className="flex flex-col gap-2.5">
                {([
                { key: "more_aggressive", label: "MORE AGGRESSIVE" },
                { key: "default", label: "DEFAULT" },
                { key: "less_aggressive", label: "LESS AGGRESSIVE" },
              ] as const).map(({ key, label }) => {
                const modeData = counterfactual?.comparisons?.[key];
                return (
                  <div key={key} className="grid grid-cols-1 gap-3 rounded-lg border border-white/[0.04] bg-[#11141c] px-4 py-3.5 shadow-sm transition-colors hover:bg-[#141822] sm:grid-cols-[150px_minmax(0,1fr)_120px_150px] sm:items-center" data-testid={`replay-row-${key.replace('_', '-')}`}>
                    <span className="text-[11px] font-bold tracking-wider text-slate-300">{label}</span>
                    <span className="text-[10px] font-mono text-slate-500">
                      {modeData?.triggered ?? 0} exits <span className="text-slate-700 mx-1.5">·</span> {modeData?.helped ?? 0} helped <span className="text-slate-700 mx-1.5">·</span> {modeData?.harmed ?? 0} harmed
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 sm:text-right">
                      Saved <strong className="ml-1 text-[#4ade80]" data-testid={`metric-replay-saved-${key.replace("_", "-")}`}>
                        {fmt$(modeData?.grossMoneySaved ?? 0)}
                      </strong>
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 sm:text-right">
                      Left on table <strong className="ml-1 text-rose-400" data-testid={`metric-replay-left-${key.replace("_", "-")}`}>
                        {fmt$(modeData?.grossMoneyForfeited ?? 0)}
                      </strong>
                    </span>
                  </div>
                );
                })}
              </div>
            ) : (
              <div
                className="rounded-lg border border-dashed border-white/10 bg-[#11141c]/60 px-4 py-6 text-center text-[10px] font-mono text-slate-500"
                data-testid="status-smart-exit-replay-empty"
              >
                No like-for-like replay snapshot is available yet. Mode results will appear after settled positions have full executable evidence.
              </div>
            )}

            <div className="mt-5 text-[10px] leading-relaxed text-slate-500 max-w-4xl">
              Replay uses only persisted authenticated executable snapshots. Positions without settlement or full post-entry evidence are excluded rather than assigned fabricated savings.
              Headline totals use confirmed proceeds when an exit filled; replay always uses the executable quote frozen at the policy trigger, so the default replay can differ from the headline.
              {counterfactual && (
                <span className="block mt-1.5 opacity-80">
                  Shared coverage: {counterfactual.sharedCoverage.scoreable}/{counterfactual.sharedCoverage.eligible} eligible situations 
                  (Period {counterfactual.sharedCoverage.period.from ? fmtEasternDate(counterfactual.sharedCoverage.period.from) : "—"}–{counterfactual.sharedCoverage.period.to ? fmtEasternDate(counterfactual.sharedCoverage.period.to) : "—"}).
                </span>
              )}
            </div>
          </div>
          <div className="overflow-x-auto overflow-y-auto max-h-[360px]">
            <table className="w-full min-w-[1080px] table-fixed text-left text-xs whitespace-nowrap">
              <caption className="sr-only">
                Lifecycle ledger includes confirmed filled exits and separately labelled observed shadow simulations. Saved / Forfeited equals exit or shadow P&amp;L minus held-to-result P&amp;L.
              </caption>
              <thead>
                <tr className="border-b border-white/5 text-[9px] text-slate-500 uppercase tracking-wider">
                  <th className="w-[105px] px-4 py-2 font-medium">Triggered</th>
                  <th className="w-[90px] px-4 py-2 font-medium">Market</th>
                  <th className="w-[110px] px-4 py-2 font-medium">Entry</th>
                  <th className="w-[100px] px-4 py-2 font-medium text-right">Stake</th>
                    <th
                    className="w-[120px] px-4 py-2 font-medium text-right"
                      title="P&amp;L from a confirmed sale, or from a clearly-labelled observed shadow simulation."
                      aria-label="Exit or shadow profit and loss"
                  >
                      Exit / Shadow P&amp;L
                  </th>
                  <th
                    className="w-[120px] px-4 py-2 font-medium text-right"
                    title="P&amp;L if the position had been held to its final result."
                    aria-label="Held-to-result profit and loss: P and L if the position had been held to its final result"
                  >
                    Held-to-result P&amp;L
                  </th>
                  <th
                    className="w-[120px] px-4 py-2 font-medium text-right"
                    title="Sell-now P&amp;L minus held-to-result P&amp;L. Positive saved means recovered value versus a final loss; negative forfeited means value surrendered versus holding."
                    aria-label="Saved or forfeited: sell-now profit and loss minus held-to-result profit and loss. Positive saved means recovered value versus a final loss; negative forfeited means value surrendered versus holding."
                  >
                    Saved / Forfeited
                  </th>
                  <th className="w-[120px] px-4 py-2 font-medium">Outcome</th>
                  <th className="w-auto px-4 py-2 font-medium">Effect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {lifecycleRows.map(({ item, startsWindow, windowBand }) => (
                  <tr
                    key={item.id}
                    className={`transition-colors h-12 ${
                      windowBand % 2 === 0
                        ? "bg-slate-950/25 hover:bg-slate-900/45"
                        : "bg-indigo-950/20 hover:bg-indigo-900/30"
                    } ${startsWindow ? "border-t-2 border-indigo-300/20" : ""}`}
                  >
                    <td className="px-4 py-2 align-middle text-[10px] font-mono text-slate-500 tabular-nums">
                      <div>{fmtTime(item.triggeredAt)}</div>
                      <div className="mt-0.5 text-[8px] text-slate-400">
                        {fmtEasternDate(item.triggeredAt)}
                      </div>
                    </td>
                    <td className="px-4 py-2 align-middle font-bold text-slate-200 text-xs">
                      {item.symbol}{" "}
                      <span className={`text-[9px] ${
                        item.side === "yes" ? "text-emerald-400" : "text-red-400"
                      }`}>
                        {item.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2 align-middle text-[10px] font-mono text-slate-300 tabular-nums">
                      <div>{item.entryPriceCents != null ? `${item.entryPriceCents.toFixed(1)}¢` : "—"}</div>
                      <div className="text-[9px] text-slate-600">
                        {item.requestedQuantity != null && item.requestedQuantity !== item.quantity
                          ? `${item.quantity}/${item.requestedQuantity} filled`
                          : `${item.quantity} contracts`}
                      </div>
                    </td>
                    <td className="px-4 py-2 align-middle text-right text-[10px] font-mono text-slate-300 tabular-nums">
                      {item.entryStake != null ? fmt$(item.entryStake) : "—"}
                    </td>
                    <td className={`px-4 py-2 align-middle text-right text-[10px] font-mono tabular-nums ${
                      (item.actualExitPnl ?? item.simulatedExitPnl ?? 0) < 0 ? "text-red-400" : "text-emerald-400"
                    }`}>
                      {(item.actualExitPnl ?? item.simulatedExitPnl) == null
                        ? "—"
                        : fmt$(item.actualExitPnl ?? item.simulatedExitPnl ?? 0)}
                    </td>
                    <td className={`px-4 py-2 align-middle text-right text-[10px] font-mono tabular-nums ${
                      (item.holdPnl ?? 0) < 0 ? "text-red-400" : "text-emerald-400"
                    }`}>
                      {item.holdPnl == null ? "Pending" : fmt$(item.holdPnl)}
                    </td>
                    <td className={`px-4 py-2 align-middle text-right text-[10px] font-bold font-mono tabular-nums ${
                      (item.valueSaved ?? 0) > 0 ? "text-emerald-400" : (item.valueSaved ?? 0) < 0 ? "text-red-400" : "text-slate-500"
                    }`}>
                      {item.valueSaved == null ? "—" : `${item.valueSaved > 0 ? "+" : ""}${fmt$(item.valueSaved)}`}
                    </td>
                    <td className="px-4 py-2 align-middle text-[10px] font-mono text-slate-300">
                      <div>{item.advisoryOnly ? "SHADOW" : item.executionStatus.toUpperCase()}</div>
                      <div className={`text-[9px] ${
                        item.settlementResult === "yes"
                          ? "text-emerald-400"
                          : item.settlementResult === "no"
                            ? "text-red-400"
                            : "text-slate-400"
                      }`}>
                        {item.settlementResult ? `${item.settlementResult.toUpperCase()} settled` : "Pending"}
                      </div>
                    </td>
                    <td className={`px-4 py-2 align-middle text-[10px] font-bold uppercase truncate ${
                      item.verdict === "saved_loss" ? "text-emerald-400" :
                      item.verdict === "missed_win" || item.verdict === "reduced_profit" ? "text-red-400" :
                      "text-slate-500"
                    }`} title={item.reason ?? ""}>
                      {item.verdict.replaceAll("_", " ")}
                    </td>
                  </tr>
                ))}
                {!lifecycleRows.length && (
                  <tr><td colSpan={9} className="px-4 py-4 text-center text-slate-600 text-[10px] font-mono italic h-12 align-middle">No Smart Exit triggers recorded yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <SectionHeader title="Position Coverage · Why a coin did or did not trigger" />
          <div className="overflow-x-auto overflow-y-auto max-h-[220px]">
            <table className="w-full min-w-[720px] table-fixed text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5 text-[9px] text-slate-500 uppercase tracking-wider">
                  <th className="w-[105px] px-4 py-2 font-medium">Evaluated</th>
                  <th className="w-[90px] px-4 py-2 font-medium">Market</th>
                  <th className="w-[110px] px-4 py-2 font-medium">Entry</th>
                  <th className="w-[110px] px-4 py-2 font-medium">Status</th>
                  <th className="w-auto px-4 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {lifecycle?.coverage?.map(item => (
                  <tr key={`${item.owner}:${item.positionId}`} className="h-11 hover:bg-white/[0.02]">
                    <td className="px-4 py-2 text-[10px] font-mono text-slate-500 tabular-nums">{fmtTime(item.evaluatedAt)}</td>
                    <td className="px-4 py-2 font-bold text-slate-200">{item.symbol} <span className="text-[9px] text-slate-500">{item.side.toUpperCase()}</span></td>
                    <td className="px-4 py-2 text-[10px] font-mono text-slate-300 tabular-nums">
                      {item.entryPriceCents == null ? "—" : `${item.entryPriceCents.toFixed(1)}¢`} · {item.contractCount}
                    </td>
                    <td className={`px-4 py-2 text-[10px] font-bold uppercase ${
                      item.status === "triggered" ? "text-indigo-400" :
                      item.status === "unavailable" ? "text-amber-400" : "text-slate-400"
                    }`}>{item.status}</td>
                    <td className="px-4 py-2 text-[10px] font-mono text-slate-400 truncate" title={item.reason}>{item.reason}</td>
                  </tr>
                ))}
                {!lifecycle?.coverage?.length && (
                  <tr><td colSpan={5} className="h-11 px-4 text-center text-[10px] font-mono italic text-slate-600">No evaluated positions recorded yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Config & Replay */}
        <div className="flex flex-col h-full bg-[#0d1017]">
          <SectionHeader title="Parameters & Config" />
          <div className="p-4 flex flex-col gap-5 border-b border-white/10 bg-white/[0.01]">
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Active Overrides</span>
              {status?.config?.appliedVersions && Object.keys(status.config.appliedVersions).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(status.config.appliedVersions).map(([sym, meta]) => (
                    <div key={sym} className="px-2.5 py-1 bg-black/40 border border-white/10 rounded-md text-[10px] flex items-center gap-2">
                      <span className="font-bold text-slate-200">{sym}</span>
                      <span className="text-white/50">|</span>
                       <span className="text-indigo-400 font-mono">{meta.owner} / {meta.version} · {sensitivityLabel(meta.parameters?.sensitivity)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-[10px] text-slate-600 font-mono">No symbol-specific overrides active.</span>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-3 p-3 bg-black/20 border border-white/5 rounded-lg">
              <div className="flex flex-col gap-1.5 flex-1 min-w-[70px]">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Symbol</label>
                <input 
                  type="text" 
                  value={applyForm.symbol}
                  onChange={e => setApplyForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                  placeholder="BTC"
                  className="bg-[#0f1117] border border-white/10 focus:border-indigo-500/50 rounded w-full px-2.5 py-1.5 text-xs text-slate-200 font-mono outline-none transition-colors"
                />
              </div>
              <div className="flex flex-col gap-1.5 flex-1 min-w-[100px]">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Owner</label>
                <select
                  value={applyForm.owner}
                  onChange={e => setApplyForm(f => ({ ...f, owner: e.target.value }))}
                  className="bg-[#0f1117] border border-white/10 focus:border-indigo-500/50 rounded w-full px-2.5 py-1.5 text-xs text-slate-200 font-mono outline-none transition-colors"
                >
                  <option value="">Select</option>
                  <option value="regular">Regular</option>
                  <option value="scalper">Scalper</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5 flex-1 min-w-[70px]">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Version</label>
                <input 
                  type="text" 
                  value={applyForm.version}
                  onChange={e => setApplyForm(f => ({ ...f, version: e.target.value }))}
                  placeholder="v1"
                  className="bg-[#0f1117] border border-white/10 focus:border-indigo-500/50 rounded w-full px-2.5 py-1.5 text-xs text-slate-200 font-mono outline-none transition-colors"
                />
              </div>
              <button 
                onClick={applyParams}
                disabled={busy || !applyForm.symbol || !capability?.canManage}
                className="h-[30px] px-4 bg-indigo-500 hover:bg-indigo-600 text-white rounded text-[10px] font-bold uppercase tracking-wider disabled:opacity-50 transition-colors flex items-center justify-center min-w-[80px]"
              >
                Apply
              </button>
            </div>
          </div>

          <SectionHeader title="Replay & Calibration Reports" />
          <div className="overflow-x-auto overflow-y-auto max-h-[400px]">
            <table className="w-full min-w-[500px] table-fixed text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5 text-[9px] text-slate-500 uppercase tracking-wider">
                  <th className="w-[80px] px-4 py-2 font-medium">Market</th>
                  <th className="w-[100px] px-4 py-2 font-medium">Version</th>
                  <th className="w-[130px] px-4 py-2 font-medium">Evaluations</th>
                  <th className="w-[80px] px-4 py-2 font-medium">Score</th>
                  <th className="w-[110px] px-4 py-2 font-medium text-right">Hypo P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {replay?.reports?.filter(rep => rep.kind !== "global_counterfactual").map(rep => (
                  <tr key={rep.id || `${rep.symbol}-${rep.version}`} className="hover:bg-white/[0.02] transition-colors h-12">
                    <td className="px-4 py-2 align-middle font-bold text-slate-200 text-xs">{rep.symbol}</td>
                    <td className="px-4 py-2 align-middle text-[10px] text-slate-400 font-mono truncate" title={`${rep.owner}/${rep.version}`}>
                      {rep.owner}/{rep.version}
                    </td>
                    <td className="px-4 py-2 align-middle font-mono text-[10px] text-slate-300">
                       {rep.totalEvaluated} <span className="text-slate-600 ml-1">({rep.exitsRecommended} exit)</span>
                    </td>
                    <td className="px-4 py-2 align-middle text-[10px] font-mono text-indigo-400">{fmtConf(rep.calibrationScore)}</td>
                    <td className="px-4 py-2 align-middle text-right font-mono text-[10px]">
                       <span className={rep.hypotheticalPnlSaved > 0 ? "text-emerald-400" : rep.hypotheticalPnlSaved < 0 ? "text-red-400" : "text-slate-500"}>
                         {rep.hypotheticalPnlSaved > 0 ? "+" : ""}{fmt$(rep.hypotheticalPnlSaved)}
                       </span>
                    </td>
                  </tr>
                ))}
                {!replay?.reports?.length && (
                  <tr><td colSpan={5} className="px-4 py-4 text-center text-slate-600 text-[10px] font-mono italic h-12 align-middle">No replay reports available</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
    </div>
    <ScalperSmartExitSection authPost={authPost} canManage={capability?.canManage === true} />
    </>
  );
}
