import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchAnalytics } from "../api";
import { formatDollar } from "../utils";
import { BarChart2, TrendingUp, Target, Activity, CheckCircle, Loader2, AlertTriangle } from "lucide-react";

export default function PerformanceTab({ mode }: { mode: 'paper' | 'live' }) {
  const { getToken } = useAuth();

  const { data: analytics, isLoading, isError } = useQuery({
    queryKey: ["dashboard2-analytics", mode],
    queryFn: async () => fetchAnalytics(await getToken(), mode),
    refetchInterval: 10000,
  });

  if (isLoading && !analytics) {
    return (
      <div className="flex h-[300px] items-center justify-center text-slate-500 gap-3 bg-[#0f141d] border border-slate-800/60 rounded-lg">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-mono text-sm tracking-widest uppercase">Loading Analytics...</span>
      </div>
    );
  }

  if (isError && !analytics) {
    return (
      <div className="flex h-[300px] items-center justify-center text-rose-500 gap-3 bg-[#0f141d] border border-slate-800/60 rounded-lg">
        <AlertTriangle className="w-5 h-5" />
        <span className="font-mono text-sm tracking-widest uppercase">Failed to load analytics</span>
      </div>
    );
  }

  const pnlNum = typeof analytics?.pnl === 'string' ? parseFloat(analytics.pnl) : (analytics?.pnl || 0);
  const pnlColor = pnlNum >= 0 ? "text-emerald-400" : "text-rose-400";
  const pnlBg = pnlNum >= 0 ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20";

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 h-full content-start">

      <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg p-5 flex flex-col justify-between">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
            <Target className="w-4 h-4" /> Attempts
          </h2>
        </div>
        <div className="flex items-end justify-between">
          <span className="font-mono text-4xl text-slate-200">{analytics?.attempts || 0}</span>
          <span className="text-xs text-slate-500 uppercase tracking-wider mb-1">Total</span>
        </div>
      </div>

      <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg p-5 flex flex-col justify-between">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4" /> Fills
          </h2>
        </div>
        <div className="flex items-end justify-between">
          <span className="font-mono text-4xl text-cyan-400">{analytics?.fills || 0}</span>
          <span className="text-xs text-slate-500 uppercase tracking-wider mb-1">Orders</span>
        </div>
      </div>

      <div className="bg-[#0f141d] border border-slate-800/60 rounded-lg p-5 flex flex-col justify-between">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-2">
            <CheckCircle className="w-4 h-4" /> Settled
          </h2>
        </div>
        <div className="flex items-end justify-between">
          <span className="font-mono text-4xl text-slate-200">{analytics?.settled || 0}</span>
          <span className="text-xs text-slate-500 uppercase tracking-wider mb-1">Contracts</span>
        </div>
      </div>

      <div className={`border rounded-lg p-5 flex flex-col justify-between ${pnlBg}`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-xs uppercase tracking-widest font-semibold flex items-center gap-2 ${pnlColor} opacity-80`}>
            <TrendingUp className="w-4 h-4" /> Net PNL
          </h2>
          <span className="text-[10px] text-slate-600 font-mono bg-black/40 px-2 py-1 rounded uppercase tracking-wider">{mode}</span>
        </div>
        <div className="flex items-end justify-between">
          <span className={`font-mono text-4xl font-bold ${pnlColor}`}>
            {pnlNum > 0 ? "+" : ""}{formatDollar(analytics?.pnl)}
          </span>
        </div>
      </div>

    </div>
  );
}
