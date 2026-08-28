import React from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { startBot, pauseBot, updateMode, updateExecutionOwner } from "../api";
import { Loader2, Play, Pause, Shield, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Dashboard2Status } from "../types";

export function TopNav({
  status,
  actionError,
  setActionError,
  activeView,
  setActiveView
}: {
  status: Dashboard2Status;
  actionError: string | null;
  setActionError: (e: string | null) => void;
  activeView: 'dashboard' | 'settings';
  setActiveView: (v: 'dashboard' | 'settings') => void;
}) {
  const { getToken } = useAuth();
  const qc = useQueryClient();

  const { mutate: doStart, isPending: isStarting } = useMutation({
    mutationFn: async (m: 'paper' | 'live') => startBot(await getToken(), m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboard2-status"] }); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
  });

  const { mutate: doPause, isPending: isPausing } = useMutation({
    mutationFn: async (m: 'paper' | 'live') => pauseBot(await getToken(), m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboard2-status"] }); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
  });

  const { mutate: doMode, isPending: isModeChanging } = useMutation({
    mutationFn: async (m: 'paper' | 'live') => updateMode(await getToken(), m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboard2-status"] }); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
  });

  const { mutate: doOwner, isPending: isOwnerChanging } = useMutation({
    mutationFn: async (o: 'current_bot' | 'dashboard2_bot' | 'paused') => updateExecutionOwner(await getToken(), o),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboard2-status"] }); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
  });

  const isRunning = status.system.running;
  const mode = status.system.selectedMode;
  const isLive = mode === 'live';
  const owner = status.system.executionOwner;

  return (
    <header className="shrink-0 border-b bg-card px-4 md:px-6 py-3 flex flex-col md:flex-row md:items-center justify-between gap-4 sticky top-0 z-50 shadow-sm">
      <div className="flex items-center justify-between w-full md:w-auto shrink-0">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
            MarketEdge <span className="text-[#00ffd0]">Console</span>
          </h1>
          <p className="text-xs text-muted-foreground uppercase tracking-widest mt-0.5 font-bold">High-Stakes Prediction Bot</p>
        </div>

        {/* Mobile View Switcher - Hidden on desktop */}
        <div className="flex md:hidden items-center bg-background rounded-lg p-1 border">
           <button
             onClick={() => setActiveView('dashboard')}
             className={`px-4 py-2 text-sm font-semibold rounded-md transition-all ${
               activeView === 'dashboard' ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
             }`}
           >
             <Terminal className="w-4 h-4" />
           </button>
           <button
             onClick={() => setActiveView('settings')}
             className={`px-4 py-2 text-sm font-semibold rounded-md transition-all ${
               activeView === 'settings' ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
             }`}
           >
             <Settings className="w-4 h-4" />
           </button>
        </div>
      </div>

      <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:items-center">
        {actionError && (
          <div className="flex items-center gap-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-400">
            <span className="truncate max-w-[200px]">{actionError}</span>
            <button onClick={() => setActionError(null)} className="ml-auto hover:text-rose-300 font-sans font-bold">×</button>
          </div>
        )}

        <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-3 md:w-auto md:gap-4">
          {/* View Switcher - Desktop */}
          <div className="hidden md:flex items-center bg-background rounded-lg p-1.5 border shrink-0">
             <button
               onClick={() => setActiveView('dashboard')}
               className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-2 ${
                 activeView === 'dashboard' ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
               }`}
             >
               <Terminal className="w-4 h-4" /> Command
             </button>
             <button
               onClick={() => setActiveView('settings')}
               className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center gap-2 ${
                 activeView === 'settings' ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
               }`}
             >
               <Settings className="w-4 h-4" /> Settings
             </button>
          </div>

          {/* Mode Toggle */}
          <div className="flex items-center bg-background rounded-lg p-1.5 border shrink-0">
            <button
              onClick={() => doMode('paper')}
              disabled={isModeChanging || isRunning}
              className={`px-3 py-1.5 text-xs font-bold tracking-wide uppercase rounded-md transition-all ${
                !isLive ? "bg-slate-800 text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
              } disabled:opacity-50`}
            >
              Paper
            </button>
            <button
              onClick={() => doMode('live')}
              disabled={isModeChanging || isRunning}
              className={`px-3 py-1.5 text-xs font-bold tracking-wide uppercase rounded-md transition-all flex items-center gap-2 ${
                isLive ? "bg-rose-950 text-rose-400 border border-rose-500/20 shadow-sm" : "text-muted-foreground hover:text-foreground"
              } disabled:opacity-50`}
            >
              {isLive && <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse shadow-[0_0_5px_rgba(244,63,94,0.5)]" />}
              Live
            </button>
          </div>

          {/* Live authority is intentionally irrelevant while paper mode is selected. */}
          {isLive ? (
            <div className="flex items-center bg-background rounded-lg p-1.5 border shrink-0">
              <span className="text-[11px] uppercase tracking-widest text-muted-foreground px-2 font-bold flex items-center gap-1.5 opacity-70"><Shield className="w-3.5 h-3.5"/> Live Auth:</span>
              <button
                onClick={() => doOwner('current_bot')}
                disabled={isOwnerChanging}
                className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${
                  owner === 'current_bot' ? "bg-slate-800 text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-50`}
              >
                Bot 1
              </button>
              <button
                onClick={() => doOwner('dashboard2_bot')}
                disabled={isOwnerChanging}
                className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${
                  owner === 'dashboard2_bot' ? "bg-cyan-900/40 text-cyan-400 shadow-sm" : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-50`}
              >
                Dash 2
              </button>
              <button
                onClick={() => doOwner('paused')}
                disabled={isOwnerChanging}
                className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${
                  owner === 'paused' ? "bg-amber-900/40 text-amber-400 shadow-sm" : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-50`}
              >
                Paused
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-2 rounded-lg border border-cyan-500/15 bg-cyan-500/5 px-3 py-2.5 text-[11px] font-bold uppercase tracking-widest text-cyan-300/80">
              <Shield className="h-4 w-4" />
              Paper only · live authority unused
            </div>
          )}

          {/* Master Control */}
          <div className="w-full shrink-0 sm:w-auto">
            {isRunning ? (
              <Button
                onClick={() => doPause(mode)}
                disabled={isPausing}
                className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 hover:text-amber-400 border border-amber-500/20 h-9 px-5 font-mono text-xs uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(245,158,11,0.1)] w-full"
              >
                {isPausing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Pause className="w-4 h-4 mr-2" />}
                Halt
              </Button>
            ) : (
              <Button
                onClick={() => doStart(mode)}
                disabled={isStarting}
                className="bg-[#00ffd0]/10 text-[#00ffd0] hover:bg-[#00ffd0]/20 hover:text-[#00ffd0] border border-[#00ffd0]/20 h-9 px-5 font-mono text-xs uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(0,255,208,0.15)] w-full"
              >
                {isStarting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                Arm
              </Button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}