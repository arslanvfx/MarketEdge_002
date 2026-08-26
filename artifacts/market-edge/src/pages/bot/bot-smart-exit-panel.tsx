import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Settings2, AlertTriangle, PowerOff, Activity, Clock, Zap, Target, RefreshCw, BarChart3, Database, CheckCircle2, XCircle } from "lucide-react";
import { API_BASE, fmt$, fmtDateTime } from "./utils";
import type { SmartExitStatus, SmartExitEvaluation, SmartExitReplayReport, SmartExitCapability, SmartExitConfig } from "./types";

const fmtConf = (n: number | undefined | null) => n != null ? `${(n * 100).toFixed(1)}%` : "—";

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
    refetchInterval: 5000,
  });

  const { data: history } = useQuery<{ evaluations: SmartExitEvaluation[] }>({
    queryKey: ["smart-exit-history"],
    queryFn: () => fetch(`${API_BASE}/crypto/smart-exit/history?limit=50`).then(r => r.json()),
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
    "off": "bg-slate-800 text-slate-400 border-slate-700",
    "shadow": "bg-indigo-900/40 text-indigo-300 border-indigo-700/50",
    "paper-exit": "bg-amber-900/40 text-amber-300 border-amber-700/50",
    "live-exit": "bg-red-900/40 text-red-300 border-red-700/50"
  };

  const modeLabels = {
    "off": "Disabled",
    "shadow": "Shadow (No execution)",
    "paper-exit": "Paper Exit",
    "live-exit": "Live Exit"
  };

  const isCommodity = (sym: string) => ["GOLD", "SILVER", "WTI"].includes(sym);
  
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden mb-6 flex flex-col">
      <div className="px-5 py-4 border-b border-border flex flex-wrap items-center gap-4 bg-muted/10">
        <Shield className="w-5 h-5 text-indigo-400" />
        <div>
          <h2 className="font-semibold">Smart Exit Subsystem</h2>
          <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
            <span>Data Readiness:</span>
            {status?.health?.dataReadiness === "ready" ? (
              <span className="text-emerald-400/80 font-bold uppercase">Ready</span>
            ) : status?.health?.dataReadiness === "degraded" ? (
              <span className="text-amber-400/80 font-bold uppercase">Degraded</span>
            ) : (
              <span className="text-red-400/80 font-bold uppercase">Unavailable</span>
            )}
            <span className="text-slate-600 px-1">|</span>
            <span>Active Evals: {status?.health?.activeEvaluations ?? 0}</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex bg-background border border-border rounded-lg overflow-hidden text-xs">
            {(["off", "shadow", "paper-exit", "live-exit"] as const).map(m => (
              <button
                key={m}
                onClick={() => updateConfig({ mode: m })}
                disabled={busy || !capability?.canManage}
                className={`px-3 py-1.5 transition-colors ${
                  mode === m 
                    ? modeColors[m] 
                    : "hover:bg-muted text-muted-foreground disabled:opacity-50"
                }`}
              >
                {modeLabels[m]}
              </button>
            ))}
          </div>
          <button
            onClick={emergencyDisable}
            disabled={busy || !capability?.canManage || mode === "off"}
            className="flex items-center gap-1 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg text-xs font-semibold disabled:opacity-50 transition-colors"
          >
            <PowerOff className="w-3.5 h-3.5" /> Emergency Off
          </button>
        </div>
      </div>
      
      {!capability?.canManage && capability?.message && (
        <div className="px-5 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-200/80 text-[10px]">
          <AlertTriangle className="w-3 h-3 inline mr-1.5" />
          {capability.message}
        </div>
      )}

      {/* Grid container for internal panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">
        
        {/* Left Column: Active & History */}
        <div className="flex flex-col h-full">
          <div className="px-4 py-2 border-b border-border bg-muted/20 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Current Evaluations
          </div>
          <div className="overflow-x-auto min-h-[150px]">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-border/50 text-[9px] text-muted-foreground uppercase tracking-wide">
                  <th className="px-3 py-1.5 font-normal">Symbol</th>
                  <th className="px-3 py-1.5 font-normal">Recommendation</th>
                  <th className="px-3 py-1.5 font-normal">Conf</th>
                  <th className="px-3 py-1.5 font-normal">Debounce</th>
                  <th className="px-3 py-1.5 font-normal">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {status?.evaluations?.map(ev => (
                  <tr key={ev.id || `${ev.symbol}-${ev.windowKey}`} className="hover:bg-muted/10">
                    <td className="px-3 py-2 font-bold text-slate-300">{ev.symbol}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider ${
                        ev.recommendation === "exit" 
                          ? (ev.executed ? "bg-red-500/15 text-red-400" : "bg-indigo-500/15 text-indigo-400") 
                          : "bg-slate-500/15 text-slate-400"
                      }`}>
                        {ev.recommendation}
                        {ev.recommendation === "exit" && !ev.executed
                          ? ` (${ev.executionStatus === "unknown" ? "Unknown" : ev.executionStatus === "blocked" ? "Blocked" : mode === "shadow" ? "Shadow" : "Pending"})`
                          : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{fmtConf(ev.confidence)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-indigo-500" 
                            style={{ width: `${Math.min(100, ((ev.debounceProgress || 0) / (ev.debounceTarget || 1)) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[9px] font-mono text-muted-foreground">{ev.debounceProgress}/{ev.debounceTarget}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[9px]">
                       {!ev.microstructureAvailable ? (
                          <span className="text-amber-500/80 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {isCommodity(ev.symbol) ? "Microstructure unavailable" : "Evidence stale/incomplete"}</span>
                      ) : (
                         <span className="text-emerald-500/80 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> OK</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!status?.evaluations?.length && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground text-[10px] italic">No active evaluations</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2 border-y border-border bg-muted/20 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Recent History
          </div>
          <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-border/50 text-[9px] text-muted-foreground uppercase tracking-wide">
                  <th className="px-3 py-1.5 font-normal">Time</th>
                  <th className="px-3 py-1.5 font-normal">Symbol</th>
                  <th className="px-3 py-1.5 font-normal">Action</th>
                  <th className="px-3 py-1.5 font-normal">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {history?.evaluations?.map(ev => (
                  <tr key={ev.id || `${ev.symbol}-${ev.timestamp}`} className="hover:bg-muted/10">
                    <td className="px-3 py-2 text-[9px] text-muted-foreground">{fmtDateTime(ev.timestamp)}</td>
                    <td className="px-3 py-2 font-bold text-slate-300">{ev.symbol}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider ${
                        ev.recommendation === "exit" 
                          ? (ev.executed ? "bg-red-500/15 text-red-400" : "bg-indigo-500/15 text-indigo-400") 
                          : "bg-slate-500/15 text-slate-400"
                      }`}>
                        {ev.recommendation}
                        {ev.recommendation === "exit" && !ev.executed
                          ? ` (${ev.executionStatus === "unknown" ? "Unknown" : ev.executionStatus === "blocked" ? "Blocked" : "Advisory"})`
                          : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[9px] text-slate-400 max-w-[150px] truncate" title={ev.reason}>{ev.reason}</td>
                  </tr>
                ))}
                {!history?.evaluations?.length && (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-muted-foreground text-[10px] italic">No recent history</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Config & Replay */}
        <div className="flex flex-col h-full">
          <div className="px-4 py-2 border-b border-border bg-muted/20 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Parameters & Config
          </div>
          <div className="p-4 flex flex-col gap-4 border-b border-border">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold text-slate-300">Applied Versions</span>
              {status?.config?.appliedVersions && Object.keys(status.config.appliedVersions).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(status.config.appliedVersions).map(([sym, meta]) => (
                    <div key={sym} className="px-2 py-1 bg-slate-800/50 border border-slate-700 rounded text-[10px] flex items-center gap-1.5">
                      <span className="font-bold text-slate-300">{sym}</span>
                      <span className="text-muted-foreground">|</span>
                      <span className="text-indigo-300">{meta.owner} / {meta.version}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-[10px] text-muted-foreground italic">Using default system parameters.</span>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-2 p-3 bg-muted/10 border border-border/50 rounded-lg">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-muted-foreground uppercase tracking-widest">Symbol</label>
                <input 
                  type="text" 
                  value={applyForm.symbol}
                  onChange={e => setApplyForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                  placeholder="BTC"
                  className="bg-background border border-border rounded px-2 py-1.5 text-xs w-20" 
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-muted-foreground uppercase tracking-widest">Owner</label>
                <select
                  value={applyForm.owner}
                  onChange={e => setApplyForm(f => ({ ...f, owner: e.target.value }))}
                  className="bg-background border border-border rounded px-2 py-1.5 text-xs w-28" 
                >
                  <option value="">Select</option>
                  <option value="regular">Regular</option>
                  <option value="scalper">Scalper</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-muted-foreground uppercase tracking-widest">Version</label>
                <input 
                  type="text" 
                  value={applyForm.version}
                  onChange={e => setApplyForm(f => ({ ...f, version: e.target.value }))}
                  placeholder="v1"
                  className="bg-background border border-border rounded px-2 py-1.5 text-xs w-20" 
                />
              </div>
              <button 
                onClick={applyParams}
                disabled={busy || !applyForm.symbol || !capability?.canManage}
                className="px-3 py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded text-xs font-semibold disabled:opacity-50 transition-colors ml-auto"
              >
                Apply Parameters
              </button>
            </div>
          </div>

          <div className="px-4 py-2 border-b border-border bg-muted/20 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Replay & Calibration Reports
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-border/50 text-[9px] text-muted-foreground uppercase tracking-wide">
                  <th className="px-3 py-1.5 font-normal">Symbol</th>
                  <th className="px-3 py-1.5 font-normal">Version</th>
                  <th className="px-3 py-1.5 font-normal">Evaluated</th>
                  <th className="px-3 py-1.5 font-normal">Score</th>
                  <th className="px-3 py-1.5 font-normal text-right">Hypo P&L Saved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {replay?.reports?.map(rep => (
                  <tr key={rep.id || `${rep.symbol}-${rep.version}`} className="hover:bg-muted/10">
                    <td className="px-3 py-2 font-bold text-slate-300">{rep.symbol}</td>
                    <td className="px-3 py-2 text-[10px] text-slate-400">{rep.owner}/{rep.version}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{rep.totalEvaluated} <span className="text-slate-600 ml-1">({rep.exitsRecommended} exits)</span></td>
                    <td className="px-3 py-2 text-[10px] font-mono text-indigo-300">{fmtConf(rep.calibrationScore)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[10px]">
                       <span className={rep.hypotheticalPnlSaved > 0 ? "text-emerald-400" : rep.hypotheticalPnlSaved < 0 ? "text-red-400" : "text-slate-500"}>
                         {rep.hypotheticalPnlSaved > 0 ? "+" : ""}{fmt$(rep.hypotheticalPnlSaved)}
                       </span>
                    </td>
                  </tr>
                ))}
                {!replay?.reports?.length && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground text-[10px] italic">No replay reports available</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
