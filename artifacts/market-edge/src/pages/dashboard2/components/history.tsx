import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchHistory } from "../api";
import { formatCents, formatDateTime, formatDollar } from "../utils";
import { History, ChevronDown, ChevronUp, Loader2, AlertTriangle } from "lucide-react";

export default function HistoryTab({ mode }: { mode: 'paper' | 'live' }) {
  const { getToken } = useAuth();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: history, isLoading, isError } = useQuery({
    queryKey: ["dashboard2-history", mode],
    queryFn: async () => fetchHistory(await getToken(), mode),
    refetchInterval: 10000,
  });

  if (isLoading && !history) {
    return (
      <div className="flex h-[300px] items-center justify-center text-slate-500 gap-3 bg-[#0f141d] border border-slate-800/60 rounded-lg">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-mono text-sm tracking-widest uppercase">Loading History...</span>
      </div>
    );
  }

  if (isError && !history) {
    return (
      <div className="flex h-[300px] items-center justify-center text-rose-500 gap-3 bg-[#0f141d] border border-slate-800/60 rounded-lg">
        <AlertTriangle className="w-5 h-5" />
        <span className="font-mono text-sm tracking-widest uppercase">Failed to load history</span>
      </div>
    );
  }

  return (
    <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-4 border-b border-slate-800/60 bg-black/20 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
          <History className="w-4 h-4" /> Bet History
        </h2>
        <span className="text-[10px] font-mono text-slate-400 bg-slate-800/50 px-2.5 py-1 rounded border border-slate-700/50">
          {history?.length || 0} RECORDS
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead className="bg-[#0a0e14] sticky top-0 z-10 border-b border-slate-800/60 shadow-sm">
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3 font-semibold w-8"></th>
              <th className="px-4 py-3 font-semibold">Symbol</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold text-right">Side / Fills</th>
              <th className="px-4 py-3 font-semibold text-right">Entry</th>
              <th className="px-4 py-3 font-semibold text-right">Payout</th>
              <th className="px-4 py-3 font-semibold text-right">Settled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {(!history || history.length === 0) && (
              <tr>
                <td colSpan={7} className="p-12 text-center text-sm text-slate-500 font-sans">
                  No historical records found.
                </td>
              </tr>
            )}
            {history?.map((p) => {
              const isExp = expanded === p.id;
              const sv = typeof p.settlement_value === 'string' ? parseFloat(p.settlement_value) : p.settlement_value;
              const isWin = sv !== null && !isNaN(sv) && sv > 0;
              const isLoss = sv !== null && !isNaN(sv) && sv === 0;

              return (
                <React.Fragment key={p.id}>
                  <tr
                    className="hover:bg-slate-800/20 transition-colors cursor-pointer"
                    onClick={() => setExpanded(isExp ? null : p.id)}
                  >
                    <td className="px-4 py-3 text-slate-600">
                      {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-sm text-slate-200">{p.symbol}</div>
                      {p.ticker && <div className="text-xs text-slate-500 mt-0.5">{p.ticker}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                        p.status === 'settled' && isWin ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        p.status === 'settled' && isLoss ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                        p.status === 'failed' ? 'bg-rose-950 text-rose-500 border-rose-900/50' :
                        'bg-slate-800 text-slate-400 border-slate-700'
                      }`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {p.side === 'yes' && <span className="text-[10px] font-bold text-emerald-400">YES</span>}
                        {p.side === 'no' && <span className="text-[10px] font-bold text-rose-400">NO</span>}
                        <span className="text-slate-500 mx-1">·</span>
                        <span className="font-mono text-sm text-slate-200">{p.filled_contracts}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-sm text-cyan-400">{formatCents(p.entry_cost)}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-mono text-sm ${isWin ? 'text-emerald-400' : isLoss ? 'text-slate-500' : 'text-slate-400'}`}>
                        {p.settlement_value !== null ? formatDollar(p.settlement_value) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs text-slate-400">{formatDateTime(p.settled_at || p.created_at)}</span>
                    </td>
                  </tr>
                  {isExp && (
                    <tr className="bg-black/20 border-b border-slate-800/40">
                      <td colSpan={7} className="px-4 py-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pl-8">
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Created At</span>
                            <span className="text-xs text-slate-400">{formatDateTime(p.created_at)}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Reconcile Reason</span>
                            <span className="text-xs text-slate-400">{p.reconcile_reason || "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Mode</span>
                            <span className="text-xs text-slate-400 uppercase tracking-wider">{p.mode}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Details</span>
                            <span className="text-xs text-slate-300">{p.details ? JSON.stringify(p.details) : "—"}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
