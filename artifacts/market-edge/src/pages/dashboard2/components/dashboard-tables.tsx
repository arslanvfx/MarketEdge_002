import React from "react";
import { Dashboard2Status, LedgerRow, AuditRow, ReadinessReason } from "../types";
import { formatCents, formatDollar, formatDateTime } from "../utils";
import { Target, AlertCircle, ShieldCheck, Activity, ShieldAlert, CheckCircle2, Loader2, XCircle, Clock, History } from "lucide-react";

function positionMarketState(position: LedgerRow, markets: Dashboard2Status['markets']) {
  const market = markets.find(candidate =>
    candidate.ticker !== null
    && position.ticker !== null
    && candidate.ticker === position.ticker,
  );
  const probability = position.side === 'yes'
    ? market?.yesAsk ?? null
    : position.side === 'no'
      ? market?.noAsk ?? null
      : null;
  const isLive = Boolean(market?.bookFresh && market.displayState === 'live');
  const state = !isLive || probability === null
    ? 'unknown'
    : probability > 0.5
      ? 'holding'
      : probability < 0.5
        ? 'losing'
        : 'even';
  return { market, probability, isLive, state };
}

export function CompactLiveTargets({ markets }: { markets: Dashboard2Status['markets'] }) {
  return (
    <div className="bg-card border rounded-xl flex flex-col shadow-sm">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center shrink-0">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <Target className="w-4 h-4 text-cyan-400" /> Live Targets
        </h2>
        <span className="text-[11px] font-mono font-bold text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-400/20">
          {markets.length} ACTIVE
        </span>
      </div>

      <div className="block md:hidden divide-y divide-border/50">
        {markets.length === 0 && (
          <div className="p-8 text-center text-xs text-muted-foreground font-sans">
            No active targets in current window.
          </div>
        )}
        {markets.map((m) => {
          const isRetained = m.displayState === 'refreshing' || m.displayState === 'previous_window';
          return (
            <div key={m.symbol} className={`p-4 space-y-3 relative overflow-hidden transition-opacity ${isRetained ? 'opacity-80' : ''}`}>
              {isRetained && <div className="absolute top-0 left-0 w-1 h-full bg-amber-500/50"></div>}
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-sm font-bold text-foreground flex items-center gap-2">
                  {m.symbol}
                  {isRetained && <span className="text-[9px] font-sans font-bold bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded uppercase tracking-wider">{m.displayState === 'previous_window' ? 'Previous window' : 'Refreshing'}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {m.side === 'yes' && <span className="text-[11px] font-bold text-[#00ffd0] bg-[#00ffd0]/10 px-1.5 py-0.5 rounded">YES</span>}
                  {m.side === 'no' && <span className="text-[11px] font-bold text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">NO</span>}
                  <span className={`w-14 text-right font-mono text-sm font-bold tabular-nums ${isRetained ? 'text-cyan-400/70' : 'text-cyan-400'}`}>{formatCents(m.sideCost)}</span>
                </div>
              </div>
              <div className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                YES {formatCents(m.yesAsk)} · NO {formatCents(m.noAsk)}
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div><span className="block text-muted-foreground/70 uppercase text-[10px] tracking-wider mb-0.5">Target</span><span className="font-mono tabular-nums text-foreground">{m.target !== null ? m.target.toFixed(2) : "—"}</span></div>
                <div><span className="block text-muted-foreground/70 uppercase text-[10px] tracking-wider mb-0.5">Planned</span><span className="font-mono tabular-nums text-foreground">{m.intendedQuantity !== null && m.intendedQuantity > 0 ? formatDollar(m.intendedQuantity * (m.executableCost ?? 0)) : "—"}</span></div>
                <div><span className="block text-muted-foreground/70 uppercase text-[10px] tracking-wider mb-0.5">Available</span><span className="font-mono tabular-nums text-foreground">{m.visibleContracts}</span></div>
              </div>
              <div className="min-h-8 text-xs text-muted-foreground flex items-center gap-1.5">
                {isRetained ? (
                  <span className="text-[10px] uppercase font-bold text-amber-500 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded whitespace-nowrap">Retained Data</span>
                ) : (
                  <>
                    {m.safety === 'approved' && <ShieldCheck className="h-4 w-4 shrink-0 text-[#00ffd0]" />}
                    {m.safety === 'waiting' && <Activity className="h-4 w-4 shrink-0 text-amber-400" />}
                    {m.safety === 'blocked' && <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />}
                  </>
                )}
                <span className={isRetained ? 'text-amber-500/80' : 'text-muted-foreground'}>{m.reason?.replaceAll("_", " ") || "Monitoring"}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden md:block">
        <table className="w-full table-fixed text-left border-collapse">
          <thead className="bg-background/80 border-b">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-[15%] px-4 py-3 font-semibold">Market</th>
              <th className="w-[18%] px-3 py-3 font-semibold text-right">Target Ask</th>
              <th className="w-[14%] px-3 py-3 font-semibold text-right">Target</th>
              <th className="w-[14%] px-3 py-3 font-semibold text-right">Planned</th>
              <th className="w-[10%] px-3 py-3 font-semibold text-right">Avail</th>
              <th className="w-[29%] px-4 py-3 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50 text-sm">
            {markets.length === 0 && (
              <tr>
                 <td colSpan={6} className="p-8 text-center text-xs text-muted-foreground font-sans">
                  No active targets in current window.
                </td>
              </tr>
            )}
            {markets.map((m) => {
              const isRetained = m.displayState === 'refreshing' || m.displayState === 'previous_window';
              return (
                <tr key={m.symbol} className={`h-[58px] transition-all duration-300 ${isRetained ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-muted/20'}`}>
                  <td className="px-4 py-3 font-mono font-bold text-foreground">
                    <div className="flex items-center gap-2">
                      {isRetained && <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" title="Retained Display Data" />}
                      <span className={isRetained ? "opacity-90" : ""}>{m.symbol}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    <div className={`flex items-center justify-end gap-2 ${isRetained ? 'opacity-90' : ''}`}>
                      {m.side === 'yes' && <span className="text-[11px] font-bold text-[#00ffd0] bg-[#00ffd0]/10 px-1.5 py-0.5 rounded">YES</span>}
                      {m.side === 'no' && <span className="text-[11px] font-bold text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">NO</span>}
                      {!m.side && <span className="text-[11px] font-bold text-muted-foreground">—</span>}
                      <span className={`w-12 text-right ${isRetained ? 'text-cyan-400/80' : 'text-cyan-400'}`}>
                        {formatCents(m.sideCost)}
                      </span>
                    </div>
                     <div className={`mt-0.5 text-[10px] tabular-nums ${isRetained ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
                       Y {formatCents(m.yesAsk)} · N {formatCents(m.noAsk)}
                     </div>
                  </td>
                  <td className={`px-3 py-3 text-right font-mono tabular-nums ${isRetained ? 'text-muted-foreground' : ''}`}>{m.target !== null ? m.target.toFixed(2) : "—"}</td>
                  <td className={`px-3 py-3 text-right font-mono tabular-nums ${isRetained ? 'text-muted-foreground' : ''}`}>
                    {m.intendedQuantity !== null && m.executableCost !== null && m.intendedQuantity > 0 ? (
                      <div className={isRetained ? "text-muted-foreground" : "text-foreground"}>{formatDollar(m.intendedQuantity * m.executableCost)}</div>
                    ) : "—"}
                  </td>
                  <td className={`px-3 py-3 text-right font-mono tabular-nums ${isRetained ? 'text-muted-foreground' : 'text-foreground'}`}>
                    {m.visibleContracts}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {isRetained ? (
                        <span className="text-[10px] uppercase font-bold text-amber-500 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded whitespace-nowrap">{m.displayState === 'previous_window' ? 'Previous' : 'Refreshing'}</span>
                      ) : (
                        <>
                          {m.safety === 'approved' && <ShieldCheck className="h-4 w-4 shrink-0 text-[#00ffd0]" />}
                          {m.safety === 'waiting' && <Activity className="h-4 w-4 shrink-0 text-amber-400" />}
                          {m.safety === 'blocked' && <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />}
                        </>
                      )}
                      <span className={`truncate text-xs ${isRetained ? 'text-amber-500/80' : 'text-muted-foreground'}`} title={m.reason?.replaceAll("_", " ") || "Monitoring"}>
                        {m.reason?.replaceAll("_", " ") || "Monitoring"}
                      </span>
                    </div>
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

export function CompactPositions({ positions, markets }: { positions: LedgerRow[] | undefined, markets: Dashboard2Status['markets'] }) {
  return (
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center shrink-0">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <Activity className="w-4 h-4 text-amber-400" /> Active Positions
        </h2>
        <span className="text-[11px] font-mono font-bold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20">
          {positions?.length || 0} UNSETTLED
        </span>
      </div>

      <div className="block md:hidden divide-y divide-border/50">
        {(!positions || positions.length === 0) && (
          <div className="p-8 text-center text-xs text-muted-foreground font-sans">
            No active positions.
          </div>
        )}
        {positions?.map((p) => {
          const { probability: prob, state } = positionMarketState(p, markets);

          let probColor = "text-muted-foreground";
          let probBg = "bg-muted/10";
          let probBorder = "border-border";

          if (state === 'holding') {
             probColor = "text-[#00ffd0]";
             probBg = "bg-[#00ffd0]/10";
             probBorder = "border-[#00ffd0]/30";
          } else if (state === 'losing') {
             probColor = "text-rose-400";
             probBg = "bg-rose-500/10";
             probBorder = "border-rose-500/30";
          } else if (state === 'even') {
             probColor = "text-amber-400";
             probBg = "bg-amber-500/10";
             probBorder = "border-amber-500/30";
          }

          return (
            <div key={p.id} className={`p-4 flex flex-col gap-3 border-l-2 transition-colors ${
              state === 'holding'
                ? 'border-l-[#00ffd0] bg-[#00ffd0]/[0.035]'
                : state === 'losing'
                  ? 'border-l-rose-500 bg-rose-500/[0.035]'
                  : 'border-l-amber-500/40'
            }`}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-foreground font-bold font-mono text-sm">{p.symbol}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                      p.status === 'filled' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' :
                      p.status === 'pending' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                      'bg-slate-800 text-slate-400 border-slate-700'
                    }`}>
                      {p.status}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className={`flex items-center gap-2 px-2 py-1 rounded border ${probBg} ${probBorder}`}>
                    <span className={`text-[11px] font-bold ${p.side === 'yes' ? 'text-sky-300' : p.side === 'no' ? 'text-violet-300' : 'text-muted-foreground'}`}>
                      {p.side?.toUpperCase() || "—"}
                    </span>
                    {prob !== null ? (
                      <span className={`font-mono text-sm font-bold tabular-nums ${probColor}`}>
                        {formatCents(prob)}
                      </span>
                    ) : (
                      <span className="font-mono text-sm font-bold tabular-nums text-muted-foreground">—</span>
                    )}
                  </div>
                  <span className={`text-[9px] font-bold uppercase tracking-[0.16em] ${
                    state === 'holding' ? 'text-[#00ffd0]' : state === 'losing' ? 'text-rose-400' : 'text-amber-400'
                  }`}>
                    {state === 'holding' ? 'Holding' : state === 'losing' ? 'Losing' : state === 'even' ? 'Even' : 'Quote unavailable'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs border-t border-border/50 pt-3 mt-1">
                <div>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Entry Cost</div>
                  <div className="font-mono text-cyan-400 tabular-nums">{formatCents(p.entry_cost)}</div>
                </div>
                <div className="text-right">
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Size</div>
                  <div className="font-mono tabular-nums">
                    <span className="text-foreground">{p.remaining_contracts !== undefined && p.remaining_contracts !== null ? p.remaining_contracts : p.filled_contracts}</span>
                    <span className="text-muted-foreground/60">/{p.requested_contracts}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden md:block overflow-x-auto overflow-y-auto max-h-[400px] custom-scrollbar">
        <table className="w-full text-left border-collapse min-w-[500px]">
          <thead className="bg-background/80 border-b sticky top-0 z-10">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-semibold w-[25%]">Symbol</th>
              <th className="px-4 py-3 font-semibold w-[15%]">Status</th>
              <th className="px-4 py-3 font-semibold text-right w-[20%]">Entry</th>
              <th className="px-4 py-3 font-semibold text-right w-[15%]">Rem / Req</th>
              <th className="px-4 py-3 font-semibold text-right w-[25%]">Direction &amp; Prob</th>
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
            {positions?.map((p) => {
              const { probability: prob, state } = positionMarketState(p, markets);

              let probColor = "text-muted-foreground";
              let probBg = "bg-transparent";
              let probBorder = "border-transparent";
              const directionBg = p.side === 'yes'
                ? 'bg-sky-400/10 text-sky-300'
                : p.side === 'no'
                  ? 'bg-violet-400/10 text-violet-300'
                  : 'bg-muted/10 text-muted-foreground';

              if (state === 'holding') {
                 probColor = "text-[#00ffd0]";
                 probBg = "bg-[#00ffd0]/10";
                 probBorder = "border-[#00ffd0]/30";
              } else if (state === 'losing') {
                 probColor = "text-rose-400";
                 probBg = "bg-rose-500/10";
                 probBorder = "border-rose-500/30";
              } else if (state === 'even') {
                 probColor = "text-amber-400";
                 probBg = "bg-amber-500/10";
                 probBorder = "border-amber-500/30";
              }

              return (
                <tr key={p.id} className={`transition-colors group ${
                  state === 'holding'
                    ? 'bg-[#00ffd0]/[0.035] hover:bg-[#00ffd0]/[0.07]'
                    : state === 'losing'
                      ? 'bg-rose-500/[0.035] hover:bg-rose-500/[0.07]'
                      : 'hover:bg-muted/30'
                }`}>
                  <td className={`px-4 py-3 border-l-2 ${
                    state === 'holding' ? 'border-l-[#00ffd0]' : state === 'losing' ? 'border-l-rose-500' : 'border-l-amber-500/40'
                  }`}>
                    <div className="text-foreground font-bold truncate max-w-[200px]">{p.symbol}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                      p.status === 'filled' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' :
                      p.status === 'pending' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                      'bg-slate-800 text-slate-400 border-slate-700'
                    }`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-cyan-400 tabular-nums">
                      {formatCents(p.entry_cost)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-foreground tabular-nums">{p.remaining_contracts !== undefined && p.remaining_contracts !== null ? p.remaining_contracts : p.filled_contracts}</span>
                    <span className="text-muted-foreground/50 text-xs tabular-nums ml-1">/{p.requested_contracts}</span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end">
                      <div className={`flex items-center gap-2 px-2 py-1 rounded border transition-colors ${probBg} ${probBorder}`}>
                        <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-sm ${directionBg}`}>
                          {p.side?.toUpperCase() || "—"}
                        </span>
                        {prob !== null ? (
                          <span className={`w-10 text-right font-bold tabular-nums ${probColor}`}>
                            {formatCents(prob)}
                          </span>
                        ) : (
                          <span className="w-10 text-right font-bold tabular-nums text-muted-foreground">—</span>
                        )}
                        <span className={`w-14 text-left text-[9px] font-sans font-bold uppercase tracking-wider ${
                          state === 'holding' ? 'text-[#00ffd0]' : state === 'losing' ? 'text-rose-400' : 'text-amber-400'
                        }`}>
                          {state === 'holding' ? 'Holding' : state === 'losing' ? 'Losing' : state === 'even' ? 'Even' : 'No quote'}
                        </span>
                      </div>
                    </div>
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

export function CompactHistory({ history }: { history: LedgerRow[] | undefined }) {
  return (
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center shrink-0">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <History className="w-4 h-4 text-indigo-400" /> Recent History
        </h2>
      </div>

      <div className="block md:hidden divide-y divide-border/50">
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
                  <div className="mt-1.5 flex items-center gap-2 text-xs font-mono tabular-nums">
                    <span className="text-foreground">{p.filled_contracts}</span>
                    <span className={`text-[10px] font-bold px-1 py-0.5 rounded-sm ${
                      p.side === 'yes' ? 'bg-[#00ffd0]/10 text-[#00ffd0]' :
                      p.side === 'no' ? 'bg-rose-500/10 text-rose-400' : 'bg-muted/10 text-muted-foreground'
                    }`}>
                      {p.side === 'yes' ? 'YES' : p.side === 'no' ? 'NO' : '—'}
                    </span>
                    <span className="text-muted-foreground">@</span>
                    <span className="text-cyan-400">{formatCents(p.entry_cost)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`font-mono text-sm font-bold tabular-nums ${isWin ? 'text-[#00ffd0]' : isLoss ? 'text-rose-400' : 'text-muted-foreground'}`}>
                    {pnlVal !== null && pnlVal !== undefined ? `${pnlVal > 0 ? '+' : ''}${formatDollar(pnlVal)}` : '—'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden md:block overflow-x-auto overflow-y-auto max-h-[400px] custom-scrollbar">
        <table className="w-full text-left border-collapse min-w-[500px]">
          <thead className="bg-background/80 border-b sticky top-0 z-10">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-semibold w-[40%]">Symbol</th>
              <th className="px-4 py-3 font-semibold text-right w-[20%]">Fills</th>
              <th className="px-4 py-3 font-semibold text-right w-[20%]">Avg Cost</th>
              <th className="px-4 py-3 font-semibold text-right w-[20%]">Net P&amp;L</th>
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
                    <div className="text-foreground font-bold truncate max-w-[300px]" title={p.symbol}>{p.symbol}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-foreground tabular-nums">{p.filled_contracts}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${
                        p.side === 'yes' ? 'bg-[#00ffd0]/10 text-[#00ffd0]' :
                        p.side === 'no' ? 'bg-rose-500/10 text-rose-400' : 'bg-muted/10 text-muted-foreground'
                      }`}>
                        {p.side === 'yes' ? 'YES' : p.side === 'no' ? 'NO' : '—'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-cyan-400 tabular-nums">
                    {formatCents(p.entry_cost)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
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
    <div className="bg-card border rounded-xl flex flex-col overflow-hidden shadow-sm">
      <div className="p-4 border-b bg-background/30 flex justify-between items-center shrink-0">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-emerald-400" /> Safety &amp; Audit
        </h2>
        {ready ? (
          <span className="text-[11px] text-[#00ffd0] font-bold uppercase tracking-wider bg-[#00ffd0]/10 px-2 py-0.5 rounded border border-[#00ffd0]/20">Systems Go</span>
        ) : (
          <span className="text-[11px] text-amber-400 font-bold uppercase tracking-wider bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">Checks Pending</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar max-h-[400px]">
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold px-1">Pipeline Readiness</h3>
          {readiness.length === 0 ? (
            <div className="text-xs text-muted-foreground px-1 font-sans">No safety checks configured</div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {readiness.map((check) => (
                <div key={check.id} className="flex flex-col gap-1 p-2.5 rounded-lg border border-border/50 bg-background/50 hover:border-border transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-foreground tracking-wide uppercase">{check.label}</span>
                    {check.status === 'ready' && <CheckCircle2 className="w-3.5 h-3.5 text-[#00ffd0]" />}
                    {check.status === 'warming' && <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />}
                    {check.status === 'blocked' && <XCircle className="w-3.5 h-3.5 text-rose-400" />}
                    {check.status === 'stale' && <Clock className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                  <span className="text-[11px] text-muted-foreground leading-snug truncate" title={check.detail}>
                    {check.detail}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold px-1">Recent Events</h3>
          <div className="space-y-1 font-mono text-[11px]">
            {(!audit || audit.length === 0) ? (
              <div className="text-muted-foreground font-sans text-xs px-1">No recent audit events.</div>
            ) : (
              audit.slice(0, 10).map((a) => (
                <div key={a.id} className="flex gap-3 p-1.5 hover:bg-muted/30 rounded group transition-colors">
                  <span className="text-muted-foreground/50 shrink-0">{formatDateTime(a.created_at).split(' ')[1]}</span>
                  <div className="flex flex-col overflow-hidden">
                    <span className="font-bold text-slate-300 uppercase tracking-wider truncate group-hover:text-cyan-400 transition-colors">{a.action}</span>
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
