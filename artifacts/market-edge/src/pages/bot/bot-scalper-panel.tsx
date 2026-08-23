import { useState, useEffect, useRef, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Pause, Play, Target, Timer, DollarSign, Activity, AlertTriangle, Shield, CheckCircle2, Settings2, RotateCcw } from "lucide-react";
import { API_BASE, fmt$, fmtPct, fmtDateTime, wkToEstRange, ET_LABEL } from "./utils";
import type {
  ScalperConfig,
  ScalperStatus,
  ScalperPerformance,
  ScalperUnresolvedAttempt,
  ScalperShadowStudyReport,
  ScalperWindowFunnelReport,
} from "./types";
import {
  describeScalperAttempt,
  describeScalperEvidence,
  describeScalperReason,
  getScalperGuardBlock,
} from "./scalper-ledger";

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

function formatScalperLatency(value: number | null): string {
  if (value == null) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function formatShadowVariant(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secondsPart = seconds - minutes * 60;
  const secondsText = Number.isInteger(secondsPart)
    ? String(secondsPart)
    : secondsPart.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${minutes}:${secondsText.padStart(2, "0")}`;
}

const SHADOW_RESET_STORAGE_PREFIX = "marketedge:scalper-shadow-view-since";

function readShadowViewSince(mode: "paper" | "live"): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(
      `${SHADOW_RESET_STORAGE_PREFIX}:${mode}`,
    );
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

function saveShadowViewSince(mode: "paper" | "live", value: string): void {
  try {
    window.localStorage.setItem(
      `${SHADOW_RESET_STORAGE_PREFIX}:${mode}`,
      value,
    );
  } catch {
    // The reset still applies for this session when browser storage is blocked.
  }
}

export function BotScalperPanel({ authPost }: BotScalperPanelProps) {
  const { getToken, isLoaded: authLoaded, userId } = useAuth();
  const qc = useQueryClient();
  const [configDraft, setConfigDraft] = useState<Partial<ScalperConfig>>({});
  const [mutationBusy, setMutationBusy] = useState<MutationName | null>(null);
  const [reconcileBusyId, setReconcileBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [attemptPage, setAttemptPage] = useState(0);
  const [shadowViewSinceByMode, setShadowViewSinceByMode] = useState<{
    paper: string | null;
    live: string | null;
  }>(() => ({
    paper: readShadowViewSince("paper"),
    live: readShadowViewSince("live"),
  }));
  const ATTEMPT_PAGE_SIZE = 8;
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
  const shadowViewSince = shadowViewSinceByMode[scalperMode];

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

  const { data: funnelData } = useQuery<ScalperWindowFunnelReport>({
    queryKey: ["bot-scalper-funnel", scalperMode],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `${API_BASE}/crypto/scalper/funnel?mode=${scalperMode}&windows=12`,
        { signal },
      );
      if (!response.ok) {
        throw new Error(`Unable to load Scalper funnel (HTTP ${response.status})`);
      }
      return response.json();
    },
    enabled: Boolean(cfg),
    refetchInterval: 10_000,
  });

  const { data: shadowStudyData } = useQuery<ScalperShadowStudyReport>({
    queryKey: ["bot-scalper-shadow-study", scalperMode, shadowViewSince],
    queryFn: async ({ signal }) => {
      const since = shadowViewSince
        ? `&since=${encodeURIComponent(shadowViewSince)}`
        : "";
      const response = await fetch(
        `${API_BASE}/crypto/scalper/shadow-study?mode=${scalperMode}&limit=720${since}`,
        { signal },
      );
      if (!response.ok) {
        throw new Error(`Unable to load shadow study (HTTP ${response.status})`);
      }
      return response.json();
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
        qc.invalidateQueries({ queryKey: ["bot-scalper-shadow-study"] }),
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

  function resetShadowStudyView(): void {
    const resetAt = new Date().toISOString();
    saveShadowViewSince(scalperMode, resetAt);
    setShadowViewSinceByMode((current) => ({
      ...current,
      [scalperMode]: resetAt,
    }));
    showNotice({
      kind: "success",
      text: "Shadow Study view reset. Stored shadow and real bet history were not deleted.",
    });
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
    return describeScalperReason(reason);
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
    <div className="min-w-0 bg-card border-amber-500/30 border rounded-xl overflow-hidden mb-6">
      <div className="px-3 sm:px-5 py-4 border-b border-amber-500/30 flex flex-col items-stretch gap-4 bg-amber-500/5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex flex-col">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <h2 className="font-bold text-lg text-foreground tracking-tight">High-Value Scalping</h2>
          </div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-amber-500/70 mt-0.5">Late-Window Price Execution</span>
        </div>
        <div className="grid w-full grid-cols-3 items-end gap-2 sm:w-auto sm:flex sm:flex-wrap sm:gap-x-4 sm:gap-y-2 sm:justify-end">
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
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${merged.circuitBreakerEnabled !== false ? "bg-emerald-500" : "bg-red-500"}`}>
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.circuitBreakerEnabled !== false ? "translate-x-5" : "translate-x-0"}`} />
              </span>
              <span className={`text-xs font-bold whitespace-nowrap ${merged.circuitBreakerEnabled !== false ? "text-emerald-400" : "text-red-300"}`}>
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
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${merged.enabled ? "bg-emerald-500" : "bg-muted"}`}>
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.enabled ? "translate-x-5" : "translate-x-0"}`} />
              </span>
              <span className={`text-xs font-bold whitespace-nowrap ${merged.enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                {mutationBusy === "enable" ? "Saving…" : merged.enabled ? "On" : "Off"}
              </span>
            </span>
          </button>
        </div>
      </div>

      <div className={`px-3 sm:px-5 py-2.5 border-b text-xs leading-relaxed flex items-start gap-2 ${
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
        <div className={`px-3 sm:px-5 py-2.5 border-b flex items-start gap-2 text-xs font-medium ${
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
          className="px-3 sm:px-5 py-3 border-b border-amber-500/30 bg-amber-500/10 text-amber-200 flex items-start gap-2 text-xs"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Circuit-breaker protection is off. The Scalper will keep recording safety events and their reasons, but those events will not pause new attempts.
          </span>
        </div>
      )}

      <div className="p-3 sm:p-5 text-xs text-muted-foreground/80 leading-relaxed border-b border-border bg-card/40 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 break-words">An in-band scan is only a preliminary candidate. Preflight warms balance, cap headroom, market identity, and Freefall samples before the execution window. During the window, the Scalper scans four times per second and fetches one authoritative authenticated quote before each IOC submission. Confirmed zero fills can retry up to three total submissions; only confirmed fills appear in Active Positions and Transaction History.</span>
        
        {/* Status Indicators */}
        {statusData && (
          <div className="grid w-full grid-cols-3 gap-2 text-[10px] font-mono sm:w-auto sm:shrink-0 sm:ml-4 sm:flex sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-col items-start sm:items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Reservations</span>
              <span className="text-foreground">{statusData.totalReservationsToday} today</span>
            </div>
            <div className="flex min-w-0 flex-col items-start sm:items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Open / Cap</span>
              <span data-testid="text-scalper-open-cap" className="whitespace-nowrap text-foreground">
                {fmt$(statusData.openSpend)} / {fmt$(statusData.config.openCapDollars)}
              </span>
            </div>
            <div className="flex min-w-0 flex-col items-start sm:items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Spent</span>
              <span className="text-foreground">{fmt$(statusData.dailySpend)}</span>
            </div>
          </div>
        )}
      </div>

      {statusData?.preflight && (
        <div
          data-testid="status-scalper-preflight"
          className={`border-b px-3 sm:px-5 py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between ${
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
              {statusData.preflight.state === "ready"
                ? "Non-submitting warm-up complete"
                : statusData.preflight.state === "warming"
                  ? "Non-submitting warm-up in progress"
                  : statusData.preflight.state === "blocked"
                    ? "Warm-up blocked — no order submitted"
                    : "Waiting to start non-submitting warm-up"}
              {statusData.preflight.totalSymbols > 0
                ? ` · ${statusData.preflight.readySymbols}/${statusData.preflight.totalSymbols} markets ready`
                : ""}
            </span>
          </div>
          <div className="text-[10px] font-mono opacity-80">
            {statusData.preflight.reason
              ? readableReason(statusData.preflight.reason)
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
                .map((market) => `${market.symbol}: ${market.reason ? readableReason(market.reason) : "Not ready yet"}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {statusData?.latency && statusData.latency.sampleSize > 0 && (
        <div
          data-testid="status-scalper-fast-path-latency"
          className="border-b border-amber-500/15 bg-amber-500/[0.03] px-3 sm:px-5 py-2 text-[10px] font-mono text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span className="uppercase tracking-widest text-amber-500/70 font-bold">Fast path</span>
          <span>p50 {formatScalperLatency(statusData.latency.p50Ms)}</span>
          <span>p90 {formatScalperLatency(statusData.latency.p90Ms)}</span>
          <span>p99 {formatScalperLatency(statusData.latency.p99Ms)}</span>
          <span className="sm:ml-auto">{statusData.latency.sampleSize} measured attempt{statusData.latency.sampleSize === 1 ? "" : "s"}</span>
        </div>
      )}

      {merged.circuitBreaker && (
        <div className={`${merged.circuitBreakerEnabled !== false ? "bg-red-500/10 border-red-500/30" : "bg-amber-500/10 border-amber-500/30"} border-b px-5 py-3 flex flex-col gap-3`}>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className={`flex items-start gap-3 ${merged.circuitBreakerEnabled !== false ? "text-red-300" : "text-amber-200"}`}>
              <AlertTriangle className="w-5 h-5" />
              <div className="min-w-0">
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
             className="w-full px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto sm:py-1.5"
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

      <div className="p-3 sm:p-5 space-y-4 sm:space-y-6">
        <fieldset
          disabled={!canManage || mutationBusy !== null}
          className={`min-w-0 space-y-4 sm:space-y-6 ${!canManage ? "opacity-65" : ""}`}
        >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="min-w-0 bg-background/50 border border-border rounded-lg p-3 sm:p-4 flex flex-col justify-between">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3 sm:mb-4">
                <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Winning Contract Band</div>
                <div className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{Math.round(merged.globalBandMin * 100)}–{Math.round(merged.globalBandMax * 100)}¢</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Minimum</span>
                  <div className="relative">
                    <input type="number" min={1} max={99} value={Math.round(merged.globalBandMin * 100)} onChange={e => handleConfigChange("globalBandMin", (parseInt(e.target.value) || 0) / 100)} className="w-full min-w-0 bg-background border border-border rounded-md px-3 py-2 sm:py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">¢</span>
                  </div>
                </label>
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Maximum</span>
                  <div className="relative">
                    <input type="number" min={1} max={99} value={Math.round(merged.globalBandMax * 100)} onChange={e => handleConfigChange("globalBandMax", (parseInt(e.target.value) || 0) / 100)} className="w-full min-w-0 bg-background border border-border rounded-md px-3 py-2 sm:py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">¢</span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="min-w-0 bg-background/50 border border-border rounded-lg p-3 sm:p-4 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest mb-4">Entry Cadence</div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Final minutes</span>
                  <input type="number" min={0} max={14} value={Math.floor(merged.finalWindowSeconds / 60)} onChange={e => handleConfigChange("finalWindowSeconds", (parseInt(e.target.value) || 0) * 60 + (merged.finalWindowSeconds % 60))} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </label>
                <label className="min-w-0 flex flex-col gap-1.5">
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

          <div className="min-w-0 bg-background/50 border border-border rounded-lg p-3 sm:p-4 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest mb-4">Independent Limits</div>
              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-muted-foreground">Open exposure cap</span>
                    <span className="text-[9px] font-bold text-amber-400/80">REQUIRED</span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                    <input data-testid="input-scalper-open-cap" type="number" min={0.01} step={0.01} value={merged.openCapDollars} onChange={e => handleConfigChange("openCapDollars", parseFloat(e.target.value) || 0)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                  </div>
                  <span className="text-[9px] text-muted-foreground/60 leading-tight">Your chosen limit for unsettled fills and in-flight reservations across every Scalper market.</span>
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
            <div className="text-[9px] text-muted-foreground/60 mt-3 leading-tight">
              Separate from normal bets. One scalp per market per 15-min window.
            </div>
          </div>
        </div>

        <div className="bg-background/50 border border-amber-500/20 rounded-lg p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex items-start gap-3">
                <div className="rounded-md bg-amber-500/10 p-2 text-amber-400">
                  <Activity className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Real-Time Direction Guard</div>
                  <p className="break-words text-[10px] text-muted-foreground mt-1 max-w-2xl leading-relaxed">
                    Reads one fresh underlying price every second after eligibility opens. Below/NO is blocked after consecutive rises toward the target; Above/YES is blocked after consecutive falls toward it. The separate confirmation below also checks the net move across the complete window.
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={merged.freefallGuardEnabled}
                data-testid="switch-scalper-direction-guard"
                onClick={() => handleConfigChange("freefallGuardEnabled", !merged.freefallGuardEnabled)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${merged.freefallGuardEnabled ? "bg-amber-500" : "bg-muted"}`}
                title="Toggle real-time direction guard"
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.freefallGuardEnabled ? "translate-x-5" : "translate-x-0"}`} />
                <span className="sr-only">Real-Time Direction Guard</span>
              </button>
            </div>

            <div className={`grid grid-cols-1 gap-3 sm:grid-cols-3 ${!merged.freefallGuardEnabled ? "opacity-50" : ""}`}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] text-muted-foreground">Consecutive wrong-way seconds</span>
                <div className="relative">
                  <input
                    type="number"
                    min={1}
                    max={15}
                    step={1}
                    value={merged.freefallConsecutiveSeconds}
                    onChange={e => handleConfigChange("freefallConsecutiveSeconds", parseInt(e.target.value) || 1)}
                    disabled={!merged.freefallGuardEnabled}
                    data-testid="input-scalper-consecutive-seconds"
                    className="w-full bg-background border border-border rounded-md pl-3 pr-9 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:cursor-not-allowed"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">sec</span>
                </div>
              </label>
              <div className="sm:col-span-2 rounded-md border border-border/70 bg-background/60 px-3 py-2">
                <div className="text-[10px] font-semibold text-foreground">Live sample rule</div>
                <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                  A {merged.freefallConsecutiveSeconds}-second setting requires {merged.freefallConsecutiveSeconds + 1} fresh prices spanning {merged.freefallConsecutiveSeconds} real seconds. The Scalper stays in warming mode until the complete sequence exists.
                </p>
              </div>
            </div>

            <div className="border-t border-border/60 pt-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Favorable-Trend Confirmation</div>
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground/70">
                    Requires the full sample window to finish higher for Above/YES or lower for Below/NO, while remaining on the winning side of the target. Flat or net wrong-way movement blocks entry.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={merged.favorableTrendConfirmationEnabled}
                  data-testid="switch-scalper-favorable-trend"
                  disabled={!merged.freefallGuardEnabled}
                  onClick={() => handleConfigChange(
                    "favorableTrendConfirmationEnabled",
                    !merged.favorableTrendConfirmationEnabled,
                  )}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${merged.favorableTrendConfirmationEnabled ? "bg-amber-500" : "bg-muted"}`}
                  title="Toggle full-window favorable-trend confirmation"
                >
                  <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.favorableTrendConfirmationEnabled ? "translate-x-5" : "translate-x-0"}`} />
                  <span className="sr-only">Favorable-Trend Confirmation</span>
                </button>
              </div>
            </div>

            <div className="border-t border-border/60 pt-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Coordinated Guard Clearance</div>
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground/70">
                    Optionally clears only a weak full-window trend rejection when its current pace projects to remain beyond the target-distance buffer through close. Mirrors both sides: a rise toward the target for Below/NO and a fall toward it for Above/YES. Strict streaks, fast moves, stale data, and target-side failures always block.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={merged.coordinatedDirectionClearanceEnabled}
                  data-testid="switch-scalper-coordinated-clearance"
                  disabled={
                    !merged.freefallGuardEnabled
                    || !merged.favorableTrendConfirmationEnabled
                  }
                  onClick={() => handleConfigChange(
                    "coordinatedDirectionClearanceEnabled",
                    !merged.coordinatedDirectionClearanceEnabled,
                  )}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${merged.coordinatedDirectionClearanceEnabled ? "bg-amber-500" : "bg-muted"}`}
                  title="Toggle coordinated direction clearance"
                >
                  <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.coordinatedDirectionClearanceEnabled ? "translate-x-5" : "translate-x-0"}`} />
                  <span className="sr-only">Coordinated Guard Clearance</span>
                </button>
              </div>
              {merged.coordinatedDirectionClearanceEnabled && !merged.targetProximityGuardEnabled && (
                <p className="mt-2 text-[9px] leading-relaxed text-amber-300/80">
                  Clearance remains fail-closed until the Target Distance Guard is enabled.
                </p>
              )}
            </div>

            <div className="border-t border-border/60 pt-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Optional Fast-Move Avoidance</div>
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground/70">
                    Independently blocks an unusually fast rise or fall. Turn this off without changing the directional protection above.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={merged.rapidMoveGuardEnabled}
                  data-testid="switch-scalper-rapid-move"
                  onClick={() => handleConfigChange("rapidMoveGuardEnabled", !merged.rapidMoveGuardEnabled)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${merged.rapidMoveGuardEnabled ? "bg-amber-500" : "bg-muted"}`}
                  title="Toggle fast-move avoidance"
                >
                  <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.rapidMoveGuardEnabled ? "translate-x-5" : "translate-x-0"}`} />
                  <span className="sr-only">Fast-Move Avoidance</span>
                </button>
              </div>
              <div className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 ${!merged.rapidMoveGuardEnabled ? "opacity-50" : ""}`}>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Observation seconds</span>
                  <input
                    type="number"
                    min={1}
                    max={15}
                    step={1}
                    value={merged.rapidMoveLookbackSeconds}
                    onChange={e => handleConfigChange("rapidMoveLookbackSeconds", parseInt(e.target.value) || 1)}
                    disabled={!merged.rapidMoveGuardEnabled}
                    data-testid="input-scalper-rapid-seconds"
                    className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:cursor-not-allowed"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Block at absolute move</span>
                  <div className="relative">
                    <input
                      type="number"
                      min={0.01}
                      max={10}
                      step={0.01}
                      value={merged.rapidMoveThresholdPct}
                      onChange={e => handleConfigChange("rapidMoveThresholdPct", parseFloat(e.target.value) || 0.01)}
                      disabled={!merged.rapidMoveGuardEnabled}
                      data-testid="input-scalper-rapid-threshold"
                      className="w-full bg-background border border-border rounded-md pl-3 pr-7 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:cursor-not-allowed"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">%</span>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-background/50 border border-amber-500/20 rounded-lg p-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="min-w-0 flex items-start gap-3">
              <div className="rounded-md bg-amber-500/10 p-2 text-amber-400">
                <Target className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Target Distance Guard</div>
                <p className="break-words text-[10px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
                  Stay out when the fresh underlying price is within the configured distance of the Kalshi target, regardless of which side is in band.
                </p>
              </div>
            </div>
            <div className="flex w-full items-center gap-3 sm:gap-4 md:w-auto md:shrink-0">
              <label className={`min-w-0 flex flex-1 items-center gap-2 md:flex-none ${!merged.targetProximityGuardEnabled ? "opacity-50" : ""}`}>
                <span className="text-[10px] text-muted-foreground">Minimum distance</span>
                <div className="relative min-w-20 flex-1 md:w-24 md:flex-none">
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
                className={`relative h-6 w-11 rounded-full transition-colors ${merged.targetProximityGuardEnabled ? "bg-amber-500" : "bg-muted"}`}
                title="Toggle Target Distance Guard"
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.targetProximityGuardEnabled ? "translate-x-5" : "translate-x-0"}`} />
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
          <div className="bg-background/50 border border-border rounded-lg overflow-hidden sm:overflow-x-auto">
            <table className="block w-full text-sm sm:table sm:min-w-[760px]">
              <tbody className="block sm:table-row-group">
                {PER_MARKET_SYMBOLS.map(sym => {
                  const pm = merged.perMarketOverrides?.find(m => m.symbol === sym) || { symbol: sym };
                  const isPaused = pm.paused ?? false;
                  const statusInfo = statusData?.markets.find(m => m.symbol === sym);
                  const timingLabel = statusInfo?.timingPhase === "eligible"
                    ? `Submission eligible · ${statusInfo.secondsRemaining == null ? "time unknown" : `${Math.max(0, Math.ceil(statusInfo.secondsRemaining))}s left`} · ${statusInfo.effectiveWindowSeconds}s window`
                    : statusInfo?.timingPhase === "preflight_warmup"
                      ? `Warm-up only · eligible in ${Math.max(0, Math.ceil(statusInfo.secondsUntilEligible ?? 0))}s`
                      : statusInfo?.timingPhase === "closed_expired"
                        ? "Window closed"
                        : statusInfo
                          ? `Waiting · eligible in ${statusInfo.secondsUntilEligible == null ? "—" : `${Math.max(0, Math.ceil(statusInfo.secondsUntilEligible))}s`}`
                          : null;
                  const scannerLabel = statusInfo?.state === "active"
                    ? (statusInfo.lastAsk !== null ? `candidate · ${Math.round(statusInfo.lastAsk * 100)}¢` : "scanning")
                    : statusInfo?.state === "guarded"
                      ? `blocked · ${readableReason(statusInfo.reason)}`
                      : readableReason(statusInfo?.state ?? null);
                  const statusLabel = [timingLabel, scannerLabel].filter(Boolean).join(" · ");
                  const isReadyOrEligible = Boolean(
                    statusInfo
                    && !isPaused
                    && statusInfo.timingPhase !== "closed_expired"
                    && (statusInfo.state === "ready" || statusInfo.state === "active"),
                  );
                  const isIneligible = Boolean(statusInfo && !isReadyOrEligible);
                  
                  return (
                    <tr key={sym} className={`block p-3 border-b border-border/40 last:border-0 hover:bg-muted/10 transition-colors sm:table-row sm:p-0 ${isPaused ? "bg-red-500/5" : ""}`}>
                      <td className="inline-block w-auto px-0 py-1 pr-3 font-bold sm:table-cell sm:w-20 sm:px-4 sm:py-2">
                        {sym}
                      </td>
                      <td className="inline-block w-auto px-0 py-1 sm:table-cell sm:w-28 sm:px-2 sm:py-2">
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
                      <td className="block px-0 pt-3 pb-0 sm:table-cell sm:px-2 sm:py-2">
                        <div className="flex flex-wrap items-center gap-3">
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
                            <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
                              {statusInfo.freefallBlocked && (
                                <span
                                  className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                                  title={`${readableReason(statusInfo.reason)} · ${statusInfo.freefallSamplesUsed}/${statusInfo.freefallRequiredSamples} fresh samples`}
                                >
                                  {statusInfo.reason?.includes("warming") ? "WARMING" : "DIRECTION"}
                                </span>
                              )}
                              {statusInfo.rapidMoveBlocked && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-300" title="Fast-move avoidance blocked this market">
                                  FAST
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
                              <span
                                data-testid={`text-scalper-timing-${sym}`}
                                data-eligibility={isReadyOrEligible ? "ready" : isIneligible ? "ineligible" : "unknown"}
                                className={`min-w-0 flex-1 rounded-md border px-2 py-1 text-left text-[9px] font-bold sm:w-52 sm:flex-none sm:text-right ${
                                  isReadyOrEligible
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                    : isIneligible
                                      ? "border-red-500/30 bg-red-500/10 text-red-300"
                                      : "border-border bg-background/30 text-muted-foreground"
                                }`}
                                title={`${statusLabel}. Warm-up never submits an order; an authenticated quote and all guards are rechecked immediately before Paper/Live execution.`}
                              >
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
          <div className="flex flex-wrap items-center justify-end gap-3 mt-4 pt-4 border-t border-border/50">
            <span className="text-xs text-amber-500/70">Unsaved changes</span>
            <button onClick={() => setConfigDraft({})} disabled={mutationBusy !== null} className="text-xs text-muted-foreground hover:text-foreground">Discard</button>
            <button onClick={saveConfig} disabled={mutationBusy !== null || !canManage} className="bg-amber-600 hover:bg-amber-500 text-amber-50 px-4 py-1.5 rounded font-bold text-xs transition-colors shadow disabled:opacity-50 disabled:cursor-not-allowed">
              {mutationBusy === "save" ? "Saving..." : "Save settings"}
            </button>
          </div>
        )}
        </fieldset>

        {funnelData && (
          <div
            data-testid="panel-scalper-window-funnel"
            className="mt-8 border-t border-amber-500/20 pt-6"
          >
            <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
              <Activity className="h-4 w-4 shrink-0 text-amber-500/70" />
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-amber-500/70">
                  Window fill funnel
                </h3>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  The 2–3 confirmed-fill goal is an optimization target, never a reason to force an unsafe trade.
                </p>
              </div>
              <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground">
                <span>
                  Avg{" "}
                  <strong
                    data-testid="text-scalper-funnel-average"
                    className="font-mono text-amber-200"
                  >
                    {funnelData.averageConfirmedFills?.toFixed(2) ?? "—"}
                  </strong>
                  /window
                </span>
                <span>
                  Goal{" "}
                  <strong className="font-mono text-emerald-300">
                    {funnelData.windowsAtTarget}/{funnelData.activeWindows}
                  </strong>
                </span>
              </div>
            </div>

            {funnelData.windows.length === 0 ? (
              <div
                data-testid="text-scalper-funnel-empty"
                className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-4 text-center text-[11px] text-muted-foreground"
              >
                No active windows recorded for this mode yet.
              </div>
            ) : (
              <div
                data-testid="list-scalper-window-funnel"
                className="mt-3 grid gap-2"
              >
                {funnelData.windows.map((window) => {
                  const atTarget = window.confirmedFills >= funnelData.targetMinFills
                    && window.confirmedFills <= funnelData.targetMaxFills;
                  const stages = [
                    ["Considered", window.candidateSymbols],
                    ["Eligible", window.eligibleQuotes],
                    ["Quote loss", window.finalQuoteLoss],
                    ["Safety blocks", window.safetyBlocks],
                    ["Submitted", window.submissions],
                    ["Zero fills", window.zeroFills],
                    ["Confirmed", window.confirmedFills],
                  ] as const;
                  return (
                    <div
                      key={window.windowKey}
                      data-testid={`row-scalper-window-funnel-${window.windowKey}`}
                      className="rounded-lg border border-border bg-background/40 px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-bold text-foreground">
                          {wkToEstRange(window.windowKey)} {ET_LABEL}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          updated {fmtDateTime(window.lastActivityAt)}
                        </span>
                        <span className={`ml-auto rounded px-1.5 py-0.5 text-[9px] font-black tracking-wide ${
                          atTarget
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-amber-500/10 text-amber-200"
                        }`}>
                          {atTarget ? "GOAL RANGE" : `${window.confirmedFills} CONFIRMED`}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-4 gap-1 sm:grid-cols-7">
                        {stages.map(([label, value]) => (
                          <div
                            key={label}
                            className="rounded border border-border/70 bg-card/40 px-1.5 py-1 text-center"
                          >
                            <div className={`font-mono text-xs font-bold ${
                              label === "Confirmed"
                                ? "text-emerald-300"
                                : label === "Quote loss" || label === "Safety blocks"
                                  ? "text-red-300"
                                  : "text-foreground"
                            }`}>
                              {value}
                            </div>
                            <div className="mt-0.5 text-[8px] uppercase tracking-wide text-muted-foreground">
                              {label}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {shadowStudyData && (
          <div
            data-testid="panel-scalper-shadow-study"
            className="mt-8 border-t border-amber-500/20 pt-6"
          >
            <div className="flex flex-wrap items-start gap-3">
              <Timer className="mt-0.5 h-4 w-4 shrink-0 text-amber-500/70" />
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-bold uppercase tracking-widest text-amber-500/70">
                  Shadow entry study
                </h3>
                <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-muted-foreground">
                  Every displayed time means <strong className="text-foreground">time left before market close</strong>.
                  The study compares 1:00 through 2:00, plus any configured Scalper
                  timing outside that range. Live timing and safety rules stay unchanged.
                </p>
                {shadowStudyData.trackingSince && (
                  <p className="mt-1 text-[9px] text-amber-200/70">
                    Visual results since {fmtDateTime(shadowStudyData.trackingSince)}.
                    Older records remain stored.
                  </p>
                )}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-amber-200">
                  No orders placed
                </span>
                <button
                  type="button"
                  onClick={resetShadowStudyView}
                  data-testid="button-reset-scalper-shadow-view"
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-background/50 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-muted-foreground transition-colors hover:border-amber-500/40 hover:text-amber-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
                  title="Start a fresh visual comparison without deleting stored shadow or real bet history"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset view
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-2 rounded-lg border border-border/60 bg-background/20 p-3 sm:grid-cols-3">
              <div>
                <div className="text-[9px] font-bold uppercase tracking-wide text-foreground">
                  1. Qualified
                </div>
                <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                  The live direction guards passed and a cached quote was inside the configured price band.
                </p>
              </div>
              <div>
                <div className="text-[9px] font-bold uppercase tracking-wide text-foreground">
                  2. Quote later
                </div>
                <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                  Shows whether that early opportunity disappeared or moved out of band later.
                </p>
              </div>
              <div>
                <div className="text-[9px] font-bold uppercase tracking-wide text-foreground">
                  3. Simulated result
                </div>
                <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                  Compares the shadow side with the settled market. It is not an actual fill.
                </p>
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {shadowStudyData.variants.map((variant) => {
                const isConfiguredTiming =
                  variant.variantSeconds === shadowStudyData.configuredWindowSeconds;
                const overrideSymbols = Object.entries(
                  shadowStudyData.effectiveWindowSecondsBySymbol ?? {},
                )
                  .filter(([, seconds]) =>
                    seconds === variant.variantSeconds
                    && seconds !== shadowStudyData.configuredWindowSeconds
                  )
                  .map(([symbol]) => symbol);
                return (
                  <div
                    key={variant.variantSeconds}
                    data-testid={`card-scalper-shadow-${variant.variantSeconds}`}
                    data-selected-timing={isConfiguredTiming ? "true" : "false"}
                    className={`relative rounded-lg border p-3 transition-colors ${
                      isConfiguredTiming
                        ? "border-amber-400/60 bg-amber-500/10 ring-1 ring-amber-500/30"
                        : "border-border/70 bg-background/40 hover:border-border"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
                          Time left
                        </div>
                        <span className="font-mono text-base font-black text-amber-200">
                          {formatShadowVariant(variant.variantSeconds)}
                        </span>
                      </div>
                      {isConfiguredTiming ? (
                        <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[7px] font-black uppercase tracking-wide text-amber-300">
                          Current setting
                        </span>
                      ) : overrideSymbols.length > 0 ? (
                        <span
                          className="rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-wide text-sky-300"
                          title={`${overrideSymbols.join(", ")} use this per-market timing`}
                        >
                          {overrideSymbols.length} override{overrideSymbols.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>

                    <dl className="mt-3 space-y-1.5 text-[9px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">Qualified</dt>
                        <dd className="font-mono font-bold text-foreground">
                          {variant.candidates} of {variant.observed}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">Settled results</dt>
                        <dd className="font-mono font-bold text-foreground">
                          <span className="text-emerald-300">{variant.wins}W</span>
                          {" / "}
                          <span className={variant.losses > 0 ? "text-red-300" : ""}>
                            {variant.losses}L
                          </span>
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">Win rate</dt>
                        <dd className={`font-mono font-bold ${
                          variant.winRate == null
                            ? "text-muted-foreground"
                            : variant.winRate >= 80
                              ? "text-emerald-300"
                              : "text-foreground"
                        }`}>
                          {variant.winRate == null ? "—" : `${variant.winRate.toFixed(0)}%`}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">Quote lost later</dt>
                        <dd className="font-mono font-bold text-amber-200">
                          {variant.candidatesBeforeLaterQuoteIssue}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 border-t border-border/50 pt-1.5">
                        <dt className="font-bold text-muted-foreground">Combined simulated P&amp;L</dt>
                        <dd className={`font-mono text-xs font-black ${
                          variant.hypotheticalPnl >= 0 ? "text-emerald-300" : "text-red-300"
                        }`}>
                          {fmt$(variant.hypotheticalPnl)}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-2 border-t border-border/40 pt-2 text-[9px] leading-relaxed text-muted-foreground/90">
                      {variant.observed === 0
                        ? "No market checks recorded for this time-left slot yet."
                        : variant.candidates === 0
                          ? `None of ${variant.observed} market checks passed both safety and quote requirements.`
                          : `${variant.candidates} of ${variant.observed} checks qualified; ${variant.settled} have settled.`
                      }
                      {variant.averageFirstSafeSecondsRemaining == null
                        ? ""
                        : ` Average first safe point: ${formatShadowVariant(Math.round(variant.averageFirstSafeSecondsRemaining))} time left.`}
                    </p>
                  </div>
                );
              })}
            </div>

            {shadowStudyData.variants.some((variant) =>
              variant.settled > 0
              && (variant.winRate ?? 0) >= 50
              && variant.hypotheticalPnl < 0
            ) && (
              <div className="mt-3 flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" />
                <p className="text-[9px] leading-relaxed text-red-100/80">
                  A high win rate can still show a loss because these late contracts
                  earn only a few cents when correct but can lose most of their cost
                  when wrong. One losing entry may outweigh several winners.
                </p>
              </div>
            )}

            {shadowStudyData.recent.some((row) => row.firstSafeEntryAt) && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-background/30">
                <div className="border-b border-border/70 px-3 py-2">
                  <div className="text-[9px] font-bold uppercase tracking-wide text-foreground">
                    Individual hypothetical entries
                  </div>
                  <p className="mt-0.5 text-[9px] text-muted-foreground">
                    Read these rows to see exactly which side the shadow chose and what the market settled.
                  </p>
                </div>
                <table className="w-full min-w-[820px] text-left text-[10px]">
                  <thead className="border-b border-border/70 text-[8px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Market</th>
                      <th className="px-3 py-2">Timing tested</th>
                      <th className="px-3 py-2">Qualification</th>
                      <th className="px-3 py-2">What happened later</th>
                      <th className="px-3 py-2">Simulated result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shadowStudyData.recent
                      .filter((row) => row.firstSafeEntryAt)
                      .slice(0, 12)
                      .map((row) => (
                        <tr
                          key={`${row.mode}:${row.windowKey}:${row.symbol}:${row.variantSeconds}`}
                          className="border-b border-border/40 transition-colors last:border-0 hover:bg-accent/30"
                        >
                          <td className="px-3 py-2">
                            <div className="font-bold text-foreground">
                              {row.symbol}
                            </div>
                            <div className="mt-0.5 text-[9px] text-muted-foreground">
                              {wkToEstRange(row.windowKey)}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-mono font-bold text-amber-200">
                              {formatShadowVariant(row.variantSeconds)} time left
                            </div>
                            {row.variantSeconds === (
                              shadowStudyData.effectiveWindowSecondsBySymbol?.[row.symbol]
                              ?? shadowStudyData.configuredWindowSeconds
                            ) && (
                              <div className="mt-0.5 text-[7px] font-bold uppercase tracking-wide text-amber-400">
                                Current {row.symbol} setting
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-bold text-foreground">
                              Chose {row.side?.toUpperCase()}
                            </div>
                            <div className="mt-0.5 text-[9px] text-muted-foreground">
                              Passed at {row.firstSafeSecondsRemaining == null
                                ? "an unknown time"
                                : `${formatShadowVariant(Math.round(row.firstSafeSecondsRemaining))} left`}
                              {" · "}
                              {((row.winningAsk ?? 0) * 100).toFixed(0)}¢ cached ask
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {row.laterQuoteIssueObserved
                              ? row.laterQuoteIssueReason === "outside_band"
                                ? "Quote later left the configured band"
                                : "Quote later became unavailable"
                              : "Cached quote stayed in range"}
                          </td>
                          <td className={`px-3 py-2 font-bold ${
                            row.outcome === "win"
                              ? "text-emerald-300"
                              : row.outcome === "loss"
                                ? "text-red-300"
                                : "text-muted-foreground"
                          }`}>
                            {row.outcome ? (
                              <>
                                <div>
                                  Would have {row.outcome === "win" ? "won" : "lost"}{" "}
                                  {fmt$(row.hypotheticalPnl ?? 0)}
                                </div>
                                <div className="mt-0.5 text-[9px] font-normal text-muted-foreground">
                                  Shadow chose {row.side?.toUpperCase()} · market settled{" "}
                                  {row.settlementResult?.toUpperCase()}
                                </div>
                              </>
                            ) : "Awaiting market settlement"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {!shadowStudyData.recent.some((row) => row.firstSafeEntryAt) && (
              <div className="mt-3 rounded-lg border border-dashed border-border/70 bg-background/20 p-5 text-center">
                <div className="text-[10px] font-bold text-foreground">
                  Monitoring hypothetical entries
                </div>
                <p className="mt-1 text-[9px] text-muted-foreground">
                  No market has passed both the safety guards and cached quote check
                  {shadowStudyData.trackingSince ? " since the visual reset" : " in this view yet"}.
                </p>
              </div>
            )}

            <p className="mt-3 text-[9px] leading-relaxed text-muted-foreground/70">
              {shadowStudyData.disclaimer}
            </p>
          </div>
        )}

        {(statusData?.recentAttempts?.length ?? 0) > 0 && (() => {
          const totalAttempts = statusData!.recentAttempts.length;
          const totalPages = Math.ceil(totalAttempts / ATTEMPT_PAGE_SIZE);
          const safePage = Math.min(attemptPage, totalPages - 1);
          const pagedAttempts = statusData!.recentAttempts.slice(
            safePage * ATTEMPT_PAGE_SIZE,
            (safePage + 1) * ATTEMPT_PAGE_SIZE,
          );
          return (
            <div className="mt-8 border-t border-amber-500/20 pt-6">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
                <Target className="w-4 h-4 text-amber-500/70 shrink-0" />
                <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Recent candidate checks</h3>
                <span className="text-[10px] text-muted-foreground">Operational outcomes, not all completed bets</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{totalAttempts} total</span>
              </div>
              <div className="space-y-2">
                {pagedAttempts.map((attempt) => {
                  const isFilled = attempt.status === "filled";
                  const isUnsafe = attempt.status === "unknown" || attempt.status === "error";
                  const isZeroFill = attempt.status === "zero_fill";
                  const guardBlock = getScalperGuardBlock(attempt);
                  const executionPricing = attempt.observedWinningAsk != null && attempt.executionWinningLimit != null
                    ? `${(attempt.observedWinningAsk * 100).toFixed(1).replace(/\.0$/, "")}¢ quote → ${(attempt.executionWinningLimit * 100).toFixed(1).replace(/\.0$/, "")}¢ ${attempt.mode === "live" ? "IOC" : "sim"} cap`
                    : null;
                  const evidenceLines = describeScalperEvidence(attempt);
                  const retryText = isZeroFill
                    ? (attempt.retryEligible
                        ? attempt.retryState === "ready"
                          ? `Retry ready · ${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} used`
                          : `Retry in ${Math.max(0.1, (attempt.retryAfterMs ?? 0) / 1_000).toFixed(1)}s · ${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} used`
                        : `${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} submissions used`)
                    : (!isZeroFill && attempt.retryEligible
                        ? attempt.retryState === "ready"
                          ? "Transient skip · retry ready"
                          : `Transient skip · ${Math.max(0.1, (attempt.retryAfterMs ?? 0) / 1_000).toFixed(1)}s`
                        : null);
                  return (
                    <div
                      key={attempt.id}
                      className="rounded-lg border border-border bg-background/40 px-3 py-2"
                    >
                      {/* Top row: symbol + description + mode badge */}
                      <div className="flex items-center gap-2 text-xs min-w-0">
                        <span className="font-bold text-foreground w-10 shrink-0">{attempt.symbol}</span>
                        <span className={`font-semibold min-w-0 truncate ${
                          isFilled ? "text-emerald-400" : isUnsafe || guardBlock ? "text-red-400" : isZeroFill ? "text-sky-400" : "text-amber-300"
                        }`}>
                          {describeScalperAttempt(attempt)}
                        </span>
                        {attempt.side && (
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            attempt.side === "yes"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-red-500/15 text-red-300"
                          }`}>
                            {attempt.side.toUpperCase()}
                          </span>
                        )}
                        {guardBlock && (
                          <span
                            data-testid={`badge-scalper-guard-block-${attempt.id}`}
                            className="shrink-0 rounded border border-red-400/30 bg-red-500/15 px-1.5 py-0.5 text-[9px] font-black tracking-wide text-red-300"
                          >
                            {guardBlock.badge}
                          </span>
                        )}
                        <span className={`ml-auto shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          attempt.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"
                        }`}>
                          {attempt.mode.toUpperCase()}
                        </span>
                      </div>
                      {/* Second row: pricing / retry status + timestamp */}
                      {(executionPricing || retryText || true) && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 pl-0 sm:pl-12 text-[10px] text-muted-foreground">
                          {executionPricing && (
                            <span className="font-mono text-amber-200/75" title={`Latest ${attempt.mode === "live" ? "submitted" : "simulated"} ${attempt.side?.toUpperCase() ?? ""} quote`}>
                              {executionPricing}
                            </span>
                          )}
                          {retryText && <span>{retryText}</span>}
                          <span
                            data-testid={`text-scalper-attempt-timestamp-${attempt.id}`}
                            className="ml-auto whitespace-nowrap"
                          >
                            Guard checked {fmtDateTime(attempt.attemptedAt)}
                          </span>
                        </div>
                      )}
                      {evidenceLines.length > 0 && (
                        <details className="mt-1.5 pl-0 sm:pl-12 text-[10px] text-muted-foreground/80">
                          <summary
                            data-testid={`button-scalper-check-details-${attempt.id}`}
                            className="cursor-pointer select-none font-semibold text-muted-foreground hover:text-foreground"
                          >
                            Show check details
                          </summary>
                          <div
                            data-testid={`text-scalper-skip-evidence-${attempt.id}`}
                            className="mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-2"
                          >
                            {evidenceLines.map((line) => (
                              <span
                                key={line}
                                className={
                                  line.startsWith("GUARD TRIGGERED:")
                                    ? "font-semibold text-red-300"
                                    : line.startsWith("SAFETY CHECKS PASSED")
                                      ? "font-semibold text-emerald-400/80"
                                      : undefined
                                }
                              >
                                {line}
                              </span>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-amber-500/10">
                  <button
                    type="button"
                    onClick={() => setAttemptPage(p => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded border border-border hover:border-amber-500/40 transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-[10px] text-muted-foreground">
                    Page {safePage + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttemptPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded border border-border hover:border-amber-500/40 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          );
        })()}

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

            <div className="grid grid-cols-1 min-[360px]:grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3 mb-4">
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
              <div className="bg-background/50 border border-border rounded-lg overflow-x-auto overscroll-x-contain">
                <table className="w-full min-w-[640px] text-sm">
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
