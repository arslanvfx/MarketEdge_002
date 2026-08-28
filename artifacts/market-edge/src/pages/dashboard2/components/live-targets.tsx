import React, { useState } from "react";
import { Dashboard2Status } from "../types";
import { formatCents } from "../utils";
import { Target, ChevronDown, ChevronUp } from "lucide-react";

export default function LiveTargetsTab({ markets }: { markets: Dashboard2Status['markets'] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg flex flex-col overflow-hidden h-full">
      <div className="p-4 border-b border-slate-800/60 bg-black/20 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
          <Target className="w-4 h-4" /> Live Targets
        </h2>
        <span className="text-[10px] font-mono text-cyan-500 bg-cyan-500/10 px-2.5 py-1 rounded border border-cyan-500/20">
          {markets.length} ACTIVE
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead className="bg-[#0a0e14] sticky top-0 z-10 border-b border-slate-800/60 shadow-sm">
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3 font-semibold w-8"></th>
              <th className="px-4 py-3 font-semibold">Symbol / Ticker</th>
              <th className="px-4 py-3 font-semibold text-right">Side & Cost</th>
              <th className="px-4 py-3 font-semibold text-right">Available</th>
              <th className="px-4 py-3 font-semibold">Safety Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {markets.length === 0 && (
              <tr>
                <td colSpan={5} className="p-12 text-center text-sm text-slate-500 font-sans">
                  No active markets in current window.
                </td>
              </tr>
            )}
            {markets.map((m) => {
              const isExp = expanded === m.symbol;
              return (
                <React.Fragment key={m.symbol}>
                  <tr
                    className="hover:bg-slate-800/20 transition-colors cursor-pointer"
                    onClick={() => setExpanded(isExp ? null : m.symbol)}
                  >
                    <td className="px-4 py-3 text-slate-600">
                      {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-sm text-slate-200">{m.symbol}</div>
                      {m.ticker && <div className="text-xs text-slate-500 mt-0.5">{m.ticker}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {m.side === 'yes' && <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">YES</span>}
                        {m.side === 'no' && <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">NO</span>}
                        {!m.side && <span className="text-[10px] font-bold text-slate-500">—</span>}
                        <span className="font-mono text-sm text-cyan-400 w-10">
                          {formatCents(m.sideCost)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-mono text-sm ${m.bookFresh ? "text-slate-200" : "text-slate-600"}`}>
                        {m.visibleContracts}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1 items-start">
                        {m.safety === 'approved' && <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">Approved</span>}
                        {m.safety === 'waiting' && <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">Waiting</span>}
                        {m.safety === 'blocked' && <span className="text-[10px] text-rose-400 font-bold uppercase tracking-wider bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">Blocked</span>}
                      </div>
                    </td>
                  </tr>
                  {isExp && (
                    <tr className="bg-black/20 border-b border-slate-800/40">
                      <td colSpan={5} className="px-4 py-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pl-8">
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Reason</span>
                            <span className="text-sm text-slate-300">{m.reason || "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Target</span>
                            <span className="font-mono text-sm text-slate-300">{m.target ? m.target.toFixed(2) : "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Distance %</span>
                            <span className="font-mono text-sm text-slate-300">{m.distancePct ? `${(m.distancePct * 100).toFixed(2)}%` : "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Book Version</span>
                            <span className="font-mono text-xs text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">{m.bookVersion || "—"}</span>
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
