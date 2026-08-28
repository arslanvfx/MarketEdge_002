import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchConfig, updateConfig } from "../api";
import { BotConfig } from "../types";
import { useForm, Controller } from "react-hook-form";
import { Settings, Save, Loader2, AlertTriangle, CheckCircle2, XCircle, DollarSign, ShieldAlert, Zap, Clock, Target } from "lucide-react";
import { Button } from "@/components/ui/button";

const AVAILABLE_SYMBOLS = ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK", "UNI"];

export default function SettingsView({ mode }: { mode: 'paper' | 'live' }) {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: configData, isLoading, isError } = useQuery({
    queryKey: ["dashboard2-config", mode],
    queryFn: async () => fetchConfig(await getToken(), mode),
  });

  const { register, handleSubmit, reset, control, formState: { isDirty, isSubmitting } } = useForm<BotConfig>();

  useEffect(() => {
    if (configData?.config) {
      reset(configData.config);
    }
  }, [configData, reset]);

  const { mutate: save, isPending: isSaving, isSuccess: didSave } = useMutation({
    mutationFn: async (data: Partial<BotConfig>) => updateConfig(await getToken(), mode, data),
    onSuccess: (newConfigData) => {
      qc.setQueryData(["dashboard2-config", mode], newConfigData);
      reset(newConfigData.config);
      setSaveError(null);
    },
    onError: (e: Error) => setSaveError(e.message),
  });

  const onSubmit = (data: BotConfig) => {
    const { enabled, liveActivation, ...rest } = data;

    const coerced: Partial<BotConfig> = {
      ...rest,
      version: Number(data.version) || 2,
      minEntryMinute: Number(data.minEntryMinute),
      sideCostFloor: Number(data.sideCostFloor),
      sideCostCeiling: Number(data.sideCostCeiling),
      maxContracts: Number(data.maxContracts),
      maxDollarBudget: Number(data.maxDollarBudget),
      minAccountBalance: Number(data.minAccountBalance),
      maxTotalExposure: Number(data.maxTotalExposure),
      maxConcurrentPositions: Number(data.maxConcurrentPositions),
      paperStartingBalance: Number(data.paperStartingBalance),
      enabledSymbols: data.enabledSymbols || [],
      stopLoss: {
        enabled: Boolean(data.stopLoss?.enabled),
        floor: Number(data.stopLoss?.floor),
        activationMinute: Number(data.stopLoss?.activationMinute),
      },
      quietHours: {
        enabled: Boolean(data.quietHours?.enabled),
        startUtc: Number(data.quietHours?.startUtc),
        endUtc: Number(data.quietHours?.endUtc),
      },
      proximityGuard: {
        enabled: Boolean(data.proximityGuard?.enabled),
        minPct: Number(data.proximityGuard?.minPct),
      },
      circuitBreaker: {
        enabled: Boolean(data.circuitBreaker?.enabled),
        maxDailyLoss: Number(data.circuitBreaker?.maxDailyLoss),
        maxConsecutiveLosses: Number(data.circuitBreaker?.maxConsecutiveLosses),
      }
    };
    save(coerced);
  };

  if (isLoading && !configData) {
    return (
      <div className="flex h-[400px] items-center justify-center text-muted-foreground gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="font-mono text-sm tracking-widest uppercase">Loading Config...</span>
      </div>
    );
  }

  if (isError && !configData) {
    return (
      <div className="flex h-[400px] items-center justify-center text-rose-500 gap-3">
        <AlertTriangle className="w-5 h-5" />
        <span className="font-mono text-sm tracking-widest uppercase">Failed to load configuration</span>
      </div>
    );
  }

  const allSymbols = Array.from(new Set([...AVAILABLE_SYMBOLS, ...(configData?.config?.enabledSymbols || [])]));

  return (
    <div className="flex flex-col w-full max-w-6xl mx-auto p-4 md:p-6 pb-24">
      <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-6 gap-4">
        <div>
           <h2 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
             System Configuration
             <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${mode === 'live' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-slate-800 text-slate-300 border-slate-700'}`}>
               {mode} mode
             </span>
           </h2>
           <p className="text-xs text-muted-foreground mt-1">Adjust operational parameters and safety limits.</p>
        </div>
        <div className="flex items-center gap-3">
          {saveError && (
            <div className="text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-1 rounded flex items-center gap-1.5 font-mono">
              <AlertTriangle className="w-3 h-3" /> {saveError}
              <button type="button" onClick={() => setSaveError(null)} className="ml-1 hover:text-rose-300"><XCircle className="w-3 h-3" /></button>
            </div>
          )}
          {didSave && !isDirty && !saveError && (
            <span className="text-[10px] text-[#00ffd0] flex items-center gap-1 font-semibold uppercase tracking-wider bg-[#00ffd0]/10 border border-[#00ffd0]/20 px-2 py-1 rounded">
              <CheckCircle2 className="w-3.5 h-3.5" /> Synchronized
            </span>
          )}
          <Button
            onClick={handleSubmit(onSubmit)}
            disabled={!isDirty || isSaving || isSubmitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold h-9 px-6 disabled:opacity-50 transition-all shadow-md"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            Deploy Config
          </Button>
        </div>
      </div>

      <form className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">

        {/* Execution Limits */}
        <div className="bg-card border rounded-xl p-5 shadow-sm space-y-5">
          <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
            <Zap className="w-4 h-4" /> Execution Limits
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Min Entry Minute (T+)</label>
              <div className="relative">
                <input type="number" step="1" {...register("minEntryMinute")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition-all" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">min</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Max Contracts</label>
                <input type="number" step="1" {...register("maxContracts")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition-all" />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Max Concurrent</label>
                <input type="number" step="1" {...register("maxConcurrentPositions")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition-all" />
              </div>
            </div>

            <div className="flex items-center gap-3 bg-background p-3 rounded-lg border border-border/50 opacity-60">
              <input type="checkbox" checked={configData?.config?.liveActivation || false} readOnly className="w-4 h-4 rounded border-border bg-muted text-muted-foreground focus:ring-0 cursor-not-allowed pointer-events-none" />
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold cursor-not-allowed">Live Activation Capability (Read-only)</label>
            </div>
          </div>
        </div>

        {/* Financial Bounds */}
        <div className="bg-card border rounded-xl p-5 shadow-sm space-y-5">
          <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
            <DollarSign className="w-4 h-4" /> Financial Bounds
          </h3>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Cost Floor ($)</label>
                <input type="number" step="0.01" {...register("sideCostFloor")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Cost Ceiling ($)</label>
                <input type="number" step="0.01" {...register("sideCostCeiling")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Max Dollar Budget</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono">$</span>
                <input type="number" step="0.01" {...register("maxDollarBudget")} className="w-full bg-background border border-border rounded-lg pl-7 pr-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Max Total Exposure</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono">$</span>
                <input type="number" step="0.01" {...register("maxTotalExposure")} className="w-full bg-background border border-border rounded-lg pl-7 pr-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/30">
              <div>
                <label className="block text-[10px] text-muted-foreground uppercase tracking-wider mb-1 font-semibold">Min Bal. Reserve</label>
                <input type="number" step="0.01" {...register("minAccountBalance")} className="w-full bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground font-mono outline-none" />
              </div>
              {mode === 'paper' && (
                <div>
                  <label className="block text-[10px] text-muted-foreground uppercase tracking-wider mb-1 font-semibold">Paper Start Bal.</label>
                  <input type="number" step="1" {...register("paperStartingBalance")} className="w-full bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground font-mono outline-none" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Guards & Symbols */}
        <div className="flex flex-col gap-6">
          <div className="bg-card border rounded-xl p-5 shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
              <Target className="w-4 h-4" /> Market Symbols
            </h3>
            <Controller
              control={control}
              name="enabledSymbols"
              render={({ field }) => (
                <div className="flex gap-2 flex-wrap">
                  {allSymbols.map(sym => {
                    const isChecked = field.value?.includes(sym) || false;
                    return (
                      <label key={sym} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold cursor-pointer transition-all ${isChecked ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300 shadow-[0_0_10px_rgba(99,102,241,0.1)]' : 'bg-background border-border text-muted-foreground hover:border-muted-foreground/50'}`}>
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={isChecked}
                          onChange={(e) => {
                            const v = e.target.checked;
                            const current = field.value || [];
                            field.onChange(v ? [...current, sym] : current.filter(s => s !== sym));
                          }}
                        />
                        {sym}
                      </label>
                    );
                  })}
                </div>
              )}
            />
          </div>

          <div className="bg-card border rounded-xl p-5 shadow-sm space-y-4 flex-1">
            <h3 className="text-xs font-bold text-rose-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
              <ShieldAlert className="w-4 h-4" /> Safeguards
            </h3>

            <div className="space-y-3">
              <div className="bg-background rounded-lg border border-border p-3">
                <div className="flex items-center gap-3 mb-2">
                  <input type="checkbox" {...register("circuitBreaker.enabled")} className="w-4 h-4 rounded border-border bg-background text-rose-500 focus:ring-rose-500/30" />
                  <label className="text-[11px] text-foreground uppercase tracking-wider font-bold">Circuit Breaker</label>
                </div>
                <div className="grid grid-cols-2 gap-3 pl-7">
                  <div>
                    <label className="block text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Max Daily Loss ($)</label>
                    <input type="number" step="0.01" {...register("circuitBreaker.maxDailyLoss")} className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground font-mono outline-none" />
                  </div>
                  <div>
                    <label className="block text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Max Consec Losses</label>
                    <input type="number" step="1" {...register("circuitBreaker.maxConsecutiveLosses")} className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground font-mono outline-none" />
                  </div>
                </div>
              </div>

              <div className="bg-background rounded-lg border border-border p-3">
                <div className="flex items-center gap-3 mb-2">
                  <input type="checkbox" {...register("stopLoss.enabled")} className="w-4 h-4 rounded border-border bg-background text-rose-500 focus:ring-rose-500/30" />
                  <label className="text-[11px] text-foreground uppercase tracking-wider font-bold">Stop Loss</label>
                </div>
                <div className="grid grid-cols-2 gap-3 pl-7">
                  <div>
                    <label className="block text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Floor ($)</label>
                    <input type="number" step="0.01" {...register("stopLoss.floor")} className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground font-mono outline-none" />
                  </div>
                  <div>
                    <label className="block text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Act. Minute</label>
                    <input type="number" step="1" {...register("stopLoss.activationMinute")} className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground font-mono outline-none" />
                  </div>
                </div>
              </div>

              <div className="bg-background rounded-lg border border-border p-3">
                <div className="flex items-center gap-3">
                  <input type="checkbox" {...register("quietHours.enabled")} className="w-4 h-4 rounded border-border bg-background text-amber-500 focus:ring-amber-500/30" />
                  <label className="text-[11px] text-foreground uppercase tracking-wider font-bold flex items-center gap-1.5"><Clock className="w-3 h-3 text-amber-400" /> Quiet Hours</label>
                </div>
                <div className="grid grid-cols-2 gap-3 pl-7 mt-2">
                  <div>
                    <label className="block text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Start (UTC)</label>
                    <input type="number" step="1" {...register("quietHours.startUtc")} className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground font-mono outline-none" />
                  </div>
                  <div>
                    <label className="block text-[9px] text-muted-foreground uppercase tracking-wider mb-1">End (UTC)</label>
                    <input type="number" step="1" {...register("quietHours.endUtc")} className="w-full bg-card border border-border rounded px-2 py-1 text-xs text-foreground font-mono outline-none" />
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>

      </form>
    </div>
  );
}