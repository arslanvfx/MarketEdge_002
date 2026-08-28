import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchStatus, updateExecutionOwner } from "./api";
import { Dashboard2Status } from "./types";
import { Shield, Zap, Pause, Server, Clock, Activity, Target, AlertCircle, CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

function FormatTime({ seconds, testId }: { seconds: number; testId?: string }) {
  const isNeg = seconds < 0;
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = Math.floor(abs % 60);
  return (
    <span className="font-mono tabular-nums" data-testid={testId}>
      {isNeg ? "-" : ""}{m.toString().padStart(2, "0")}:{s.toString().padStart(2, "0")}
    </span>
  );
}

function formatCents(value: number | null | undefined): string {
  if (value == null) return '--';
  return `${Math.round(value * 100)}¢`;
}

function OwnerControl({ status }: { status: Dashboard2Status }) {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { mutate: updateOwner, isPending } = useMutation({
    mutationFn: async (owner: 'current_bot' | 'dashboard2_bot' | 'paused') => {
      setErrorMsg(null);
      const token = await getToken();
      return updateExecutionOwner(token, owner);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard2-status"] });
    },
    onError: (error: Error) => {
      setErrorMsg(error.message);
      setTimeout(() => setErrorMsg(null), 5000);
    }
  });

  const owner = status.system.executionOwner;
  const obsOnly = status.system.observationOnly;

  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-zinc-500 font-semibold flex items-center gap-2">
          <Server className="w-3.5 h-3.5" /> Execution Authority
        </h2>
        {obsOnly && (
          <span 
            className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded flex items-center gap-1 font-semibold uppercase tracking-wider"
            data-testid="status-observation-only"
          >
            <Shield className="w-3 h-3" /> Observation Only
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          disabled={isPending}
          onClick={() => updateOwner("current_bot")}
          data-testid="button-owner-v1"
          className={`flex flex-col items-center justify-center gap-2 p-3 rounded-md border transition-all ${
            owner === "current_bot"
              ? "bg-zinc-800 border-zinc-500 text-white shadow-[0_0_15px_rgba(255,255,255,0.05)]"
              : "bg-zinc-950 border-zinc-800/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          } ${isPending ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <Server className={`w-5 h-5 ${owner === "current_bot" ? "text-blue-400" : ""}`} />
          <span className="text-xs font-semibold">V1 Bot</span>
        </button>

        <button
          disabled={isPending || obsOnly}
          onClick={() => updateOwner("dashboard2_bot")}
          title={obsOnly ? "Dashboard is in Observation Only mode" : ""}
          data-testid="button-owner-dash2"
          className={`group flex flex-col items-center justify-center gap-2 p-3 rounded-md border transition-all ${
            owner === "dashboard2_bot"
              ? "bg-emerald-950 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
              : "bg-zinc-950 border-zinc-800/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-40 disabled:hover:border-zinc-800/50"
          } ${isPending ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <Zap className={`w-5 h-5 ${owner === "dashboard2_bot" ? "text-emerald-400" : ""}`} />
          <span className="text-xs font-semibold">Dash 2 Bot</span>
        </button>

        <button
          disabled={isPending}
          onClick={() => updateOwner("paused")}
          data-testid="button-owner-paused"
          className={`flex flex-col items-center justify-center gap-2 p-3 rounded-md border transition-all ${
            owner === "paused"
              ? "bg-rose-950 border-rose-500/50 text-rose-400 shadow-[0_0_15px_rgba(225,29,72,0.1)]"
              : "bg-zinc-950 border-zinc-800/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          } ${isPending ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <Pause className={`w-5 h-5 ${owner === "paused" ? "text-rose-400" : ""}`} />
          <span className="text-xs font-semibold">Paused</span>
        </button>
      </div>

      {errorMsg && (
        <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-2 py-1.5 flex items-center gap-1.5" data-testid="status-owner-error">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{errorMsg}</span>
        </div>
      )}
    </div>
  );
}

function WindowStatus({ window, system }: { window: Dashboard2Status['window'], system: Dashboard2Status['system'] }) {
  const phaseColors = {
    preparing: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
    armed: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    eligible: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    blocked: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  };

  const isActive = window.phase === 'eligible' && system.executionOwner === 'dashboard2_bot';

  return (
    <div className={`bg-zinc-900/40 border rounded-lg p-4 flex flex-col justify-between transition-colors ${isActive ? 'border-emerald-500/30' : 'border-zinc-800'}`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs uppercase tracking-widest text-zinc-500 font-semibold flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" /> Current Window
        </h2>
        <span className="font-mono text-xs text-zinc-400 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800" data-testid="text-window-key">
          {window.key || "NONE"}
        </span>
      </div>

      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Phase</span>
          <div 
            className={`px-3 py-1 rounded border text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 ${phaseColors[window.phase]}`}
            data-testid={`status-phase-${window.phase}`}
          >
            {window.phase === 'eligible' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
            {window.phase}
          </div>
        </div>

        <div className="flex gap-6 text-right">
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Elapsed</span>
            <FormatTime seconds={window.elapsedSeconds} testId="text-window-elapsed" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Entry In</span>
            <FormatTime seconds={window.entryOpensInSeconds} testId="text-window-entry-in" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PolicyLimits({ policy }: { policy: Dashboard2Status['policy'] }) {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-4 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs uppercase tracking-widest text-zinc-500 font-semibold flex items-center gap-2">
          <Target className="w-3.5 h-3.5" /> Operating Policy
        </h2>
        <span className="text-[10px] text-zinc-600 font-mono" data-testid="text-policy-version">v{policy.version}</span>
      </div>
      
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-auto">
        <div className="flex justify-between items-center border-b border-zinc-800/50 pb-1">
          <span className="text-xs text-zinc-400">Min Entry</span>
          <span className="font-mono text-sm text-zinc-200" data-testid="text-policy-min-entry">T+{policy.minEntryMinute}m</span>
        </div>
        <div className="flex justify-between items-center border-b border-zinc-800/50 pb-1">
          <span className="text-xs text-zinc-400">Max Size</span>
          <span className="font-mono text-sm text-zinc-200" data-testid="text-policy-max-size">{policy.maxContracts}</span>
        </div>
        <div className="flex justify-between items-center border-b border-zinc-800/50 pb-1">
          <span className="text-xs text-zinc-400">Cost Floor</span>
          <span className="font-mono text-sm text-zinc-200" data-testid="text-policy-cost-floor">{formatCents(policy.sideCostFloor)}</span>
        </div>
        <div className="flex justify-between items-center border-b border-zinc-800/50 pb-1">
          <span className="text-xs text-zinc-400">Cost Ceiling</span>
          <span className="font-mono text-sm text-zinc-200" data-testid="text-policy-cost-ceiling">{formatCents(policy.sideCostCeiling)}</span>
        </div>
      </div>
    </div>
  );
}

function ReadinessPipeline({ readiness }: { readiness: Dashboard2Status['readiness'] }) {
  const statusColors = {
    ready: "text-emerald-400",
    warming: "text-amber-400",
    blocked: "text-rose-400",
    stale: "text-zinc-500",
  };

  const statusIcons = {
    ready: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
    warming: <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />,
    blocked: <XCircle className="w-4 h-4 text-rose-400" />,
    stale: <Clock className="w-4 h-4 text-zinc-500" />,
  };

  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-3 border-b border-zinc-800 bg-zinc-900/60">
        <h2 className="text-xs uppercase tracking-widest text-zinc-400 font-semibold flex items-center gap-2">
          <Activity className="w-3.5 h-3.5" /> Pipeline Readiness
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {readiness.length === 0 && (
          <div className="p-4 text-center text-xs text-zinc-500" data-testid="text-readiness-empty">No checks configured</div>
        )}
        {readiness.map((check) => (
          <div key={check.id} className="flex items-start gap-3 p-2 hover:bg-zinc-800/30 rounded transition-colors group" data-testid={`row-readiness-${check.id}`}>
            <div className="mt-0.5 shrink-0">
              {statusIcons[check.status]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex justify-between items-baseline mb-0.5">
                <span className="text-sm font-medium text-zinc-200">{check.label}</span>
                <span className={`text-[10px] font-bold uppercase tracking-wider ${statusColors[check.status]}`}>
                  {check.status}
                </span>
              </div>
              <div className="text-xs text-zinc-500 truncate group-hover:whitespace-normal group-hover:break-words">
                {check.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketBook({ markets }: { markets: Dashboard2Status['markets'] }) {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-3 border-b border-zinc-800 bg-zinc-900/60 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-zinc-400 font-semibold flex items-center gap-2">
          <Target className="w-3.5 h-3.5" /> Live Targets
        </h2>
        <span className="text-[10px] font-mono text-zinc-500 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800" data-testid="text-markets-count">
          {markets.length} TRACKED
        </span>
      </div>
      
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse">
          <thead className="bg-zinc-950/50 sticky top-0 backdrop-blur-sm z-10 border-b border-zinc-800">
            <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2 font-semibold">Symbol</th>
              <th className="px-3 py-2 font-semibold text-right">Side / Cost</th>
              <th className="px-3 py-2 font-semibold text-right">Avail</th>
              <th className="px-3 py-2 font-semibold">Safety</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {markets.length === 0 && (
              <tr>
                <td colSpan={4} className="p-8 text-center text-xs text-zinc-500" data-testid="text-markets-empty">
                  No active markets in window
                </td>
              </tr>
            )}
            {markets.map((m) => (
              <tr key={m.symbol} className="hover:bg-zinc-800/30 transition-colors" data-testid={`row-market-${m.symbol}`}>
                <td className="px-3 py-2.5">
                  <div className="font-mono text-sm text-zinc-200">{m.symbol}</div>
                  {m.ticker && <div className="text-[10px] text-zinc-500 truncate max-w-[120px]">{m.ticker}</div>}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {m.side === 'yes' && <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-1.5 rounded">YES</span>}
                    {m.side === 'no' && <span className="text-xs font-bold text-rose-400 bg-rose-500/10 px-1.5 rounded">NO</span>}
                    {!m.side && <span className="text-xs font-bold text-zinc-500">—</span>}
                    <span className="font-mono text-sm text-zinc-300 w-8" data-testid={`text-market-cost-${m.symbol}`}>
                      {formatCents(m.sideCost)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className={`font-mono text-sm ${m.bookFresh ? "text-cyan-400" : "text-zinc-500"}`}>
                    {m.visibleContracts}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col gap-0.5">
                    {m.safety === 'approved' && <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider">Approved</span>}
                    {m.safety === 'waiting' && <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider">Waiting</span>}
                    {m.safety === 'blocked' && <span className="text-[10px] text-rose-400 font-bold uppercase tracking-wider">Blocked</span>}
                    {m.reason && <span className="text-[9px] text-zinc-500 truncate max-w-[100px]" title={m.reason}>{m.reason}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EventLog({ events }: { events: Dashboard2Status['recentEvents'] }) {
  const sevColors = {
    info: "text-zinc-400",
    success: "text-emerald-400",
    warning: "text-amber-400",
    error: "text-rose-400",
  };

  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-3 border-b border-zinc-800 bg-zinc-900/60">
        <h2 className="text-xs uppercase tracking-widest text-zinc-400 font-semibold flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" /> Event Log
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-[11px]">
        {events.length === 0 && (
          <div className="text-center text-zinc-600 mt-4 font-sans text-xs" data-testid="text-events-empty">No recent events</div>
        )}
        {events.map((e) => {
          const time = new Date(e.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
          return (
            <div key={e.id} className="flex gap-3 hover:bg-zinc-800/30 p-1 -mx-1 rounded transition-colors" data-testid={`row-event-${e.id}`}>
              <span className="text-zinc-600 shrink-0">{time}</span>
              <div className="flex flex-col min-w-0">
                <span className={`${sevColors[e.severity]} font-bold`}>[{e.type}]</span>
                <span className="text-zinc-300 break-words">{e.message}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard2() {
  const { getToken } = useAuth();
  
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dashboard2-status"],
    queryFn: async () => {
      const token = await getToken();
      return fetchStatus(token);
    },
    refetchInterval: 1000,
    retry: 1,
  });

  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-500 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-mono text-sm tracking-widest uppercase">Initializing HUD...</span>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 p-6">
        <div className="bg-rose-950/20 border border-rose-900/50 rounded-lg p-6 max-w-md w-full flex flex-col items-center text-center gap-4">
          <AlertTriangle className="w-10 h-10 text-rose-500" />
          <div>
            <h2 className="text-rose-400 font-semibold mb-1 uppercase tracking-widest">Telemetry Lost</h2>
            <p className="text-zinc-400 text-sm" data-testid="text-error-message">{(error as Error).message || "Unable to establish connection with execution server."}</p>
          </div>
          <Button variant="outline" className="mt-2 border-zinc-800 text-zinc-300" onClick={() => window.location.reload()} data-testid="button-reconnect">
            Reconnect
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="h-full bg-zinc-950 text-zinc-200 flex flex-col p-4 gap-4 overflow-hidden min-h-[100dvh] md:min-h-0">
      
      {/* HUD Top Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
        <OwnerControl status={data} />
        <WindowStatus window={data.window} system={data.system} />
        <PolicyLimits policy={data.policy} />
      </div>

      {/* Main Grid */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 gap-4 min-h-0">
        
        {/* Left Column: Pipeline */}
        <div className="md:col-span-3 min-h-0">
          <ReadinessPipeline readiness={data.readiness} />
        </div>

        {/* Center Column: Markets */}
        <div className="md:col-span-5 min-h-0">
          <MarketBook markets={data.markets} />
        </div>

        {/* Right Column: Logs */}
        <div className="md:col-span-4 min-h-0">
          <EventLog events={data.recentEvents} />
        </div>

      </div>

    </div>
  );
}
