import { useState, useEffect, useRef, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Pause, Play, Target, Timer, DollarSign, Activity, AlertTriangle, Shield, CheckCircle2, Settings2, RotateCcw } from "lucide-react";
import { API_BASE, fmt$, fmtPct, fmtDateTime, wkToEstRange, ET_LABEL } from "./utils";
import type { ScalperConfig, ScalperStatus, ScalperPerformance, ScalperUnresolvedAttempt } from "./types";
import { describeScalperAttempt } from "./scalper-ledger";

const PER_MARKET_SYMBOLS = ["BTC", "ETH", "XRP", "HYPE", "BNB", "SOL", "DOGE", "NEAR", "ZEC", "GOLD", "SILVER", "WTI"];

interface BotScalperPanelProps {
  authPost: (path: string, body: object) => Promise<unknown>;
}

interface ScalperCapability {
  canManage: boolean;
  reason: "unauthenticated" | "authorized";
  message: string | null;
}

type MutationName =
  | "enable"
  | "breaker"
  | "mode"
  | "save"
  | "reset"
  | "performance-reset";
type Notice = { kind: "success" | "error"; text: string };

function preferNewerPerformance(
  current: ScalperPerformance | undefined,
  incoming: ScalperPerformance,
): ScalperPerformance {
  if (
    current?.mode === incoming.mode
    && current.trackingVersion > incoming.trackingVersion
  ) {
    return current;
  }
  return incoming;
}

export function BotScalperPanel({ authPost }: BotScalperPanelProps) {
  const { getToken, isLoaded: authLoaded, userId } = useAuth();
  const qc = useQueryClient();
  const [configDraft, setConfigDraft] = useState<Partial<ScalperConfig>>({});
  const [mutationBusy, setMutationBusy] = useState<MutationName | null>(null);
  const [reconcileBusyId, setReconcileBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    setConfigDraft({});
    setNotice(null);
  }, [userId]);

  const { data: configData } = useQuery<{ config: ScalperConfig }>({
    queryKey: ["bot-scalper-config"],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/config`).then(r => r.json()),
  });

  const cfg = configData?.config;
  const merged = useMemo(() => ({ ...(cfg || {}), ...configDraft } as ScalperConfig), [cfg, configDraft]);
  const scalperMode = cfg?.mode ?? "paper";

  const {
    data: capability,
    isLoading: capabilityLoading,
    isError: capabilityFailed,
  } = useQuery<ScalperCapability>({
    queryKey: ["bot-scalper-capability", userId ?? "signed-out"],
    queryFn: async () => {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/crypto/scalper/capability`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) {
        throw new Error(`Unable to verify Scalper access (HTTP ${response.status})`);
      }
      return response.json();
    },
    enabled: authLoaded,
    retry: false,
    refetchInterval: 60_000,
  });

  const { data: statusData } = useQuery<ScalperStatus>({
    queryKey: ["bot-scalper-status", scalperMode],
    queryFn: () => fetch(`${API_BASE}/crypto/scalper/status?mode=${scalperMode}`).then(r => r.json()),
    enabled: Boolean(cfg),
    refetchInterval: 2_000,
  });

  const { data: perfData } = useQuery<ScalperPerformance>({
    queryKey: ["bot-scalper-perf", scalperMode],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `${API_BASE}/crypto/scalper/performance?mode=${scalperMode}`,
        { signal },
      );
      if (!response.ok) {
        throw new Error(`Unable to load Scalper performance (HTTP ${response.status})`);
      }
      const incoming = await response.json() as ScalperPerformance;
      const current = qc.getQueryData<ScalperPerformance>([
        "bot-scalper-perf",
        scalperMode,
      ]);
      return preferNewerPerformance(current, incoming);
    },
    enabled: Boolean(cfg),
    refetchInterval: 30_000,
  });

  const hasDraft = Object.keys(configDraft).length > 0;
  const canManage = capability?.canManage === true;

  function showNotice(next: Notice): void {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = setTimeout(
      () => setNotice(null),
      next.kind === "error" ? 8_000 : 4_000,
    );
  }

  function managementAccessMessage(): string {
    if (capabilityFailed) {
      return "Scalper controls are read-only because operator access could not be verified. Refresh and try again.";
    }
    switch (capability?.reason) {
      case "unauthenticated":
        return "Sign in to change Scalper settings.";
      default:
        return capability?.message ?? "Checking whether this account can manage the Scalper.";
    }
  }

  async function applyConfigPatch(
    patch: Partial<ScalperConfig>,
    mutation: MutationName,
    successMessage: string,
    clearAllDrafts = false,
  ): Promise<void> {
    if (!canManage) {
      showNotice({ kind: "error", text: managementAccessMessage() });
      return;
    }
    setMutationBusy(mutation);
    setNotice(null);
    try {
      const data = await authPost("/crypto/scalper/config", patch) as {
        config?: ScalperConfig;
        ok?: boolean;
        error?: string;
      };
      if (!data.ok || !data.config) {
        throw new Error(data.error ?? "The server did not confirm that Scalper settings were saved.");
      }
      qc.setQueryData<{ config: ScalperConfig }>(["bot-scalper-config"], { config: data.config });
      if (clearAllDrafts) {
        setConfigDraft({});
      } else {
        setConfigDraft(previous => {
          const next = { ...previous };
          for (const key of Object.keys(patch) as Array<keyof ScalperConfig>) {
            delete next[key];
          }
          return next;
        });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bot-scalper-config"] }),
        qc.invalidateQueries({ queryKey: ["bot-scalper-status"] }),
        qc.invalidateQueries({ queryKey: ["bot-scalper-perf"] }),
        qc.invalidateQueries({ queryKey: ["bot-scalper-history"] }),
      ]);
      showNotice({ kind: "success", text: successMessage });
    } catch (error) {
      showNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Scalper settings could not be saved.",
      });
    } finally {
      setMutationBusy(null);
    }
  }

  async function saveConfig(): Promise<void> {
    if (!hasDraft) return;
    await applyConfigPatch(configDraft, "save", "All Scalper settings saved", true);
  }

  async function toggleMaster(): Promise<void> {
    const next = !(merged.enabled ?? false);
    await applyConfigPatch(
      { enabled: next },
      "enable",
      next ? "Scalper enabled" : "Scalper disabled",
    );
  }

  async function toggleCircuitBreakerProtection(): Promise<void> {
    const next = !(merged.circuitBreakerEnabled ?? true);
    if (
      !next
      && !window.confirm(
        "Turn off Scalper circuit-breaker protection? Safety events and reasons will still be recorded, but they will no longer pause new Scalper attempts.",
      )
    ) {
      return;
    }
    await applyConfigPatch(
      { circuitBreakerEnabled: next },
      "breaker",
      next ? "Scalper circuit-breaker protection enabled" : "Scalper circuit-breaker protection disabled",
    );
  }

  async function setScalperMode(mode: "paper" | "live"): Promise<void> {
    if (mode === scalperMode) return;
    await applyConfigPatch(
      { mode },
      "mode",
      `Scalper switched to ${mode === "live" ? "Live" : "Paper"} mode`,
    );
  }

  async function resetCircuitBreaker(): Promise<void> {
    if (!canManage) {
      showNotice({ kind: "error", text: managementAccessMessage() });
      return;
    }
    setMutationBusy("reset");
    setNotice(null);
    try {
      const data = await authPost("/crypto/scalper/reset-circuit-breaker", {}) as {
        ok?: boolean;
        config?: ScalperConfig;
        error?: string;
      };
      if (!data.ok || !data.config) {
        throw new Error(data.error ?? "The server did not confirm the circuit-breaker reset.");
      }
      qc.setQueryData<{ config: ScalperConfig }>(["bot-scalper-config"], { config: data.config });
      await qc.invalidateQueries({ queryKey: ["bot-scalper-status"] });
      showNotice({ kind: "success", text: "Scalper circuit breaker reset" });
    } catch (error) {
      showNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Circuit breaker could not be reset.",
      });
    } finally {
      setMutationBusy(null);
    }
  }

  async function resetPerformance(): Promise<void> {
    if (!canManage) {
      showNotice({ kind: "error", text: managementAccessMessage() });
      return;
    }

    const mode = scalperMode;
    const confirmed = window.confirm(
      `Reset displayed ${mode === "paper" ? "Paper" : "Live"} Scalper performance stats?\n\n`
      + "This starts a new reporting window only. It will not cancel trades, delete order history, "
      + "change settings, close positions, or disable safety protections.",
    );
    if (!confirmed) return;

    setMutationBusy("performance-reset");
    setNotice(null);
    try {
      await qc.cancelQueries({
        queryKey: ["bot-scalper-perf", mode],
        exact: true,
      });
      const data = await authPost("/crypto/scalper/reset-performance", { mode }) as {
        ok?: boolean;
        performance?: ScalperPerformance;
        error?: string;
      };
      if (!data.ok || !data.performance) {
        throw new Error(data.error ?? "The server did not confirm the performance reset.");
      }
      qc.setQueryData<ScalperPerformance>(
        ["bot-scalper-perf", mode],
        current => preferNewerPerformance(current, data.performance!),
      );
      await qc.invalidateQueries({ queryKey: ["bot-scalper-perf", mode] });
      showNotice({
        kind: "success",
        text: `${mode === "paper" ? "Paper" : "Live"} performance now tracks from this reset`,
      });
    } catch (error) {
      showNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Performance stats could not be reset.",
      });
    } finally {
      setMutationBusy(null);
    }
  }

  async function reconcileAttempt(attempt: ScalperUnresolvedAttempt): Promise<void> {
    if (!attempt.orderRecordId) return;
    if (!canManage) {
      showNotice({ kind: "error", text: managementAccessMessage() });
      return;
    }
    setReconcileBusyId(attempt.orderRecordId ?? attempt.attemptId);
    setNotice(null);
    try {
      const data = await authPost("/crypto/scalper/reconcile-order", {
        orderRecordId: attempt.orderRecordId,
      }) as {
        ok?: boolean;
        outcome?: string;
        message?: string;
        error?: string;
      };
      if (!data.ok) {
        throw new Error(data.message ?? data.error ?? "Kalshi reconciliation did not complete.");
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bot-scalper-config"] }),
        qc.invalidateQueries({ queryKey: ["bot-scalper-status"] }),
        qc.invalidateQueries({ queryKey: ["bot-scalper-history"] }),
        qc.invalidateQueries({ queryKey: ["bot-scalper-perf"] }),
      ]);
      showNotice({
        kind: "success",
        text: data.message ?? `Reconciled ${attempt.symbol} with Kalshi.`,
      });
    } catch (error) {
      showNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Kalshi reconciliation could not be completed.",
      });
    } finally {
      setReconcileBusyId(null);
    }
  }

  function readableReason(reason: string | null): string {
    if (!reason) return "Awaiting Kalshi reconciliation";
    return reason.replaceAll("_", " ");
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
        <div className="flex items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Scalper mode</span>
            <div className="flex rounded-lg border border-border bg-background/50 p-0.5" role="group" aria-label="Scalper execution mode">
              {(["paper", "live"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScalperMode(mode)}
                  disabled={!canManage || mutationBusy !== null}
                  aria-pressed={scalperMode === mode}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-widest uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    scalperMode === mode
                      ? mode === "live"
                        ? "bg-red-500/25 text-red-300"
                        : "bg-yellow-500/20 text-yellow-300"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            data-testid="switch-scalper-circuit-breaker"
            aria-checked={merged.circuitBreakerEnabled !== false}
            aria-label="Enable or disable Scalper circuit-breaker protection"
            onClick={toggleCircuitBreakerProtection}
            disabled={!canManage || mutationBusy !== null}
            className="flex flex-col items-start gap-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Circuit Breaker</span>
            <span className="flex items-center gap-2">
              <span className={`relative h-5 w-9 rounded-full transition-colors ${merged.circuitBreakerEnabled !== false ? "bg-emerald-500" : "bg-red-500"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${merged.circuitBreakerEnabled !== false ? "translate-x-4.5" : "translate-x-0.5"}`} />
              </span>
              <span className={`text-xs font-bold ${merged.circuitBreakerEnabled !== false ? "text-emerald-400" : "text-red-300"}`}>
                {mutationBusy === "breaker" ? "Saving…" : merged.circuitBreakerEnabled !== false ? "Protected" : "Off"}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(merged.enabled)}
            aria-label="Enable or disable the Scalper"
            onClick={toggleMaster}
            disabled={!canManage || mutationBusy !== null}
            className="flex flex-col items-start gap-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Enable Scalper</span>
            <span className="flex items-center gap-2">
              <span className={`relative h-5 w-9 rounded-full transition-colors ${merged.enabled ? "bg-emerald-500" : "bg-muted"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${merged.enabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
              </span>
              <span className={`text-xs font-bold ${merged.enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                {mutationBusy === "enable" ? "Saving…" : merged.enabled ? "On" : "Off"}
              </span>
            </span>
          </button>
        </div>
      </div>

      <div className={`px-5 py-2.5 border-b text-xs flex items-center gap-2 ${
        canManage
          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
          : "border-amber-500/25 bg-amber-500/10 text-amber-300"
      }`}>
        <Shield className="w-4 h-4 shrink-0" />
        {capabilityLoading
          ? "Checking signed-in access…"
          : canManage
            ? "Signed-in access verified — Scalper controls and saving are enabled."
            : managementAccessMessage()}
      </div>

      {notice && (
        <div className={`px-5 py-2.5 border-b flex items-center gap-2 text-xs font-medium ${
          notice.kind === "error"
            ? "border-red-500/30 bg-red-500/10 text-red-300"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
        }`}>
          {notice.kind === "error"
            ? <AlertTriangle className="w-4 h-4 shrink-0" />
            : <CheckCircle2 className="w-4 h-4 shrink-0" />}
          {notice.text}
        </div>
      )}

      {merged.circuitBreakerEnabled === false && (
        <div
          data-testid="warning-scalper-circuit-breaker-disabled"
          className="px-5 py-3 border-b border-amber-500/30 bg-amber-500/10 text-amber-200 flex items-start gap-2 text-xs"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Circuit-breaker protection is off. The Scalper will keep recording safety events and their reasons, but those events will not pause new attempts.
          </span>
        </div>
      )}

      <div className="p-5 text-xs text-muted-foreground/80 leading-relaxed border-b border-border bg-card/40 flex items-center justify-between">
        <span>An in-band scan is only a preliminary candidate. Preflight warms balance, cap headroom, market identity, and Freefall samples before the execution window. During the window, the Scalper scans four times per second and fetches one authoritative authenticated quote before each IOC submission. Confirmed zero fills can retry up to three total submissions; only confirmed fills appear in Active Positions and Transaction History.</span>
        
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

      {statusData?.preflight && (
        <div
          data-testid="status-scalper-preflight"
          className={`border-b px-5 py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between ${
            statusData.preflight.state === "ready"
              ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-300"
              : statusData.preflight.state === "blocked"
                ? "border-red-500/25 bg-red-500/5 text-red-300"
                : statusData.preflight.state === "warming"
                  ? "border-amber-500/25 bg-amber-500/5 text-amber-300"
                  : "border-border bg-background/30 text-muted-foreground"
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-semibold">
            {statusData.preflight.state === "ready"
              ? <CheckCircle2 className="w-4 h-4 shrink-0" />
              : statusData.preflight.state === "blocked"
                ? <AlertTriangle className="w-4 h-4 shrink-0" />
                : <Activity className="w-4 h-4 shrink-0" />}
            <span>
              Execution preflight: {statusData.preflight.state}
              {statusData.preflight.totalSymbols > 0
                ? ` · ${statusData.preflight.readySymbols}/${statusData.preflight.totalSymbols} markets ready`
                : ""}
            </span>
          </div>
          <div className="text-[10px] font-mono opacity-80">
            {statusData.preflight.reason
              ? statusData.preflight.reason.replaceAll("_", " ")
              : statusData.preflight.state === "idle" && statusData.preflight.startsInSeconds != null
                ? `starts in ${Math.ceil(statusData.preflight.startsInSeconds)}s`
                : statusData.preflight.checkedAt
                  ? `checked ${fmtDateTime(statusData.preflight.checkedAt)}`
                  : `starts ${statusData.executionPolicy.preflightLeadSeconds}s before entry`}
          </div>
          {statusData.preflight.markets.some((market) => !market.ready) && (
            <div className="text-[10px] font-mono opacity-75 sm:text-right">
              {statusData.preflight.markets
                .filter((market) => !market.ready)
                .map((market) => `${market.symbol}: ${market.reason?.replaceAll("_", " ") ?? "not ready"}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {merged.circuitBreaker && (
        <div className={`${merged.circuitBreakerEnabled !== false ? "bg-red-500/10 border-red-500/30" : "bg-amber-500/10 border-amber-500/30"} border-b px-5 py-3 flex flex-col gap-3`}>
          <div className="flex items-center justify-between gap-4">
            <div className={`flex items-start gap-3 ${merged.circuitBreakerEnabled !== false ? "text-red-300" : "text-amber-200"}`}>
              <AlertTriangle className="w-5 h-5" />
              <div>
                <div className="text-sm font-semibold">
                  {merged.circuitBreakerEnabled !== false
                    ? "Circuit breaker triggered — Scalper paused"
                    : "Circuit-breaker event recorded — Scalper still running"}
                </div>
                <div data-testid="text-scalper-circuit-breaker-reason" className="text-xs mt-0.5 opacity-90 font-normal">
                  {statusData?.circuitBreakerMessage
                    ?? "The Scalper recorded a safety event, but no additional details were available."}
                </div>
              </div>
            </div>
            <button
              onClick={resetCircuitBreaker}
              disabled={!canManage || mutationBusy !== null}
              className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutationBusy === "reset" ? "Resetting…" : "Reset Circuit Breaker"}
            </button>
          </div>

          {(() => {
            const unresolved = statusData?.unresolvedAttempts ?? [];
            const groups = new Map<string, ScalperUnresolvedAttempt[]>();
            for (const attempt of unresolved) {
              const current = groups.get(attempt.attemptId) ?? [];
              current.push(attempt);
              groups.set(attempt.attemptId, current);
            }
            const groupedAttempts = [...groups.entries()];
            if (groupedAttempts.length === 0) return null;
            return (
              <div
                data-testid="list-scalper-unresolved-attempts"
                className="border-t border-red-500/20 pt-3 flex flex-col gap-2"
              >
                <div className="text-[10px] uppercase font-bold tracking-widest text-red-300/80">
                  Unresolved live attempts ({groupedAttempts.length})
                </div>
                {groupedAttempts.map(([attemptId, records]) => {
                  const attempt = records[0]!;
                  return (
                    <div
                      key={attemptId}
                      data-testid={`row-scalper-unresolved-${attemptId}`}
                      className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2"
                    >
                      <div className="min-w-0 flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-red-200">
                          <span data-testid={`text-scalper-unresolved-symbol-${attemptId}`}>
                            {attempt.symbol}
                          </span>
                          <span className="text-red-300/60 font-mono font-normal">
                            {wkToEstRange(attempt.windowKey)} {ET_LABEL}
                          </span>
                          <span className="text-red-300/40 font-mono font-normal">
                            · opened {fmtDateTime(attempt.createdAt)}
                          </span>
                        </div>
                        <div className="flex flex-col gap-1">
                          {records.map((record, index) => {
                            const busyKey = record.orderRecordId ?? record.attemptId;
                            return (
                              <div
                                key={record.orderRecordId ?? `${record.attemptId}-${index}`}
                                className="flex items-center justify-between gap-4"
                              >
                                <div
                                  data-testid={`text-scalper-unresolved-reason-${attemptId}-${index}`}
                                  className="text-[11px] text-red-300/80"
                                >
                                  {records.length > 1 ? `Order ${index + 1}: ` : ""}
                                  {readableReason(record.reason)}
                                </div>
                                {record.orderRecordId ? (
                                  <button
                                    type="button"
                                    data-testid={`button-scalper-reconcile-${attemptId}-${index}`}
                                    onClick={() => reconcileAttempt(record)}
                                    disabled={!canManage || reconcileBusyId !== null}
                                    aria-label={`Reconcile ${record.symbol} order ${index + 1} with Kalshi`}
                                    className="shrink-0 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-200 rounded text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {reconcileBusyId === busyKey ? "Reconciling…" : "Reconcile with Kalshi"}
                                  </button>
                                ) : (
                                  <span className="shrink-0 text-[10px] text-red-300/60 italic">
                                    No order to reconcile
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {statusData?.lastError && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-5 py-2 flex items-center gap-3 text-amber-400/80 text-xs">
          <AlertTriangle className="w-4 h-4" />
          Scanner Error: {statusData.lastError}
        </div>
      )}

      <div className="p-5 space-y-6">
        <fieldset
          disabled={!canManage || mutationBusy !== null}
          className={`space-y-6 ${!canManage ? "opacity-65" : ""}`}
        >
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
              Scans every {statusData?.executionPolicy.scanIntervalMs ?? 250}ms. IOC zero fills cool down briefly and retry up to {statusData?.executionPolicy.maxSubmissionsPerWindow ?? 3} total submissions.
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

        <div className="bg-background/50 border border-amber-500/20 rounded-lg p-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-amber-500/10 p-2 text-amber-400">
                <Target className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Target Distance Guard</div>
                <p className="text-[10px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
                  Stay out when the fresh underlying price is within the configured distance of the Kalshi target, regardless of which side is in band.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <label className={`flex items-center gap-2 ${!merged.targetProximityGuardEnabled ? "opacity-50" : ""}`}>
                <span className="text-[10px] text-muted-foreground">Minimum distance</span>
                <div className="relative w-24">
                  <input
                    type="number"
                    min={0.01}
                    max={10}
                    step={0.01}
                    value={merged.targetProximityThresholdPct}
                    onChange={e => handleConfigChange("targetProximityThresholdPct", parseFloat(e.target.value) || 0)}
                    disabled={!merged.targetProximityGuardEnabled}
                    data-testid="input-scalper-target-proximity-threshold"
                    className="w-full bg-background border border-border rounded-md pl-3 pr-7 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:cursor-not-allowed"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">%</span>
                </div>
              </label>
              <button
                type="button"
                role="switch"
                aria-checked={merged.targetProximityGuardEnabled}
                data-testid="switch-scalper-target-proximity"
                onClick={() => handleConfigChange("targetProximityGuardEnabled", !merged.targetProximityGuardEnabled)}
                className={`w-10 h-5 rounded-full relative transition-colors ${merged.targetProximityGuardEnabled ? "bg-amber-500" : "bg-muted"}`}
                title="Toggle Target Distance Guard"
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${merged.targetProximityGuardEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                <span className="sr-only">Target Distance Guard</span>
              </button>
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
                  const statusLabel = statusInfo?.state === "active"
                    ? (statusInfo.lastAsk !== null ? `candidate · ${Math.round(statusInfo.lastAsk * 100)}¢` : "Scanning...")
                    : statusInfo?.state === "guarded"
                      ? `blocked · ${readableReason(statusInfo.reason)}`
                      : statusInfo?.state;
                  
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
                              {statusInfo.targetProximityBlocked && (
                                <span
                                  className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-300"
                                  title={statusInfo.targetDistancePct != null
                                    ? `Target distance ${(statusInfo.targetDistancePct).toFixed(3)}%`
                                    : "Target distance unavailable"}
                                >
                                  TARGET
                                </span>
                              )}
                              <span className="text-[9px] text-muted-foreground/50 w-28 text-right truncate" title={statusInfo.reason || "Preliminary scan only; a fresh authenticated quote is checked before ordering."}>
                                {statusLabel}
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
            <button onClick={() => setConfigDraft({})} disabled={mutationBusy !== null} className="text-xs text-muted-foreground hover:text-foreground">Discard</button>
            <button onClick={saveConfig} disabled={mutationBusy !== null || !canManage} className="bg-amber-600 hover:bg-amber-500 text-amber-50 px-4 py-1.5 rounded font-bold text-xs transition-colors shadow disabled:opacity-50 disabled:cursor-not-allowed">
              {mutationBusy === "save" ? "Saving..." : "Save settings"}
            </button>
          </div>
        )}
        </fieldset>

        {(statusData?.recentAttempts?.length ?? 0) > 0 && (
          <div className="mt-8 border-t border-amber-500/20 pt-6">
            <div className="flex items-center gap-2 mb-3">
              <Target className="w-4 h-4 text-amber-500/70" />
              <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Recent candidate checks</h3>
              <span className="text-[10px] text-muted-foreground">Operational outcomes, not all completed bets</span>
            </div>
            <div className="space-y-2">
              {statusData!.recentAttempts.slice(0, 8).map((attempt) => {
                const isFilled = attempt.status === "filled";
                const isUnsafe = attempt.status === "unknown" || attempt.status === "error";
                const isZeroFill = attempt.status === "zero_fill";
                const executionPricing = attempt.observedWinningAsk != null && attempt.executionWinningLimit != null
                  ? `${(attempt.observedWinningAsk * 100).toFixed(1).replace(/\.0$/, "")}¢ quote → ${(attempt.executionWinningLimit * 100).toFixed(1).replace(/\.0$/, "")}¢ ${attempt.mode === "live" ? "IOC" : "sim"} cap`
                  : null;
                return (
                  <div
                    key={attempt.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-xs"
                  >
                    <span className="font-bold text-foreground w-12">{attempt.symbol}</span>
                    <span className={`font-semibold ${
                      isFilled
                        ? "text-emerald-400"
                        : isUnsafe
                          ? "text-red-400"
                          : isZeroFill
                            ? "text-sky-400"
                            : "text-amber-300"
                    }`}>
                      {describeScalperAttempt(attempt)}
                    </span>
                    {executionPricing && (
                      <span
                        className="text-[10px] text-amber-200/75 font-mono whitespace-nowrap"
                        title={`Latest ${attempt.mode === "live" ? "submitted" : "simulated"} ${attempt.side?.toUpperCase() ?? ""} quote and worst acceptable winning-contract cost`}
                      >
                        {executionPricing}
                      </span>
                    )}
                    {isZeroFill && (
                      <span className="text-[10px] text-muted-foreground">
                        {attempt.retryEligible
                          ? attempt.retryState === "ready"
                            ? `Retry ready · ${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} submissions used`
                            : `Retry in ${Math.max(0.1, (attempt.retryAfterMs ?? 0) / 1_000).toFixed(1)}s · ${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} submissions used`
                          : `${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} submissions used`}
                      </span>
                    )}
                    {!isZeroFill && attempt.retryEligible && (
                      <span className="text-[10px] text-muted-foreground">
                        {attempt.retryState === "ready"
                          ? "Transient no-exposure skip · retry ready"
                          : `Transient no-exposure skip · retries in ${Math.max(0.1, (attempt.retryAfterMs ?? 0) / 1_000).toFixed(1)}s`}
                      </span>
                    )}
                    <span className={`ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded ${
                      attempt.mode === "live"
                        ? "bg-red-500/15 text-red-400"
                        : "bg-yellow-500/15 text-yellow-400"
                    }`}>
                      {attempt.mode.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {fmtDateTime(attempt.attemptedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Performance Section */}
        {perfData && (
          <div className="mt-8 border-t border-amber-500/20 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Activity className="w-4 h-4 text-amber-500/70" />
                  <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Performance</h3>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">{perfData.settled} settled</span>

                  {perfData.mode !== merged.mode && (
                    <span className="text-[10px] ml-2 text-muted-foreground">(Showing {perfData.mode} data while viewing {merged.mode})</span>
                  )}
                </div>
                <div
                  className="mt-1 text-[10px] text-muted-foreground"
                  data-testid="text-scalper-performance-tracking-since"
                >
                  Tracking {perfData.mode === "paper" ? "Paper" : "Live"} entries since {fmtDateTime(perfData.trackingSince)}
                </div>
              </div>
              <button
                type="button"
                data-testid="button-scalper-reset-performance"
                onClick={resetPerformance}
                disabled={!canManage || mutationBusy !== null}
                title={canManage
                  ? `Start a new ${perfData.mode} reporting window without deleting order history`
                  : managementAccessMessage()}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-300 transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className={`h-3 w-3 ${mutationBusy === "performance-reset" ? "animate-spin" : ""}`} />
                {mutationBusy === "performance-reset" ? "Resetting…" : "Reset stats"}
              </button>
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
