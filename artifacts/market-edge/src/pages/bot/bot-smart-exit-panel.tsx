import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, AlertTriangle, PowerOff } from "lucide-react";
import { API_BASE, fmt$, fmtDateTime } from "./utils";
import type { SmartExitStatus, SmartExitEvaluation, SmartExitReplayReport, SmartExitCapability, SmartExitConfig, SmartExitComponentHealth, SmartExitLifecycleLedger } from "./types";

const fmtConf = (n: number | undefined | null) => n != null ? `${(n * 100).toFixed(1)}%` : "—";
const fmtTime = (iso: string) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      {ev.recommendation}
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

export function BotSmartExitPanel({ authPost }: Props) {
  const { getToken, isLoaded: authLoaded } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
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

  return (
    <div className="bg-[#0b0d13] border border-white/10 rounded-xl overflow-hidden mb-6 flex flex-col shadow-2xl">
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
               <span>EVALS: <span className="text-slate-300">{status?.health?.activeEvaluations ?? 0}</span></span>
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
                {status?.evaluations?.map(ev => (
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
                          {ev.debounceTarget && ev.debounceTarget > 1 ? (
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
                           <span className="text-slate-500">Loss</span>
                           {ev.marketLossFraction != null ? (
                             <span className={ev.marketLossFraction > 0 ? "text-red-400" : "text-emerald-400"}>{(ev.marketLossFraction * 100).toFixed(1)}%</span>
                           ) : <span className="text-slate-600">—</span>}
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
                          <div className="text-[9px] font-mono text-slate-500 truncate flex-1" title={ev.currentUnavailableReason || ""}>
                            {ev.currentUnavailableReason || "Healthy"}
                          </div>
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
                {!status?.evaluations?.length && (
                  <tr><td colSpan={5} className="px-4 py-4 text-center text-slate-600 text-[10px] font-mono italic h-[84px] align-middle">No active evaluations</td></tr>
                )}
              </tbody>
            </table>
          </div>

        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(420px,1fr)] divide-y xl:divide-y-0 xl:divide-x divide-white/10">
        <div className="flex flex-col h-full bg-[#0d1017]">
          <SectionHeader title={`Exit Lifecycle & Effectiveness · ${lifecycle?.summary.triggered ?? 0} triggered · ${lifecycle?.summary.sold ?? 0} sold · ${lifecycle?.summary.settled ?? 0} settled`} />
          <div className="overflow-x-auto overflow-y-auto max-h-[360px]">
            <table className="w-full min-w-[1080px] table-fixed text-left text-xs whitespace-nowrap">
              <caption className="sr-only">
                Saved / Forfeited equals Sell-now P&amp;L minus Held-to-result P&amp;L. Positive saved means recovered value versus a final loss; negative forfeited means value surrendered versus holding.
              </caption>
              <thead>
                <tr className="border-b border-white/5 text-[9px] text-slate-500 uppercase tracking-wider">
                  <th className="w-[105px] px-4 py-2 font-medium">Triggered</th>
                  <th className="w-[90px] px-4 py-2 font-medium">Market</th>
                  <th className="w-[110px] px-4 py-2 font-medium">Entry</th>
                  <th className="w-[100px] px-4 py-2 font-medium text-right">Stake</th>
                  <th
                    className="w-[120px] px-4 py-2 font-medium text-right"
                    title="P&amp;L from selling when Smart Exit triggered."
                    aria-label="Sell-now profit and loss: P and L from selling when Smart Exit triggered"
                  >
                    Sell-now P&amp;L
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
                {lifecycle?.records?.map(item => (
                  <tr key={item.id} className="hover:bg-white/[0.02] transition-colors h-12">
                    <td className="px-4 py-2 align-middle text-[10px] font-mono text-slate-500 tabular-nums">
                      {fmtTime(item.triggeredAt)}
                    </td>
                    <td className="px-4 py-2 align-middle font-bold text-slate-200 text-xs">
                      {item.symbol} <span className="text-[9px] text-slate-500">{item.side.toUpperCase()}</span>
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
                      <div className="text-[9px] text-slate-600">
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
                {!lifecycle?.records?.length && (
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
                      <span className="text-white/20">|</span>
                      <span className="text-indigo-400 font-mono">{meta.owner} / {meta.version}</span>
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
                {replay?.reports?.map(rep => (
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
  );
}
