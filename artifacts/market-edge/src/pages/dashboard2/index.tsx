import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { fetchStatus, fetchDailyPerformance, fetchWhatIfPerformance, fetchPositions, fetchHistory, fetchAudit } from "./api";
import { Loader2, AlertTriangle, ChevronDown, ChevronRight, Zap, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDebounce } from "@/hooks/use-debounce";

import { TopNav } from "./components/nav";
import { KpiCards, HourlyChart, WindowStatusCard, TelemetryCard, WhatIfCalculator } from "./components/overview";
import { CompactLiveTargets, CompactPositions, CompactHistory, CompactAudit } from "./components/dashboard-tables";
import SettingsView from "./components/settings";

import { BotScalperPanel } from "../bot/bot-scalper-panel";
import { BotSmartExitPanel } from "../bot/bot-smart-exit-panel";
import { KalshiLiveTickerPanel } from "../bot/kalshi-live-ticker-panel";
import { API_BASE } from "../bot/utils";
import { readApiResponse } from "../bot/api-response";
import { SharedBotIntelligence } from "../bot/shared-intelligence";

function CollapsiblePanel({ title, icon: Icon, children, defaultOpen = false }: { title: string, icon?: React.ElementType, children: React.ReactNode, defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-card border rounded-xl overflow-hidden shadow-sm transition-all duration-300">
      <button
        onClick={() => setOpen(!open)}
        className="w-full p-4 flex items-center justify-between hover:bg-muted/30 transition-colors focus:outline-none"
      >
        <div className="flex items-center gap-3">
          {Icon && <Icon className="w-5 h-5 text-cyan-400" />}
          <h3 className="text-sm uppercase tracking-widest font-bold text-foreground">{title}</h3>
        </div>
        <div className="text-muted-foreground p-1.5 rounded-md hover:bg-background transition-colors">
          {open ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        </div>
      </button>
      {open && (
        <div className="p-4 md:p-6 border-t border-border/50 bg-background/30">
          {children}
        </div>
      )}
    </div>
  );
}

export default function Dashboard2() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [activeView, setActiveView] = useState<'dashboard' | 'settings'>('dashboard');
  const [actionError, setActionError] = useState<string | null>(null);

  // Authenticated POST for shared Bot 1 modules
  async function postAuthenticated(path: string, body: object, strictErrors: boolean) {
    const token = await getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = strictErrors ? await readApiResponse(res) : await res.json();
    if (path.startsWith("/crypto/bot/")) {
      await qc.invalidateQueries({ queryKey: ["bot-status"] });
      await qc.invalidateQueries({ queryKey: ["dashboard2-status"] });
    }
    return data;
  }

  async function authPost(path: string, body: object) {
    return postAuthenticated(path, body, false);
  }

  async function scalperAuthPost(path: string, body: object) {
    return postAuthenticated(path, body, true);
  }

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
        <Loader2 className="w-6 h-6 animate-spin text-cyan-500" />
        <span className="font-mono text-sm tracking-widest uppercase font-bold text-cyan-500/80">Initializing Command Center...</span>
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
          <Button variant="outline" className="mt-4 border-slate-700 text-slate-300 hover:bg-slate-800 h-10 px-6 text-sm" onClick={() => window.location.reload()}>
            Reconnect System
          </Button>
        </div>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="dashboard2-theme h-[100dvh] bg-background text-foreground flex flex-col overflow-hidden">
      <TopNav
        status={status}
        actionError={actionError}
        setActionError={setActionError}
        activeView={activeView}
        setActiveView={setActiveView}
      />

      <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {activeView === 'settings' ? (
          <SettingsView mode={mode} />
        ) : (
          <div className="p-4 md:p-6 max-w-[1800px] mx-auto space-y-6 pb-24">

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
              {/* MAIN CONTENT AREA - 8 COLS */}
              <div className="order-last xl:order-first xl:col-span-8 flex flex-col gap-6 min-w-0">
                <KpiCards daily={daily} mode={mode} />

                <HourlyChart
                  daily={daily}
                  mode={mode}
                  footer={
                    <WhatIfCalculator
                      data={whatIf}
                      stake={stakeInput}
                      setStake={setStakeInput}
                      isLoading={whatIfLoading}
                      isError={whatIfError}
                      isValid={isValidStake}
                    />
                  }
                />

                <CompactPositions positions={positions} markets={status.markets} />
                <CompactLiveTargets markets={status.markets} />
                <CompactHistory history={history} />
              </div>

              {/* SIDEBAR - 4 COLS */}
              <div className="order-first xl:order-last xl:col-span-4 flex flex-col gap-6 min-w-0">
                <CompactAudit readiness={status.readiness} audit={audit} />
                <TelemetryCard status={status} />
                <WindowStatusCard status={status} />
                <KalshiLiveTickerPanel />
              </div>
            </div>

            {/* COLLAPSIBLE MODULES */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mt-2">
               <CollapsiblePanel title="High-Value Scalping" icon={Zap} defaultOpen={false}>
                 <BotScalperPanel authPost={scalperAuthPost} hideContrarianSpike />
               </CollapsiblePanel>
               <CollapsiblePanel title="Smart Exit & Stop Loss" icon={Skull} defaultOpen={false}>
                 <BotSmartExitPanel authPost={authPost} />
               </CollapsiblePanel>
            </div>

            <SharedBotIntelligence mode={mode} />

          </div>
        )}
      </div>
    </div>
  );
}