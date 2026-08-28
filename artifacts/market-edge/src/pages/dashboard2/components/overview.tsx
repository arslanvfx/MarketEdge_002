import React from "react";
import { Dashboard2Status, DailyPerformance, WhatIfPerformance } from "../types";
import { formatTime, formatDollar } from "../utils";
import { Clock, Server, Activity, TrendingUp, TrendingDown, Percent, Info, ShieldCheck, Loader2, AlertTriangle } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ReferenceLine } from "recharts";

export function KpiCards({ daily, mode }: { daily?: DailyPerformance, mode: 'paper' | 'live' }) {
  const pnlNum = typeof daily?.summary.todayPnl === 'string' ? parseFloat(daily?.summary.todayPnl) : (daily?.summary.todayPnl || 0);
  const pnlColor = pnlNum >= 0 ? "text-[#00ffd0]" : "text-rose-500";
  const pnlBg = pnlNum >= 0 ? "bg-[#00ffd0]/10 border-[#00ffd0]/20" : "bg-rose-500/10 border-rose-500/20";
  const PnlIcon = pnlNum >= 0 ? TrendingUp : TrendingDown;

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
      <div className="bg-card border rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition-colors shadow-sm">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2 mb-2">
          <span className="text-cyan-400 font-bold">$</span> {daily?.summary.balanceLabel || `${mode} Balance`}
        </h2>
        <span className="font-mono text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
          {daily?.summary.balance != null ? formatDollar(daily.summary.balance) : '—'}
        </span>
      </div>

      <div className={`border rounded-xl p-5 flex flex-col justify-between shadow-sm transition-colors ${pnlBg}`}>
        <div className="flex items-center justify-between mb-2">
          <h2 className={`text-xs uppercase tracking-widest font-semibold flex items-center gap-2 ${pnlColor} opacity-90`}>
            <PnlIcon className="w-4 h-4" /> P&L ({mode})
          </h2>
          <span className="text-[10px] text-muted-foreground bg-background/50 px-2 py-0.5 rounded font-mono border border-border/50">
            {daily?.timeZone || 'ET'}
          </span>
        </div>
        <div className="flex flex-col">
          <span className={`font-mono text-2xl lg:text-3xl font-bold tracking-tight ${pnlColor}`}>
            {pnlNum > 0 ? "+" : ""}{formatDollar(pnlNum)}
          </span>
        </div>
      </div>

      <div className="bg-card border rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition-colors shadow-sm">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2 mb-2">
          <Percent className="w-4 h-4 text-indigo-400" /> Win Rate ({mode})
        </h2>
        <span className="font-mono text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
          {daily?.summary.winRate != null ? `${(daily.summary.winRate * 100).toFixed(1)}%` : '—'}
        </span>
      </div>

      <div className="bg-card border rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition-colors shadow-sm">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2 mb-2">
          <Activity className="w-4 h-4 text-amber-400" /> Total Bets ({mode})
        </h2>
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
            {daily?.summary.totalBets || 0}
          </span>
          <span className="text-xs font-mono text-muted-foreground tracking-tight">
            <span className="text-[#00ffd0]">{daily?.summary.wins || 0}W</span> <span className="text-border mx-1">/</span> <span className="text-rose-400">{daily?.summary.losses || 0}L</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export function HourlyChart({ daily, mode, footer }: { daily?: DailyPerformance, mode: string, footer?: React.ReactNode }) {
  const hourlyData = daily?.hours?.map(h => ({
    time: `${h.etHour > 12 ? h.etHour - 12 : h.etHour === 0 ? 12 : h.etHour}${h.etHour >= 12 ? 'p' : 'a'}`,
    pnl: h.pnl,
    bets: h.bets
  })) || [];

  const hasActivity = hourlyData.some(h => h.bets > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-card border rounded-xl p-5 shadow-sm flex flex-col flex-1 min-h-[260px]">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-sm font-bold text-foreground tracking-widest uppercase">Today's P&L by Hour</h2>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono uppercase tracking-wider">
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-[#00ffd0]"></div> <span className="text-muted-foreground">Profit</span></div>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-rose-500"></div> <span className="text-muted-foreground">Loss</span></div>
          </div>
        </div>

        <div className="flex-1 w-full min-h-[200px] relative">
           {hasActivity ? (
             <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="2 2" />
                <XAxis
                  dataKey="time"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                  dy={8}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(val) => `$${val}`}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      const isProfit = data.pnl >= 0;
                      return (
                        <div className="bg-popover border border-border rounded-lg shadow-xl p-3 flex flex-col gap-1.5">
                          <span className="text-xs font-bold text-muted-foreground uppercase">{data.time}</span>
                          <span className={`font-mono text-lg font-bold ${isProfit ? 'text-[#00ffd0]' : 'text-rose-500'}`}>
                            {isProfit ? '+' : ''}{formatDollar(data.pnl)}
                          </span>
                          <span className="text-xs text-muted-foreground">{data.bets} bets</span>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar dataKey="pnl" radius={[2, 2, 2, 2]} maxBarSize={32}>
                  {hourlyData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.pnl >= 0 ? '#00ffd0' : '#f43f5e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
           ) : (
             <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs font-mono border border-dashed border-border rounded-lg bg-background/20">
               No trading activity today.
             </div>
           )}
        </div>
      </div>
      {footer}
    </div>
  );
}

export function WindowStatusCard({ status }: { status: Dashboard2Status }) {
  return (
    <div className="bg-card border rounded-xl p-5 shadow-sm shrink-0">
       <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2 mb-4">
          <Clock className="w-4 h-4" /> Current Window
       </h2>

       <div className="flex items-center justify-between bg-background border border-border/50 rounded-lg p-3 mb-4">
         <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-bold">Phase</span>
         <div className={`px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
           status.window.phase === 'eligible' ? 'bg-[#00ffd0]/10 text-[#00ffd0] border border-[#00ffd0]/20 shadow-[0_0_10px_rgba(0,255,208,0.1)]' :
           status.window.phase === 'armed' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
           status.window.phase === 'blocked' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' :
           'bg-slate-800 text-slate-400 border border-slate-700'
         }`}>
            {status.window.phase === 'eligible' && status.system.running && <span className="w-1.5 h-1.5 rounded-full bg-[#00ffd0] animate-pulse" />}
            {status.window.phase}
         </div>
       </div>

       <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-bold">Elapsed</span>
            <span className="font-mono text-sm font-medium text-foreground">{formatTime(status.window.elapsedSeconds)}</span>
          </div>
          <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-bold">Entry In</span>
            <span className="font-mono text-sm font-medium text-foreground">{formatTime(status.window.entryOpensInSeconds)}</span>
          </div>
       </div>
    </div>
  );
}

export function TelemetryCard({ status }: { status: Dashboard2Status }) {
  return (
    <div className="bg-card border border-cyan-500/20 rounded-xl p-5 shadow-sm flex flex-col max-h-[520px]">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div>
            <h2 className="text-xs uppercase tracking-widest text-cyan-300 font-semibold flex items-center gap-2">
              <Server className="w-4 h-4" /> Live Decision Feed
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Current BET/SKIP reasons update every second.</p>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-mono text-cyan-300">
            LIVE
            <span className="w-2 h-2 rounded-full bg-[#00ffd0] animate-pulse shadow-[0_0_8px_rgba(0,255,208,0.5)]"></span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-2.5 font-mono text-xs custom-scrollbar">
          {status.recentEvents.length === 0 ? (
             <div className="text-center text-muted-foreground mt-6 font-sans text-sm">No recent telemetry</div>
          ) : (
            status.recentEvents.slice(0, 30).map((e) => {
              const time = new Date(e.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
              return (
                <div key={e.id} className="flex gap-3 group leading-relaxed">
                  <span className="text-muted-foreground/50 shrink-0 select-none group-hover:text-muted-foreground/80 transition-colors">{time}</span>
                  <span className={`break-words ${
                    e.severity === 'error' ? 'text-rose-400' :
                    e.severity === 'warning' ? 'text-amber-400' :
                    e.severity === 'success' ? 'text-[#00ffd0]' :
                    'text-slate-300'
                  }`}>
                    {e.message}
                  </span>
                </div>
              );
            })
          )}
        </div>
    </div>
  );
}

export function WhatIfCalculator({
  data,
  stake,
  setStake,
  isLoading,
  isError,
  isValid
}: {
  data?: WhatIfPerformance,
  stake: string,
  setStake: (v: string) => void,
  isLoading: boolean,
  isError: boolean,
  isValid: boolean
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="bg-card border rounded-xl shadow-sm overflow-hidden transition-all duration-300">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-muted/30 transition-colors focus:outline-none"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded border border-indigo-500/20 bg-indigo-500/10 flex items-center justify-center shrink-0">
            <Info className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-left">
             <h3 className="text-sm font-bold text-foreground">What-If Calculator</h3>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {!expanded && data && !isLoading && !isError && (
            <div className="hidden sm:flex items-center gap-3 text-xs font-mono mr-3">
               <span className="text-muted-foreground">Act: <span className={data.actualPnl >= 0 ? "text-[#00ffd0]" : "text-rose-400"}>{formatDollar(data.actualPnl)}</span></span>
               <span className="text-border">|</span>
               <span className="text-muted-foreground">Hyp: <span className={data.hypotheticalPnl >= 0 ? "text-indigo-400" : "text-rose-400"}>{formatDollar(data.hypotheticalPnl)}</span></span>
            </div>
          )}
          {isLoading && !expanded && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mr-3" />}
          <div className={`p-1 rounded transition-transform duration-200 text-muted-foreground ${expanded ? 'rotate-180 bg-muted' : ''}`}>
             <svg width="14" height="14" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
               <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
             </svg>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="p-5 border-t border-border/50 bg-background/30 flex flex-col gap-5">
          <div className="flex flex-col sm:flex-row gap-5 items-start sm:items-center">
            <div className="w-full sm:w-56 space-y-2 shrink-0">
              <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Hypothetical Stake ($)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">$</span>
                <input
                  type="number"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className={`w-full bg-background border ${!isValid ? 'border-rose-500 focus:ring-rose-500/20' : 'border-border focus:border-indigo-500/50'} rounded-lg py-2 pl-7 pr-3 text-sm font-mono text-foreground focus:outline-none focus:ring-1 transition-all`}
                  placeholder="100.00"
                  step="10"
                />
              </div>
              {!isValid ? (
                <p className="text-xs text-rose-500">Invalid stake amount.</p>
              ) : (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Applied to {data?.includedCount || 0} valid bets today.
                </p>
              )}
            </div>

            {isLoading ? (
               <div className="flex-1 flex justify-center items-center h-16 text-muted-foreground gap-3 w-full">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-xs font-mono">Simulating...</span>
               </div>
            ) : isError ? (
               <div className="flex-1 flex justify-center items-center h-16 text-rose-400 gap-3 w-full">
                  <AlertTriangle className="w-5 h-5" />
                  <span className="text-xs font-mono">Failed</span>
               </div>
            ) : data && isValid ? (
              <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-4 w-full">
                 <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-background border border-border/50">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Actual ROI</span>
                    <span className="font-mono font-medium text-sm">
                      {data.actualRoiPct != null ? (
                        <span className={data.actualRoiPct >= 0 ? "text-[#00ffd0]" : "text-rose-400"}>
                          {data.actualRoiPct > 0 ? '+' : ''}{(data.actualRoiPct).toFixed(2)}%
                        </span>
                      ) : '—'}
                    </span>
                 </div>
                 <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-background border border-border/50">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Hypo ROI</span>
                    <span className="font-mono font-medium text-sm">
                      {data.hypotheticalRoiPct != null ? (
                        <span className={data.hypotheticalRoiPct >= 0 ? "text-indigo-400" : "text-rose-400"}>
                          {data.hypotheticalRoiPct > 0 ? '+' : ''}{(data.hypotheticalRoiPct).toFixed(2)}%
                        </span>
                      ) : '—'}
                    </span>
                 </div>
                 <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-indigo-500/5 border border-indigo-500/20 col-span-2 md:col-span-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400/80">Delta (P&L)</span>
                    <div className="flex items-center gap-3">
                      <span className={`font-mono font-bold text-lg ${data.deltaPnl >= 0 ? "text-indigo-400" : "text-rose-400"}`}>
                        {data.deltaPnl > 0 ? '+' : ''}{formatDollar(data.deltaPnl)}
                      </span>
                      {data.deltaPct != null && (
                         <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded ${data.deltaPct >= 0 ? 'bg-indigo-500/20 text-indigo-400' : 'bg-rose-500/20 text-rose-400'}`}>
                           {data.deltaPct > 0 ? '+' : ''}{(data.deltaPct).toFixed(1)}%
                         </span>
                      )}
                    </div>
                 </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}