import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchStatus, fetchDailyPerformance, fetchWhatIfPerformance, fetchPositions, fetchHistory, fetchAudit } from "./api";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDebounce } from "@/hooks/use-debounce";

import { TopNav } from "./components/nav";
import { CommandOverview, WhatIfCalculator } from "./components/overview";
import { CompactLiveTargets, CompactPositions, CompactHistory, CompactAudit } from "./components/dashboard-tables";
import SettingsView from "./components/settings";

export default function Dashboard2() {
  const { getToken } = useAuth();
  const [activeView, setActiveView] = useState<'dashboard' | 'settings'>('dashboard');
  const [actionError, setActionError] = useState<string | null>(null);

  // What-If State
  const [stakeInput, setStakeInput] = useState<string>("100");
  const debouncedStake = useDebounce(stakeInput, 500);

  // Status Polling (Fast)
  const { data: status, isLoading: statusLoading, isError: statusError, error: statusErrObj } = useQuery({
    queryKey: ["dashboard2-status"],
    queryFn: async () => {
      const token = await getToken();
      return fetchStatus(token);
    },
    refetchInterval: 1000,
    retry: 1,
  });

  const mode = status?.system?.selectedMode || 'paper';

  // Performance Polling (Slow)
  const { data: daily } = useQuery({
    queryKey: ["dashboard2-daily", mode],
    queryFn: async () => fetchDailyPerformance(await getToken(), mode),
    refetchInterval: 10000,
    enabled: !!status,
  });

  const parsedStake = parseFloat(debouncedStake);
  const isValidStake = !isNaN(parsedStake) && parsedStake >= 0.01 && parsedStake <= 10000;

  const { data: whatIf, isLoading: whatIfLoading, isError: whatIfError } = useQuery({
    queryKey: ["dashboard2-whatif", mode, parsedStake],
    queryFn: async () => fetchWhatIfPerformance(await getToken(), mode, parsedStake),
    refetchInterval: 10000,
    enabled: !!status && isValidStake,
  });

  // Table Data Polling
  const { data: positions } = useQuery({
    queryKey: ["dashboard2-positions", mode],
    queryFn: async () => fetchPositions(await getToken(), mode),
    refetchInterval: 2000,
    enabled: !!status && activeView === 'dashboard',
  });

  const { data: history } = useQuery({
    queryKey: ["dashboard2-history", mode],
    queryFn: async () => fetchHistory(await getToken(), mode),
    refetchInterval: 10000,
    enabled: !!status && activeView === 'dashboard',
  });

  const { data: audit } = useQuery({
    queryKey: ["dashboard2-audit"],
    queryFn: async () => fetchAudit(await getToken()),
    refetchInterval: 10000,
    enabled: !!status && activeView === 'dashboard',
  });

  if (statusLoading && !status) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
        <span className="font-mono text-sm tracking-widest uppercase font-bold">Initializing Command Center...</span>
      </div>
    );
  }

  if (statusError && !status) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="bg-rose-950/20 border border-rose-900/50 rounded-xl p-8 max-w-md w-full flex flex-col items-center text-center gap-4 shadow-xl">
          <AlertTriangle className="w-12 h-12 text-rose-500 mb-2" />
          <div>
            <h2 className="text-rose-400 font-bold mb-2 uppercase tracking-widest text-lg">Telemetry Lost</h2>
            <p className="text-muted-foreground text-sm font-mono leading-relaxed">{(statusErrObj as Error).message || "Unable to establish connection to execution engine."}</p>
          </div>
          <Button variant="outline" className="mt-4 border-slate-700 text-slate-300 hover:bg-slate-800" onClick={() => window.location.reload()}>
            Reconnect System
          </Button>
        </div>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="dashboard2-theme h-screen bg-background text-foreground flex flex-col overflow-hidden">
      <TopNav
        status={status}
        actionError={actionError}
        setActionError={setActionError}
        activeView={activeView}
        setActiveView={setActiveView}
      />

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {activeView === 'settings' ? (
          <SettingsView mode={mode} />
        ) : (
          <div className="p-4 md:p-6 max-w-[1600px] mx-auto space-y-6 pb-24">

            <CommandOverview
              status={status}
              daily={daily}
              mode={mode}
            />

            <WhatIfCalculator
              data={whatIf}
              stake={stakeInput}
              setStake={setStakeInput}
              isLoading={whatIfLoading}
              isError={whatIfError}
              isValid={isValidStake}
            />

            {/* Dense Data Tables Area */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mt-2">
               <div className="space-y-6">
                 <CompactLiveTargets markets={status.markets} />
                 <CompactPositions positions={positions} />
               </div>
               <div className="space-y-6">
                 <CompactHistory history={history} />
                 <CompactAudit readiness={status.readiness} audit={audit} />
               </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}