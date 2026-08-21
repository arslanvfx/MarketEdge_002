import React, { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Pause, Play, Target, Timer, DollarSign, Activity, AlertTriangle, Shield, CheckCircle2, Settings2, RotateCcw } from "lucide-react";
import { API_BASE, fmt$, fmtPct } from "./utils";
import type { ScalperConfig, ScalperStatus, ScalperPerformance } from "./types";

const PER_MARKET_SYMBOLS = ["BTC", "ETH", "XRP", "HYPE", "BNB", "SOL", "DOGE", "NEAR", "ZEC", "GOLD", "SILVER", "WTI"];

interface BotScalperPanelProps {
  activeMode: "paper" | "live";
  authPost: (path: string, body: object) => Promise<unknown>;
}

export function BotScalperPanel({ activeMode, authPost }: BotScalperPanelProps) {
  const qc = useQueryClient();
  const [configDraft, setConfigDraft] = useState<Partial<ScalperConfig>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  
  const { data: configData } = useQuery<{ config: ScalperConfig }>({
    queryKey: ["bot-scalper-config"],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/config`).then(r => r.json()),
  });
  
  const { data: statusData } = useQuery<ScalperStatus>({
    queryKey: ["bot-scalper-status", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/status?mode=${activeMode}`).then(r => r.json()),
    refetchInterval: 5_000,
  });
  
  const { data: perfData } = useQuery<ScalperPerformance>({
    queryKey: ["bot-scalper-perf", activeMode],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/performance?mode=${activeMode}`).then(r => r.json()),
    refetchInterval: 30_000,
  });

  const cfg = configData?.config;
  const merged = useMemo(() => ({ ...(cfg || {}), ...configDraft } as ScalperConfig), [cfg, configDraft]);
  
  const hasDraft = Object.keys(configDraft).length > 0;

  async function saveConfig() {
    if (!hasDraft) return;
    setSaving(true);
    try {
      const data = await authPost("/crypto/scalper/config", configDraft) as { config?: ScalperConfig; ok?: boolean };
      if (data.ok && data.config) {
        qc.setQueryData<{ config: ScalperConfig }>(["bot-scalper-config"], { config: data.config });
        setConfigDraft({});
        setSavedMsg("All settings saved");
        setTimeout(() => setSavedMsg(null), 3000);
        qc.invalidateQueries({ queryKey: ["bot-scalper-status"] });
        qc.invalidateQueries({ queryKey: ["bot-scalper-perf"] });
        qc.invalidateQueries({ queryKey: ["bot-scalper-history"] });
      } else {
        throw new Error("Save failed");
      }
    } catch {
      setSavedMsg("Save failed");
      setTimeout(() => setSavedMsg(null), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function toggleMaster() {
    const next = !(merged.enabled ?? false);
    try {
      const data = await authPost("/crypto/scalper/config", { enabled: next }) as { config?: ScalperConfig; ok?: boolean };
      if (data.ok && data.config) {
        qc.setQueryData<{ config: ScalperConfig }>(["bot-scalper-config"], { config: data.config });
        setConfigDraft(prev => {
          const c = { ...prev };
          delete c.enabled;
          return c;
        });
      }
    } catch {
      // Revert optimism implicitly by failing
    }
  }

  async function toggleMode() {
    const next = merged.mode === "live" ? "paper" : "live";
    try {
      const data = await authPost("/crypto/scalper/config", { mode: next }) as { config?: ScalperConfig; ok?: boolean };
      if (data.ok && data.config) {
        qc.setQueryData<{ config: ScalperConfig }>(["bot-scalper-config"], { config: data.config });
        setConfigDraft(prev => {
          const c = { ...prev };
          delete c.mode;
          return c;
        });
      }
    } catch {
      // Revert optimism implicitly by failing
    }
  }

  async function resetCircuitBreaker() {
    try {
      const data = await authPost("/crypto/scalper/reset-circuit-breaker", {}) as { ok?: boolean; config?: ScalperConfig };
      if (data.ok && data.config) {
        qc.setQueryData<{ config: ScalperConfig }>(["bot-scalper-config"], { config: data.config });
        qc.invalidateQueries({ queryKey: ["bot-scalper-status"] });
      }
    } catch {}
  }

  function handleConfigChange(key: keyof ScalperConfig, value: any) {
    setConfigDraft(prev => ({ ...prev, [key]: value }));
  }

  function handleMarketChange(sym: string, key: keyof ScalperConfig["perMarketOverrides"][number], value: any) {
    setConfigDraft(prev => {
      const pmList = prev.perMarketOverrides || cfg?.perMarketOverrides || [];
      const index = pmList.findIndex(m => m.symbol === sym);
      let newList = [...pmList];
      
      if (index >= 0) {
        newList[index] = { ...newList[index], [key]: value };
      } else {
        newList.push({ symbol: sym, [key]: value });
      }
      
      return { ...prev, perMarketOverrides: newList };
    });
  }

  if (!cfg) return null;

  return (
    <div className="bg-card border-amber-500/30 border rounded-xl overflow-hidden mb-6">
      <div className="px-5 py-4 border-b border-amber-500/30 flex items-center justify-between bg-amber-500/5">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <h2 className="font-bold text-lg text-foreground tracking-tight">High-Value Scalping</h2>
          </div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-amber-500/70 mt-0.5">Late-Window Price Execution</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleMode}
            className={`px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest uppercase transition-colors ${
              merged.mode === "live"
                ? "bg-red-500/20 text-red-400 border border-red-500/30"
                : "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30"
            }`}
          >
            {merged.mode === "live" ? "Live" : "Paper"}
          </button>
          
          <button
            onClick={toggleMaster}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${
              merged.enabled
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                : "bg-muted text-muted-foreground border border-border"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${merged.enabled ? "bg-emerald-400" : "bg-muted-foreground"}`} />
            {merged.enabled ? "Scalper active" : "Scalper inactive"}
          </button>
        </div>
      </div>

      <div className="p-5 text-xs text-muted-foreground/80 leading-relaxed border-b border-border bg-card/40 flex items-center justify-between">
        <span>Same workflow as regular conviction bets — same price feed, same order placement. Fires in the configured final window when the winning-side contract ask lands in the price band. Model signals, quiet hours, and market filters are bypassed.</span>
        
        {/* Status Indicators */}
        {statusData && (
          <div className="flex items-center gap-4 text-[10px] font-mono shrink-0 ml-4">
            <div className="flex flex-col items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Reservations</span>
              <span className="text-foreground">{statusData.totalReservationsToday} today</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Open</span>
              <span className="text-foreground">{fmt$(statusData.openSpend)}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Spent</span>
              <span className="text-foreground">{fmt$(statusData.dailySpend)}</span>
            </div>
          </div>
        )}
      </div>

      {merged.circuitBreaker && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 text-red-400 text-sm font-semibold">
            <AlertTriangle className="w-5 h-5" />
            Circuit Breaker Tripped! Scalper is halted. ({merged.circuitBreakerReason || "Unknown reason"})
          </div>
          <button onClick={resetCircuitBreaker} className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-xs font-semibold transition-colors">
            Reset Circuit Breaker
          </button>
        </div>
      )}

      {statusData?.lastError && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-5 py-2 flex items-center gap-3 text-amber-400/80 text-xs">
          <AlertTriangle className="w-4 h-4" />
          Scanner Error: {statusData.lastError}
        </div>
      )}

      <div className="p-5 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-background/50 border border-border rounded-lg p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Winning Contract Band</div>
                <div className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{Math.round(merged.globalBandMin * 100)}–{Math.round(merged.globalBandMax * 100)}¢</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Minimum</span>
                  <div className="relative">
                    <input type="number" min={1} max={99} value={Math.round(merged.globalBandMin * 100)} onChange={e => handleConfigChange("globalBandMin", (parseInt(e.target.value) || 0) / 100)} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">¢</span>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Maximum</span>
                  <div className="relative">
                    <input type="number" min={1} max={99} value={Math.round(merged.globalBandMax * 100)} onChange={e => handleConfigChange("globalBandMax", (parseInt(e.target.value) || 0) / 100)} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">¢</span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="bg-background/50 border border-border rounded-lg p-4 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest mb-4">Entry Cadence</div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Final minutes</span>
                  <input type="number" min={0} max={14} value={Math.floor(merged.finalWindowSeconds / 60)} onChange={e => handleConfigChange("finalWindowSeconds", (parseInt(e.target.value) || 0) * 60 + (merged.finalWindowSeconds % 60))} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Final seconds</span>
                  <input type="number" min={0} max={59} value={merged.finalWindowSeconds % 60} onChange={e => handleConfigChange("finalWindowSeconds", Math.floor(merged.finalWindowSeconds / 60) * 60 + (parseInt(e.target.value) || 0))} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </label>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] text-muted-foreground">Per order</span>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                  <input type="number" min={1} max={100} value={merged.budgetDollars} onChange={e => handleConfigChange("budgetDollars", parseFloat(e.target.value) || 0)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </div>
              </label>
            </div>
            <div className="text-[9px] text-muted-foreground/60 mt-3 leading-tight">
              Checks every second while this window is active. A final fresh quote is taken immediately before the order.
            </div>
          </div>

          <div className="bg-background/50 border border-border rounded-lg p-4 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest mb-4">Independent Limits</div>
              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-muted-foreground">Open exposure</span>
                    {merged.openCapDollars === null && <span className="text-[9px] font-bold text-muted-foreground/50">NO CAP</span>}
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                    <input type="number" value={merged.openCapDollars || ""} placeholder="No cap" onChange={e => handleConfigChange("openCapDollars", e.target.value ? parseFloat(e.target.value) : null)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-muted-foreground">Daily spend</span>
                    {merged.dailyCapDollars === null && <span className="text-[9px] font-bold text-muted-foreground/50">NO CAP</span>}
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                    <input type="number" value={merged.dailyCapDollars || ""} placeholder="No cap" onChange={e => handleConfigChange("dailyCapDollars", e.target.value ? parseFloat(e.target.value) : null)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                  </div>
                </label>
              </div>
            </div>
            <div className="flex items-center justify-between mt-3">
              <div className="text-[9px] text-muted-foreground/60 leading-tight pr-2">Separate from normal bets. One scalp per market per 15-min window.</div>
              <label className="flex items-center gap-1.5 cursor-pointer shrink-0" title="Freefall Guard">
                <div className={`w-7 h-3.5 rounded-full relative transition-colors ${merged.freefallGuardEnabled ? "bg-amber-500" : "bg-muted"}`} onClick={() => handleConfigChange("freefallGuardEnabled", !merged.freefallGuardEnabled)}>
                  <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${merged.freefallGuardEnabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
                </div>
                <span className="text-[10px] text-muted-foreground/50"><Shield className="w-3 h-3 inline" /> Guard</span>
              </label>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <Settings2 className="w-4 h-4 text-amber-500/70" />
            <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Per-Coin Overrides</h3>
          </div>
          <div className="bg-background/50 border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {PER_MARKET_SYMBOLS.map(sym => {
                  const pm = merged.perMarketOverrides?.find(m => m.symbol === sym) || { symbol: sym };
                  const isPaused = pm.paused ?? false;
                  const statusInfo = statusData?.markets.find(m => m.symbol === sym);
                  
                  return (
                    <tr key={sym} className={`border-b border-border/40 last:border-0 hover:bg-muted/10 transition-colors ${isPaused ? "bg-red-500/5" : ""}`}>
                      <td className="px-4 py-2 font-bold w-20">
                        {sym}
                      </td>
                      <td className="px-2 py-2 w-28">
                        <button
                          onClick={() => handleMarketChange(sym, "paused", !isPaused)}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                            isPaused 
                              ? "bg-red-500/20 text-red-400 border border-red-500/30" 
                              : "text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          <Pause className="w-3 h-3" />
                          {isPaused ? "Paused" : "Pause"}
                        </button>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-3">
                          {/* Min/Max Band */}
                          <div className={`flex items-center gap-1 ${isPaused ? "opacity-50" : ""}`}>
                            <span className="text-[10px] text-muted-foreground">Band</span>
                            <input 
                              type="number" 
                              min={1} max={99}
                              placeholder={Math.round(merged.globalBandMin * 100).toString()} 
                              value={pm.minBand !== undefined && pm.minBand !== null ? Math.round(pm.minBand * 100) : ""} 
                              onChange={e => handleMarketChange(sym, "minBand", e.target.value ? parseFloat(e.target.value) / 100 : null)} 
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50" 
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">–</span>
                            <input 
                              type="number" 
                              min={1} max={99}
                              placeholder={Math.round(merged.globalBandMax * 100).toString()} 
                              value={pm.maxBand !== undefined && pm.maxBand !== null ? Math.round(pm.maxBand * 100) : ""} 
                              onChange={e => handleMarketChange(sym, "maxBand", e.target.value ? parseFloat(e.target.value) / 100 : null)} 
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50" 
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">¢</span>
                          </div>

                          <div className="relative w-20">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-[10px]">$</span>
                            <input 
                              type="number" 
                              placeholder={merged.budgetDollars.toString()} 
                              value={pm.budgetDollars === null ? "" : pm.budgetDollars ?? ""} 
                              onChange={e => handleMarketChange(sym, "budgetDollars", e.target.value ? parseFloat(e.target.value) : null)} 
                              className={`w-full bg-background border rounded pl-5 pr-2 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 ${isPaused ? "border-red-500/30 opacity-50" : "border-border"}`} 
                              disabled={isPaused}
                            />
                          </div>
                          
                          <div className={`flex items-center gap-1 ${isPaused ? "opacity-50" : ""}`}>
                            <span className="text-[10px] text-muted-foreground">window</span>
                            <input 
                              type="number" 
                              min={0} max={14}
                              placeholder={Math.floor(merged.finalWindowSeconds / 60).toString()} 
                              value={pm.windowSeconds !== undefined && pm.windowSeconds !== null ? Math.floor(pm.windowSeconds / 60) : ""} 
                              onChange={e => {
                                const m = e.target.value ? parseInt(e.target.value) : null;
                                if (m === null) handleMarketChange(sym, "windowSeconds", null);
                                else {
                                  const current = pm.windowSeconds ?? merged.finalWindowSeconds;
                                  handleMarketChange(sym, "windowSeconds", m * 60 + (current % 60));
                                }
                              }} 
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50" 
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">m</span>
                            <input 
                              type="number" 
                              min={0} max={59}
                              placeholder={(merged.finalWindowSeconds % 60).toString()} 
                              value={pm.windowSeconds !== undefined && pm.windowSeconds !== null ? (pm.windowSeconds % 60) : ""} 
                              onChange={e => {
                                const s = e.target.value ? parseInt(e.target.value) : null;
                                if (s === null) handleMarketChange(sym, "windowSeconds", null);
                                else {
                                  const current = pm.windowSeconds ?? merged.finalWindowSeconds;
                                  handleMarketChange(sym, "windowSeconds", Math.floor(current / 60) * 60 + s);
                                }
                              }} 
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50" 
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">s</span>
                          </div>

                          {/* Status display */}
                          {statusInfo && !isPaused && (
                            <div className="ml-auto flex items-center gap-2">
                              {statusInfo.freefallBlocked && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300" title="Freefall guard active">
                                  FREEFALL
                                </span>
                              )}
                              <span className="text-[9px] text-muted-foreground/50 w-24 text-right truncate" title={statusInfo.reason || statusInfo.state}>
                                {statusInfo.state === 'active' ? (statusInfo.lastAsk !== null ? `${Math.round(statusInfo.lastAsk * 100)}¢` : "Scanning...") : statusInfo.state}
                              </span>
                            </div>
                          )}

                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[9px] text-muted-foreground/60 mt-2 px-1">
            Pause blocks this coin from scalping. Settings override the global band, per-order budget, and how early the scalper starts. Blank = use global. Save to apply.
          </div>
        </div>

        {/* Action Bar */}
        {hasDraft && (
          <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-border/50">
            <span className="text-xs text-amber-500/70">Unsaved changes</span>
            <button onClick={() => setConfigDraft({})} disabled={saving} className="text-xs text-muted-foreground hover:text-foreground">Discard</button>
            <button onClick={saveConfig} disabled={saving} className="bg-amber-600 hover:bg-amber-500 text-amber-50 px-4 py-1.5 rounded font-bold text-xs transition-colors shadow">
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        )}
        {savedMsg && (
          <div className={`flex items-center justify-end gap-1 mt-2 text-xs font-medium ${savedMsg === 'Save failed' ? 'text-red-400' : 'text-emerald-400'}`}>
            {savedMsg === 'Save failed' ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />} {savedMsg}
          </div>
        )}

        {/* Performance Section */}
        {perfData && (
          <div className="mt-8 border-t border-amber-500/20 pt-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-amber-500/70" />
                <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Performance</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">{perfData.settled} settled</span>
                
                {perfData.mode !== merged.mode && (
                  <span className="text-[10px] ml-2 text-muted-foreground">(Showing {perfData.mode} data while viewing {merged.mode})</span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Win Rate</div>
                <div className="text-xl font-bold text-emerald-400">{perfData.winRate !== null ? `${Math.round(perfData.winRate * 100)}%` : "—"}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">{perfData.wins}W - {perfData.losses}L</div>
              </div>
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Net P&L</div>
                <div className={`text-xl font-bold ${perfData.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {perfData.totalPnl > 0 ? "+" : ""}{fmt$(perfData.totalPnl)}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">{fmt$(perfData.totalSpent)} spent</div>
              </div>
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Settled Bets</div>
                <div className="text-xl font-bold text-foreground">{perfData.settled}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">no pushes</div>
              </div>
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Avg Fill</div>
                <div className={`text-xl font-bold text-amber-400`}>
                  {perfData.avgFillPrice !== null ? `${Math.round(perfData.avgFillPrice * 100)}¢` : "—"}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">winning side</div>
              </div>
            </div>

            {perfData.bySymbol.length > 0 && (
              <div className="bg-background/50 border border-border rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-amber-500/70 border-b border-border/50 bg-amber-500/5">
                      <th className="px-4 py-2 font-bold">Coin</th>
                      <th className="px-4 py-2 font-bold">W / L</th>
                      <th className="px-4 py-2 font-bold">Win %</th>
                      <th className="px-4 py-2 font-bold">Net P&L</th>
                      <th className="px-4 py-2 font-bold">Spent</th>
                      <th className="px-4 py-2 font-bold">Avg fill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perfData.bySymbol.filter(s => s.orders > 0).map(row => (
                      <tr key={row.symbol} className="border-b border-border/40 hover:bg-muted/10 last:border-0">
                        <td className="px-4 py-2 font-bold text-xs">{row.symbol}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{row.wins} / {row.losses}</td>
                        <td className="px-4 py-2 text-xs text-emerald-400 font-medium">{row.winRate !== null ? `${Math.round(row.winRate * 100)}%` : "—"}</td>
                        <td className={`px-4 py-2 text-xs font-bold ${row.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {row.pnl > 0 ? "+" : ""}{fmt$(row.pnl)}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{fmt$(row.spent)}</td>
                        <td className="px-4 py-2 text-xs font-mono">{row.avgFillPrice !== null ? `${Math.round(row.avgFillPrice * 100)}¢` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        
        {/* Status section info line */}
        <div className="mt-4 pt-4 border-t border-border/30 text-right text-[10px] text-muted-foreground">
          Settings are written to the bot configuration and restored when the server restarts.
        </div>
      </div>
    </div>
  );
}
