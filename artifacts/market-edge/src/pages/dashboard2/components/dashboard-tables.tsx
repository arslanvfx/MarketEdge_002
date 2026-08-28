import React, { useState } from "react";
import { Dashboard2Status, LedgerRow, AuditRow, ReadinessReason } from "../types";
import { formatCents, formatDollar, formatDateTime } from "../utils";
import { Target, ChevronDown, ChevronUp, AlertCircle, ShieldCheck, Activity, ShieldAlert, CheckCircle2, Loader2, XCircle, Clock, History } from "lucide-react";

export function CompactLiveTargets({ markets }: { markets: Dashboard2Status['markets'] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <Target className="w-4 h-4 text-cyan-400" /> Live Targets
        </h2>
        <span className="text-[10px] font-mono font-bold text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-400/20">
          {markets.length} ACTIVE
        </span>
      </div>

      {/* Mobile Stacked View */}
      <div className="block sm:hidden divide-y divide-border/50">
        {markets.length === 0 && (
          <div className="p-8 text-center text-xs text-muted-foreground font-sans">
            No active targets in current window.
          </div>
        )}
        {markets.map((m) => {
          const isExp = expanded === m.symbol;
          return (
            <div key={m.symbol} className="flex flex-col">
              <div
                className="p-4 hover:bg-muted/30 transition-colors cursor-pointer group flex items-center justify-between"
                onClick={() => setExpanded(isExp ? null : m.symbol)}
              >
                <div className="flex items-center gap-3">
                  <div className="text-muted-foreground group-hover:text-foreground transition-colors">
                    {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                  <div>
                    <div className="text-foreground font-bold font-mono text-sm">{m.symbol}</div>
                    {m.ticker && <div className="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[150px] font-sans">{m.ticker}</div>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5">
                    {m.side === 'yes' && <span className="text-[10px] font-bold text-[#00ffd0] bg-[#00ffd0]/10 px-1.5 py-0.5 rounded">YES</span>}
                    {m.side === 'no' && <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">NO</span>}
                    {!m.side && <span className="text-[10px] font-bold text-muted-foreground">—</span>}
                    <span className="text-cyan-400 font-mono text-sm font-bold">
                      {formatCents(m.sideCost)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${m.bookFresh ? "text-foreground" : "text-muted-foreground"}`}>
                      {m.visibleContracts} avail
                    </span>
                    {m.safety === 'approved' && <ShieldCheck className="w-3 h-3 text-[#00ffd0]" />}
                    {m.safety === 'waiting' && <Activity className="w-3 h-3 text-amber-400 animate-pulse" />}
                    {m.safety === 'blocked' && <AlertCircle className="w-3 h-3 text-rose-400" />}
                  </div>
                </div>
              </div>
              {isExp && (
                <div className="bg-background/40 p-4 border-t border-border/50 text-xs">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reason</span>
                      <span className="text-foreground font-medium">{m.reason || "—"}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Target</span>
                      <span className="font-mono text-foreground">{m.target ? m.target.toFixed(2) : "—"}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Distance %</span>
                      <span className="font-mono text-foreground">{m.distancePct ? `${(m.distancePct * 100).toFixed(2)}%` : "—"}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Book Version</span>
                      <span className="font-mono text-[10px] text-muted-foreground bg-background px-1.5 py-0.5 rounded border">{m.bookVersion || "—"}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop Table View */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[600px]">
          <thead className="bg-background/80 border-b">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-semibold w-8"></th>
              <th className="px-4 py-3 font-semibold">Symbol</th>
              <th className="px-4 py-3 font-semibold text-right">Side / Cost</th>
              <th className="px-4 py-3 font-semibold text-right">Avail</th>
              <th className="px-4 py-3 font-semibold">Safety</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50 font-mono text-sm">
            {markets.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-xs text-muted-foreground font-sans">
                  No active targets in current window.
                </td>
              </tr>
            )}
            {markets.map((m) => {
              const isExp = expanded === m.symbol;
              return (
                <React.Fragment key={m.symbol}>
                  <tr
                    className="hover:bg-muted/30 transition-colors cursor-pointer group"
                    onClick={() => setExpanded(isExp ? null : m.symbol)}
                  >
                    <td className="px-4 py-3 text-muted-foreground group-hover:text-foreground transition-colors">
                      {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-foreground font-bold">{m.symbol}</div>
                      {m.ticker && <div className="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[200px] font-sans">{m.ticker}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {m.side === 'yes' && <span className="text-[10px] font-bold text-[#00ffd0] bg-[#00ffd0]/10 px-1.5 py-0.5 rounded">YES</span>}
                        {m.side === 'no' && <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">NO</span>}
                        {!m.side && <span className="text-[10px] font-bold text-muted-foreground">—</span>}
                        <span className="text-cyan-400 w-12 text-right">
                          {formatCents(m.sideCost)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`${m.bookFresh ? "text-foreground" : "text-muted-foreground"}`}>
                        {m.visibleContracts}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {m.safety === 'approved' && <ShieldCheck className="w-4 h-4 text-[#00ffd0]" />}
                      {m.safety === 'waiting' && <Activity className="w-4 h-4 text-amber-400 animate-pulse" />}
                      {m.safety === 'blocked' && <AlertCircle className="w-4 h-4 text-rose-400" />}
                    </td>
                  </tr>
                  {isExp && (
                    <tr className="bg-background/40 border-b border-border/80">
                      <td colSpan={5} className="px-4 py-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pl-8 font-sans">
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reason</span>
                            <span className="text-xs text-foreground font-medium">{m.reason || "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Target</span>
                            <span className="font-mono text-xs text-foreground">{m.target ? m.target.toFixed(2) : "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Distance %</span>
                            <span className="font-mono text-xs text-foreground">{m.distancePct ? `${(m.distancePct * 100).toFixed(2)}%` : "—"}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Book Version</span>
                            <span className="font-mono text-[10px] text-muted-foreground bg-background px-1.5 py-0.5 rounded border">{m.bookVersion || "—"}</span>
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

export function CompactPositions({ positions }: { positions: LedgerRow[] | undefined }) {
  return (
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm h-full">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <Activity className="w-4 h-4 text-amber-400" /> Active Positions
        </h2>
        <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20">
          {positions?.length || 0} UNSETTLED
        </span>
      </div>

      {/* Mobile Stacked View */}
      <div className="block sm:hidden divide-y divide-border/50">
        {(!positions || positions.length === 0) && (
          <div className="p-8 text-center text-xs text-muted-foreground font-sans">
            No active positions.
          </div>
        )}
        {positions?.map((p) => (
          <div key={p.id} className="p-4 flex flex-col gap-2">
            <div className="flex justify-between items-start">
              <div>
                <div className="text-foreground font-bold font-mono text-sm">{p.symbol}</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                    p.status === 'filled' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' :
                    p.status === 'pending' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                    'bg-slate-800 text-slate-400 border-slate-700'
                  }`}>
                    {p.status}
                  </span>
                  {p.side === 'yes' && <span className="text-[10px] font-bold text-[#00ffd0]">YES</span>}
                  {p.side === 'no' && <span className="text-[10px] font-bold text-rose-400">NO</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-cyan-400 font-mono text-sm font-bold">{formatCents(p.entry_cost)}</div>
                <div className="text-xs font-mono mt-1">
                  <span className="text-foreground">{p.remaining_contracts !== undefined && p.remaining_contracts !== null ? p.remaining_contracts : p.filled_contracts}</span>
                  <span className="text-muted-foreground">/{p.requested_contracts} open</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop Table View */}
      <div className="hidden sm:block overflow-x-auto flex-1 custom-scrollbar">
        <table className="w-full text-left border-collapse min-w-[500px]">
          <thead className="bg-background/80 border-b sticky top-0">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Symbol</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold text-right">Side</th>
              <th className="px-4 py-3 font-semibold text-right">Remaining / Req</th>
              <th className="px-4 py-3 font-semibold text-right">Avg Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50 font-mono text-sm">
            {(!positions || positions.length === 0) && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-xs text-muted-foreground font-sans">
                  No active positions.
                </td>
              </tr>
            )}
            {positions?.map((p) => (
              <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <div className="text-foreground font-bold">{p.symbol}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                    p.status === 'filled' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' :
                    p.status === 'pending' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                    'bg-slate-800 text-slate-400 border-slate-700'
                  }`}>
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {p.side === 'yes' && <span className="text-[10px] font-bold text-[#00ffd0]">YES</span>}
                  {p.side === 'no' && <span className="text-[10px] font-bold text-rose-400">NO</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-foreground">{p.remaining_contracts !== undefined && p.remaining_contracts !== null ? p.remaining_contracts : p.filled_contracts}</span>
                  <span className="text-muted-foreground text-xs">/{p.requested_contracts}</span>
                </td>
                <td className="px-4 py-3 text-right text-cyan-400">
                  {formatCents(p.entry_cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CompactHistory({ history }: { history: LedgerRow[] | undefined }) {
  return (
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm h-full">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <History className="w-4 h-4 text-indigo-400" /> Recent History
        </h2>
      </div>

      {/* Mobile Stacked View */}
      <div className="block sm:hidden divide-y divide-border/50">
        {(!history || history.length === 0) && (
          <div className="p-8 text-center text-xs text-muted-foreground font-sans">
            No recent history.
          </div>
        )}
        {history?.slice(0, 10).map((p) => {
          const pnlVal = typeof p.pnl === 'string' ? parseFloat(p.pnl) : p.pnl;
          const isWin = pnlVal !== null && pnlVal !== undefined && pnlVal > 0;
          const isLoss = pnlVal !== null && pnlVal !== undefined && pnlVal < 0;

          return (
            <div key={p.id} className="p-4 flex flex-col gap-2">
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-foreground font-bold font-mono text-sm truncate max-w-[200px]">{p.symbol}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs font-mono">
                    <span className="text-foreground">{p.filled_contracts}</span>
                    <span className="text-[10px] font-bold text-muted-foreground">
                      {p.side === 'yes' ? 'Y' : p.side === 'no' ? 'N' : ''}
                    </span>
                    <span className="text-muted-foreground ml-1">@</span>
                    <span className="text-cyan-400">{formatCents(p.entry_cost)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`font-mono text-sm font-bold ${isWin ? 'text-[#00ffd0]' : isLoss ? 'text-rose-400' : 'text-muted-foreground'}`}>
                    {pnlVal !== null && pnlVal !== undefined ? `${pnlVal > 0 ? '+' : ''}${formatDollar(pnlVal)}` : '—'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop Table View */}
      <div className="hidden sm:block overflow-x-auto flex-1 custom-scrollbar">
        <table className="w-full text-left border-collapse min-w-[500px]">
          <thead className="bg-background/80 border-b sticky top-0">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Symbol</th>
              <th className="px-4 py-3 font-semibold text-right">Fills</th>
              <th className="px-4 py-3 font-semibold text-right">Avg Cost</th>
              <th className="px-4 py-3 font-semibold text-right">Net P&amp;L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50 font-mono text-sm">
            {(!history || history.length === 0) && (
              <tr>
                <td colSpan={4} className="p-8 text-center text-xs text-muted-foreground font-sans">
                  No recent history.
                </td>
              </tr>
            )}
            {history?.slice(0, 10).map((p) => {
              const pnlVal = typeof p.pnl === 'string' ? parseFloat(p.pnl) : p.pnl;
              const isWin = pnlVal !== null && pnlVal !== undefined && pnlVal > 0;
              const isLoss = pnlVal !== null && pnlVal !== undefined && pnlVal < 0;

              return (
                <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-foreground font-bold truncate max-w-[150px]">{p.symbol}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-foreground">{p.filled_contracts}</span>
                    <span className="text-[10px] font-bold ml-1 text-muted-foreground">
                      {p.side === 'yes' ? 'Y' : p.side === 'no' ? 'N' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-cyan-400">
                    {formatCents(p.entry_cost)}
                  </td>
                  <td className="px-4 py-3 text-right">
                     <span className={`font-bold ${isWin ? 'text-[#00ffd0]' : isLoss ? 'text-rose-400' : 'text-muted-foreground'}`}>
                       {pnlVal !== null && pnlVal !== undefined ? `${pnlVal > 0 ? '+' : ''}${formatDollar(pnlVal)}` : '—'}
                     </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CompactAudit({ readiness, audit }: { readiness: ReadinessReason[], audit: AuditRow[] | undefined }) {
  const ready = readiness.length > 0 && readiness.every(r => r.status === 'ready');

  return (
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm h-full">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-emerald-400" /> Safety &amp; Audit
        </h2>
        {ready ? (
          <span className="text-[10px] text-[#00ffd0] font-bold uppercase tracking-wider bg-[#00ffd0]/10 px-2 py-0.5 rounded border border-[#00ffd0]/20">Systems Go</span>
        ) : (
          <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">Checks Pending</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
        {/* Readiness */}
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold px-1">Pipeline Readiness</h3>
          {readiness.length === 0 ? (
            <div className="text-xs text-muted-foreground px-1">No safety checks configured</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {readiness.map((check) => (
                <div key={check.id} className="flex flex-col gap-1 p-2.5 rounded-lg border border-border/50 bg-background/50">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground">{check.label}</span>
                    {check.status === 'ready' && <CheckCircle2 className="w-3.5 h-3.5 text-[#00ffd0]" />}
                    {check.status === 'warming' && <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />}
                    {check.status === 'blocked' && <XCircle className="w-3.5 h-3.5 text-rose-400" />}
                    {check.status === 'stale' && <Clock className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                  <span className="text-[10px] text-muted-foreground leading-snug truncate" title={check.detail}>
                    {check.detail}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Audit */}
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold px-1">Recent Audit Events</h3>
          <div className="space-y-1 font-mono text-[10px]">
            {(!audit || audit.length === 0) ? (
              <div className="text-muted-foreground font-sans text-xs px-1">No recent audit events.</div>
            ) : (
              audit.slice(0, 10).map((a) => (
                <div key={a.id} className="flex gap-2 p-1.5 hover:bg-muted/30 rounded group">
                  <span className="text-muted-foreground/60 shrink-0">{formatDateTime(a.created_at).split(' ')[1]}</span>
                  <div className="flex flex-col overflow-hidden">
                    <span className="font-bold text-slate-300 uppercase tracking-wider truncate">{a.action}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}