import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchAudit } from "../api";
import { ReadinessReason } from "../types";
import { formatDateTime } from "../utils";
import { ShieldAlert, Shield, CheckCircle2, AlertTriangle, Loader2, XCircle, Clock } from "lucide-react";

function ReadinessPipeline({ readiness }: { readiness: ReadinessReason[] }) {
  const statusColors: Record<string, string> = {
    ready: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    warming: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    blocked: "text-rose-400 bg-rose-500/10 border-rose-500/20",
    stale: "text-slate-500 bg-slate-800 border-slate-700",
  };

  const statusIcons: Record<string, React.ReactNode> = {
    ready: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
    warming: <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />,
    blocked: <XCircle className="w-4 h-4 text-rose-400" />,
    stale: <Clock className="w-4 h-4 text-slate-500" />,
  };

  const ready = readiness.length > 0 && readiness.every(r => r.status === 'ready');

  return (
    <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-4 border-b border-slate-800/60 bg-black/20 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
          <Shield className="w-4 h-4" /> Readiness Pipeline
        </h2>
        {ready ? (
          <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">Active</span>
        ) : (
          <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">Not Ready</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {readiness.length === 0 && (
          <div className="p-6 text-center text-sm text-slate-500 font-sans">No checks configured</div>
        )}
        <div className="space-y-1">
          {readiness.map((check) => (
            <div key={check.id} className="flex items-start gap-4 p-3 hover:bg-slate-800/30 rounded transition-colors group">
              <div className="mt-0.5 shrink-0">
                {statusIcons[check.status] || <ShieldAlert className="w-4 h-4 text-slate-400" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-medium text-slate-200">{check.label}</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${statusColors[check.status] || statusColors.stale}`}>
                    {check.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500 truncate group-hover:whitespace-normal group-hover:break-words leading-relaxed">
                  {check.detail}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AuditTrail() {
  const { getToken } = useAuth();
  const { data: audit, isLoading, isError } = useQuery({
    queryKey: ["dashboard2-audit"],
    queryFn: async () => fetchAudit(await getToken()),
    refetchInterval: 10000,
  });

  if (isLoading && !audit) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 gap-3 bg-[#0f141d] border border-slate-800/60 rounded-lg">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-mono text-sm tracking-widest uppercase">Loading Audit Log...</span>
      </div>
    );
  }

  if (isError && !audit) {
    return (
      <div className="flex h-full items-center justify-center text-rose-500 gap-3 bg-[#0f141d] border border-slate-800/60 rounded-lg">
        <AlertTriangle className="w-5 h-5" />
        <span className="font-mono text-sm tracking-widest uppercase">Failed to load audit log</span>
      </div>
    );
  }

  return (
    <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-4 border-b border-slate-800/60 bg-black/20 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4" /> Durable Evidence Trail
        </h2>
        <span className="text-[10px] font-mono text-slate-400 bg-slate-800/50 px-2.5 py-1 rounded border border-slate-700/50">
          {audit?.length || 0} RECORDS
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead className="bg-[#0a0e14] sticky top-0 z-10 border-b border-slate-800/60 shadow-sm">
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3 font-semibold">Timestamp</th>
              <th className="px-4 py-3 font-semibold">Action</th>
              <th className="px-4 py-3 font-semibold">Mode</th>
              <th className="px-4 py-3 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {(!audit || audit.length === 0) && (
              <tr>
                <td colSpan={4} className="p-12 text-center text-sm text-slate-500 font-sans">
                  No audit records found.
                </td>
              </tr>
            )}
            {audit?.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/20 transition-colors">
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="font-mono text-xs text-slate-400">{formatDateTime(r.created_at)}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-semibold text-slate-200 uppercase tracking-wider">{r.action}</span>
                </td>
                <td className="px-4 py-3">
                  {r.mode ? (
                    <span className="text-[10px] font-mono text-slate-500 uppercase bg-slate-900 px-2 py-0.5 rounded border border-slate-800">{r.mode}</span>
                  ) : (
                    <span className="text-[10px] font-mono text-slate-600">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-slate-400 font-mono break-words">{r.details ? JSON.stringify(r.details) : "—"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AuditTab({ readiness }: { readiness: ReadinessReason[] }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-full">
      <div className="lg:col-span-4 h-[400px] lg:h-full">
        <ReadinessPipeline readiness={readiness} />
      </div>
      <div className="lg:col-span-8 h-[600px] lg:h-full">
        <AuditTrail />
      </div>
    </div>
  );
}
