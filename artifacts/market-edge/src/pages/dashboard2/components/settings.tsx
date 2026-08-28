import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchConfig, updateConfig } from "../api";
import { BotConfig } from "../types";
import { useForm, Controller } from "react-hook-form";
import { Settings, Save, Loader2, AlertTriangle, CheckCircle2, XCircle, DollarSign, ShieldAlert, Zap, Clock, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REGULAR_BOT_SYMBOLS } from "../../bot/regular-symbols";
import { SharedRegularControls } from "./shared-regular-controls";

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
    const rest: Partial<BotConfig> = { ...data };
    delete rest.enabled;
    delete rest.liveActivation;
    delete rest.maxContracts;

    const coerced: Partial<BotConfig> = {
      ...rest,
      version: Number(data.version) || 2,
      minEntryMinute: Number(data.minEntryMinute),
      sideCostFloor: Number(data.sideCostFloor),
      sideCostCeiling: Number(data.sideCostCeiling),
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

  const allSymbols = Array.from(new Set([...REGULAR_BOT_SYMBOLS, ...(configData?.config?.enabledSymbols || [])]));

  return (
    <div className="flex flex-col w-full max-w-6xl mx-auto p-4 md:p-6 pb-24">
      <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-6 gap-4">
        <div>
           <h2 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
             System Configuration
             <span className={`px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wider border ${mode === 'live' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-slate-800 text-slate-300 border-slate-700'}`}>
               {mode} mode
             </span>
           </h2>
           <p className="text-sm text-muted-foreground mt-1">Adjust operational parameters and safety limits.</p>
        </div>
        <div className="flex items-center gap-3">
          {saveError && (
            <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded flex items-center gap-2 font-mono">
              <AlertTriangle className="w-4 h-4" /> {saveError}
              <button type="button" onClick={() => setSaveError(null)} className="ml-1 hover:text-rose-300"><XCircle className="w-4 h-4" /></button>
            </div>
          )}
          {didSave && !isDirty && !saveError && (
            <span className="text-[11px] text-[#00ffd0] flex items-center gap-1.5 font-bold uppercase tracking-wider bg-[#00ffd0]/10 border border-[#00ffd0]/20 px-3 py-1.5 rounded">
              <CheckCircle2 className="w-4 h-4" /> Synchronized
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

      <form className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">

        {/* Execution Limits */}
        <div className="bg-card border rounded-xl p-5 shadow-sm space-y-5">
          <h3 className="text-sm font-bold text-cyan-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
            <Zap className="w-4 h-4" /> Execution Limits
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Min Entry Minute (T+)</label>
              <div className="relative">
                <input type="number" step="1" {...register("minEntryMinute")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition-all" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">min</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Dollars per bet</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">$</span>
                  <input type="number" step="0.01" {...register("maxDollarBudget")} className="w-full bg-background border border-border rounded-lg pl-7 pr-3 py-2 text-sm text-foreground font-mono focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition-all" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Open positions</label>
                <input type="number" step="1" {...register("maxConcurrentPositions")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition-all" />
              </div>
            </div>

            <div className="flex items-center gap-3 bg-background p-3 rounded-lg border border-border/50 opacity-60">
              <input type="checkbox" checked={configData?.config?.liveActivation || false} readOnly className="w-4 h-4 rounded border-border bg-muted text-muted-foreground focus:ring-0 cursor-not-allowed pointer-events-none" />
              <label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold cursor-not-allowed">Live Activation (Read-only)</label>
            </div>
          </div>
        </div>

        {/* Financial Bounds */}
        <div className="bg-card border rounded-xl p-5 shadow-sm space-y-5">
          <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
            <DollarSign className="w-4 h-4" /> Financial Bounds
          </h3>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Cost Floor ($)</label>
                <input type="number" step="0.01" {...register("sideCostFloor")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Cost Ceiling ($)</label>
                <input type="number" step="0.01" {...register("sideCostCeiling")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-semibold">Max Total Exposure</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">$</span>
                <input type="number" step="0.01" {...register("maxTotalExposure")} className="w-full bg-background border border-border rounded-lg pl-7 pr-3 py-2 text-sm text-foreground font-mono focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none transition-all" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/30">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1 font-semibold">Min Bal. Reserve</label>
                <input type="number" step="0.01" {...register("minAccountBalance")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none" />
              </div>
              {mode === 'paper' && (
                <div>
                  <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1 font-semibold">Paper Start Bal.</label>
                  <input type="number" step="1" {...register("paperStartingBalance")} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Guards & Symbols */}
        <div className="flex flex-col gap-6">
          <div className="relative overflow-hidden bg-card border border-indigo-500/20 rounded-xl p-5 shadow-[0_12px_36px_rgba(15,23,42,0.24)] space-y-4">
            <div className="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-indigo-500/10 blur-3xl" />
            <div className="relative flex items-start justify-between gap-4 pb-4 border-b border-border/50">
              <div>
                <h3 className="text-sm font-bold text-indigo-300 uppercase tracking-widest flex items-center gap-2">
                  <Target className="w-4 h-4" /> Markets Bot 2 Can Trade
                </h3>
                <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
                  Select where Bot 2 may open new regular positions. Turning a market off will not close a position already open.
                </p>
              </div>
            </div>
            <Controller
              control={control}
              name="enabledSymbols"
              render={({ field }) => {
                const enabledCount = field.value?.length || 0;
                return (
                  <div className="relative space-y-4">
                    <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.16em]">
                      <span className="text-muted-foreground">Trading universe</span>
                      <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">
                        {enabledCount} of {allSymbols.length} enabled
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {allSymbols.map(sym => {
                        const isChecked = field.value?.includes(sym) || false;
                        const isLastEnabled = isChecked && enabledCount === 1;
                        return (
                          <label
                            key={sym}
                            title={isLastEnabled ? "At least one market must remain enabled" : `${isChecked ? "Disable" : "Enable"} ${sym} for new Bot 2 entries`}
                            className={`group flex min-h-12 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-mono font-bold transition-all ${
                              isChecked
                                ? 'cursor-pointer border-indigo-400/45 bg-gradient-to-br from-indigo-500/20 to-cyan-500/10 text-indigo-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_18px_rgba(99,102,241,0.08)] hover:border-indigo-300/65'
                                : 'cursor-pointer border-border bg-background/65 text-muted-foreground hover:border-indigo-500/30 hover:text-foreground'
                            } ${isLastEnabled ? 'cursor-not-allowed opacity-80' : ''}`}
                          >
                            <input
                              type="checkbox"
                              className="hidden"
                              checked={isChecked}
                              disabled={isLastEnabled}
                              onChange={(e) => {
                                const v = e.target.checked;
                                const current = field.value || [];
                                field.onChange(v ? [...current, sym] : current.filter(s => s !== sym));
                              }}
                            />
                            <span>{sym}</span>
                            <span className={`flex items-center gap-1.5 text-[10px] tracking-wider ${isChecked ? 'text-emerald-300' : 'text-muted-foreground/60'}`}>
                              <span className={`h-2 w-2 rounded-full ${isChecked ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-muted-foreground/30'}`} />
                              {isChecked ? 'ON' : 'OFF'}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70">
                      Applies only to Bot 2 regular entries. Shared Scalper, Smart Exit, and Bot 1 controls are unaffected.
                    </p>
                  </div>
                );
              }}
            />
          </div>

          <div className="bg-card border rounded-xl p-5 shadow-sm space-y-4 flex-1">
            <h3 className="text-sm font-bold text-rose-400 uppercase tracking-widest flex items-center gap-2 pb-2 border-b border-border/50">
              <ShieldAlert className="w-4 h-4" /> Safeguards
            </h3>

            <div className="space-y-4">
              <div className="bg-background rounded-lg border border-border p-4">
                <div className="flex items-center gap-3 mb-3">
                  <input type="checkbox" {...register("circuitBreaker.enabled")} className="w-4 h-4 rounded border-border bg-background text-rose-500 focus:ring-rose-500/30" />
                  <label className="text-xs text-foreground uppercase tracking-wider font-bold">Circuit Breaker</label>
                </div>
                <div className="grid grid-cols-2 gap-4 pl-7">
                  <div>
                    <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Max Daily Loss ($)</label>
                    <input type="number" step="0.01" {...register("circuitBreaker.maxDailyLoss")} className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground font-mono outline-none" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Max Consec Losses</label>
                    <input type="number" step="1" {...register("circuitBreaker.maxConsecutiveLosses")} className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground font-mono outline-none" />
                  </div>
                </div>
              </div>

              <div className="bg-background rounded-lg border border-border p-4">
                <div className="flex items-center gap-3 mb-3">
                  <input type="checkbox" {...register("stopLoss.enabled")} className="w-4 h-4 rounded border-border bg-background text-rose-500 focus:ring-rose-500/30" />
                  <label className="text-xs text-foreground uppercase tracking-wider font-bold">Stop Loss</label>
                </div>
                <div className="grid grid-cols-2 gap-4 pl-7">
                  <div>
                    <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Floor ($)</label>
                    <input type="number" step="0.01" {...register("stopLoss.floor")} className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground font-mono outline-none" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Act. Minute</label>
                    <input type="number" step="1" {...register("stopLoss.activationMinute")} className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground font-mono outline-none" />
                  </div>
                </div>
              </div>

              <div className="bg-background rounded-lg border border-border p-4">
                <div className="flex items-center gap-3">
                  <input type="checkbox" {...register("quietHours.enabled")} className="w-4 h-4 rounded border-border bg-background text-amber-500 focus:ring-amber-500/30" />
                  <label className="text-xs text-foreground uppercase tracking-wider font-bold flex items-center gap-2"><Clock className="w-4 h-4 text-amber-400" /> Quiet Hours</label>
                </div>
                <div className="grid grid-cols-2 gap-4 pl-7 mt-3">
                  <div>
                    <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Start (UTC)</label>
                    <input type="number" step="1" {...register("quietHours.startUtc")} className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground font-mono outline-none" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">End (UTC)</label>
                    <input type="number" step="1" {...register("quietHours.endUtc")} className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-foreground font-mono outline-none" />
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>

      </form>
      <div className="mt-8 min-w-0">
        <SharedRegularControls />
      </div>
    </div>
  );
}