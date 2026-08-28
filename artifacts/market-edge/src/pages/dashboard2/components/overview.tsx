import React from "react";
import { Dashboard2Status, DailyPerformance, WhatIfPerformance } from "../types";
import { formatTime, formatDollar } from "../utils";
import { Clock, Server, Activity, TrendingUp, TrendingDown, Percent, Info, ShieldCheck, Loader2, AlertTriangle } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ReferenceLine } from "recharts";

export function CommandOverview({
  status,
  daily,
  mode,
  afterKpis,
  hourlyFooter,
  beforeTelemetry,
}: {
  status: Dashboard2Status,
  daily?: DailyPerformance,
  mode: 'paper' | 'live',
  afterKpis?: React.ReactNode,
  hourlyFooter?: React.ReactNode,
  beforeTelemetry?: React.ReactNode,
}) {
  const pnlNum = typeof daily?.summary.todayPnl === 'string' ? parseFloat(daily?.summary.todayPnl) : (daily?.summary.todayPnl || 0);
  const pnlColor = pnlNum >= 0 ? "text-[#00ffd0]" : "text-rose-500";
  const pnlBg = pnlNum >= 0 ? "bg-[#00ffd0]/10 border-[#00ffd0]/20" : "bg-rose-500/10 border-rose-500/20";
  const PnlIcon = pnlNum >= 0 ? TrendingUp : TrendingDown;

  const hourlyData = daily?.hours?.map(h => ({
    time: `${h.etHour > 12 ? h.etHour - 12 : h.etHour === 0 ? 12 : h.etHour}${h.etHour >= 12 ? 'p' : 'a'}`,
    pnl: h.pnl,
    bets: h.bets
  })) || [];

  const hasActivity = hourlyData.some(h => h.bets > 0);

  return (
    <div className="flex flex-col gap-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Balance Card */}
        <div className="bg-card border rounded-xl p-5 flex flex-col justify-between hover:border-slate-800 transition-colors shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
              <span className="text-cyan-400 font-bold">$</span> {daily?.summary.balanceLabel || `${mode} Balance`}
            </h2>
          </div>
          <div className="flex items-end justify-between">
            <span className="font-mono text-3xl font-bold tracking-tight text-foreground">
              {daily?.summary.balance != null ? formatDollar(daily.summary.balance) : '—'}
            </span>
          </div>
        </div>

        {/* Today's PNL Card */}
        <div className={`border rounded-xl p-5 flex flex-col justify-between shadow-sm transition-colors ${pnlBg}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className={`text-xs uppercase tracking-widest font-semibold flex items-center gap-2 ${pnlColor} opacity-90`}>
              <PnlIcon className="w-4 h-4" /> Today's P&L ({mode})
            </h2>
            <span className="text-[10px] text-muted-foreground bg-background/50 px-2 py-0.5 rounded font-mono border border-border">
              {daily?.timeZone || 'ET'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className={`font-mono text-3xl font-bold tracking-tight ${pnlColor}`}>
              {pnlNum > 0 ? "+" : ""}{formatDollar(pnlNum)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Resets at {daily?.nextResetAt ? new Date(daily.nextResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
            </span>
          </div>
        </div>

        {/* Win Rate Card */}
        <div className="bg-card border rounded-xl p-5 flex flex-col justify-between hover:border-slate-800 transition-colors shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
              <Percent className="w-4 h-4 text-indigo-400" /> Win Rate ({mode})
            </h2>
          </div>
          <div className="flex items-end justify-between">
            <span className="font-mono text-3xl font-bold tracking-tight text-foreground">
              {daily?.summary.winRate != null ? `${(daily.summary.winRate * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
        </div>

        {/* Total Bets Card */}
        <div className="bg-card border rounded-xl p-5 flex flex-col justify-between hover:border-slate-800 transition-colors shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-amber-400" /> Total Bets ({mode})
            </h2>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-3xl font-bold tracking-tight text-foreground">
              {daily?.summary.totalBets || 0}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground tracking-tight">
              <span className="text-[#00ffd0]">{daily?.summary.wins || 0}W</span> / <span className="text-rose-400">{daily?.summary.losses || 0}L</span> {daily?.summary.pushes ? `/ ${daily.summary.pushes}P` : ''}
            </span>
          </div>
        </div>
      </div>

      {afterKpis}

      {/* Main Chart & Side Info Area */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Hourly Chart Section */}
        <div className="lg:col-span-2 flex min-w-0 flex-col gap-6">
        <div className="bg-card border rounded-xl p-5 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-sm font-semibold text-foreground tracking-wide">Today's P&L by Hour</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Midnight to Midnight ET • {mode.charAt(0).toUpperCase() + mode.slice(1)}</p>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono">
              <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-[#00ffd0]"></div> <span className="text-muted-foreground">Profit</span></div>
              <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-rose-500"></div> <span className="text-muted-foreground">Loss</span></div>
            </div>
          </div>

          <div className="flex-1 min-h-[220px] w-full mt-2 relative">
             {hasActivity ? (
               <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(val) => `$${val}`}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                  />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        const isProfit = data.pnl >= 0;
                        return (
                          <div className="bg-popover border border-border rounded-lg shadow-xl p-3 flex flex-col gap-1.5">
                            <span className="text-xs font-semibold text-muted-foreground">{data.time}</span>
                            <span className={`font-mono text-lg font-bold ${isProfit ? 'text-[#00ffd0]' : 'text-rose-500'}`}>
                              {isProfit ? '+' : ''}{formatDollar(data.pnl)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">{data.bets} bets placed</span>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar dataKey="pnl" radius={[2, 2, 2, 2]} maxBarSize={40}>
                    {hourlyData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.pnl >= 0 ? '#00ffd0' : '#f43f5e'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
             ) : (
               <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm font-mono border border-dashed border-border rounded-lg bg-background/30">
                 No trading activity today.
               </div>
             )}
          </div>
        </div>
        {hourlyFooter}
        </div>

        {/* Telemetry & System Status Sidebar */}
        <div className="lg:col-span-1 flex flex-col gap-4">

          {/* Window Status */}
          <div className="bg-card border rounded-xl p-5 shadow-sm">
             <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2 mb-4">
                <Clock className="w-4 h-4" /> Current Window
             </h2>

             <div className="flex items-center justify-between bg-background border border-border/50 rounded-lg p-3 mb-4">
               <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Phase</span>
               <div className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
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
                <div className="flex flex-col gap-1 p-2 rounded-lg bg-background/50 border border-border/30">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Elapsed</span>
                  <span className="font-mono text-sm font-medium text-foreground">{formatTime(status.window.elapsedSeconds)}</span>
                </div>
                <div className="flex flex-col gap-1 p-2 rounded-lg bg-background/50 border border-border/30">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Entry In</span>
                  <span className="font-mono text-sm font-medium text-foreground">{formatTime(status.window.entryOpensInSeconds)}</span>
                </div>
             </div>
          </div>

          {beforeTelemetry}

          {/* Quick Telemetry Stream */}
           <div className="bg-card border rounded-xl p-5 shadow-sm flex flex-col flex-1 min-h-[200px] max-h-[300px]">
             <div className="flex items-center justify-between mb-4">
               <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
                 <Server className="w-4 h-4" /> Telemetry
               </h2>
               <span className="w-2 h-2 rounded-full bg-[#00ffd0] animate-pulse shadow-[0_0_8px_rgba(0,255,208,0.5)]"></span>
             </div>

             <div className="flex-1 overflow-y-auto pr-1 space-y-2.5 font-mono text-[11px] custom-scrollbar">
               {status.recentEvents.length === 0 ? (
                  <div className="text-center text-muted-foreground mt-8 font-sans text-xs">No recent telemetry</div>
               ) : (
                 status.recentEvents.slice(0, 10).map((e) => {
                   const time = new Date(e.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                   return (
                     <div key={e.id} className="flex gap-2.5 group">
                       <span className="text-muted-foreground/60 shrink-0 select-none group-hover:text-muted-foreground transition-colors">{time}</span>
                       <span className={`break-words leading-snug ${
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

        </div>
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
        className="w-full p-4 flex items-center justify-between hover:bg-muted/50 transition-colors focus:outline-none"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
            <Info className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-left">
             <h3 className="text-sm font-semibold text-foreground">Daily P&L What-If Calculator</h3>
             <p className="text-xs text-muted-foreground mt-0.5">{data?.timeZone || 'Eastern'} • {data?.mode || '—'} • Midnight to Midnight</p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {!expanded && data && !isLoading && !isError && (
            <div className="hidden sm:flex items-center gap-3 text-xs font-mono mr-4">
               <span className="text-muted-foreground">Actual: <span className={data.actualPnl >= 0 ? "text-[#00ffd0]" : "text-rose-400"}>{formatDollar(data.actualPnl)}</span></span>
               <span className="text-border">|</span>
               <span className="text-muted-foreground">Hypothetical: <span className={data.hypotheticalPnl >= 0 ? "text-indigo-400" : "text-rose-400"}>{formatDollar(data.hypotheticalPnl)}</span></span>
            </div>
          )}
          {isLoading && !expanded && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mr-4" />}
          <div className={`p-1 rounded transition-transform duration-200 ${expanded ? 'rotate-180 bg-muted' : ''}`}>
             <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
               <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
             </svg>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="p-5 border-t border-border/50 bg-background/30 flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row gap-6 items-start sm:items-center">
            <div className="w-full sm:w-64 space-y-2 shrink-0">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hypothetical Stake ($)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono">$</span>
                <input
                  type="number"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className={`w-full bg-background border ${!isValid ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/20' : 'border-border focus:border-indigo-500/50 focus:ring-indigo-500/20'} rounded-lg py-2.5 pl-7 pr-3 text-sm font-mono text-foreground focus:outline-none focus:ring-1 transition-all`}
                  placeholder="100.00"
                  step="10"
                />
              </div>
              {!isValid ? (
                <p className="text-[10px] text-rose-500 font-medium">Please enter a valid stake between $0.01 and $10,000.</p>
              ) : (
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Applies this flat stake to all {data?.includedCount || 0} valid bets today. Excludes {data?.excludedCount || 0} structurally invalid bets.
                </p>
              )}
            </div>

            {isLoading ? (
               <div className="flex-1 flex justify-center items-center h-20 text-muted-foreground gap-2 w-full">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-xs font-mono">Calculating simulation...</span>
               </div>
            ) : isError ? (
               <div className="flex-1 flex justify-center items-center h-20 text-rose-400 gap-2 w-full">
                  <AlertTriangle className="w-5 h-5" />
                  <span className="text-xs font-mono">Failed to calculate</span>
               </div>
            ) : data && isValid ? (
              <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-4 w-full">
                 <div className="flex flex-col gap-1 p-3 rounded-lg bg-background border border-border/50">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Actual ROI</span>
                    <span className="font-mono font-medium text-sm">
                      {data.actualRoiPct != null ? (
                        <span className={data.actualRoiPct >= 0 ? "text-[#00ffd0]" : "text-rose-400"}>
                          {data.actualRoiPct > 0 ? '+' : ''}{(data.actualRoiPct).toFixed(2)}%
                        </span>
                      ) : '—'}
                    </span>
                 </div>
                 <div className="flex flex-col gap-1 p-3 rounded-lg bg-background border border-border/50">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Hypothetical ROI</span>
                    <span className="font-mono font-medium text-sm">
                      {data.hypotheticalRoiPct != null ? (
                        <span className={data.hypotheticalRoiPct >= 0 ? "text-indigo-400" : "text-rose-400"}>
                          {data.hypotheticalRoiPct > 0 ? '+' : ''}{(data.hypotheticalRoiPct).toFixed(2)}%
                        </span>
                      ) : '—'}
                    </span>
                 </div>
                 <div className="flex flex-col gap-1 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20 col-span-2 md:col-span-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400/70">Performance Delta (P&L)</span>
                    <div className="flex items-center gap-2">
                      <span className={`font-mono font-bold text-lg ${data.deltaPnl >= 0 ? "text-indigo-400" : "text-rose-400"}`}>
                        {data.deltaPnl > 0 ? '+' : ''}{formatDollar(data.deltaPnl)}
                      </span>
                      {data.deltaPct != null && (
                         <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${data.deltaPct >= 0 ? 'bg-indigo-500/20 text-indigo-400' : 'bg-rose-500/20 text-rose-400'}`}>
                           {data.deltaPct > 0 ? '+' : ''}{(data.deltaPct).toFixed(1)}%
                         </span>
                      )}
                    </div>
                 </div>
              </div>
            ) : null}
          </div>

          {data?.assumptions && data.assumptions.length > 0 && (
            <div className="bg-background/50 border border-border/50 rounded-lg p-3">
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3" /> Calculation Assumptions
              </h4>
              <ul className="text-xs text-muted-foreground space-y-1.5 font-mono">
                {data.assumptions.map((a, i) => (
                  <li key={i} className="flex gap-2 leading-tight">
                    <span className="text-border">-</span> {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}