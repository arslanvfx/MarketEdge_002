import React from "react";
import { Activity, DollarSign, RefreshCw, Zap } from "lucide-react";
import type { QuietHoursV2, SymbolSmartHoursMode } from "./types";
import { getQuietHoursHourMode, QuietHoursGrid } from "./quiet-hours-grid";
import { REGULAR_BOT_SYMBOLS } from "./regular-symbols";

// Kept alongside the per-symbol panel so any client-side status additions use
// the same ET day semantics as the schedule grid.
function getEtDowClient(d: Date): number {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const index = days.indexOf(d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" }));
  return index >= 0 ? index : d.getUTCDay();
}

export function mergePerSymbolQuietHoursForDisplay(server: Record<string, QuietHoursV2>, draft: Record<string, QuietHoursV2>): Record<string, QuietHoursV2> {
  const result = { ...server };
  for (const [symbol, schedule] of Object.entries(draft)) {
    const serverSchedule = server[symbol];
    if (!serverSchedule) { result[symbol] = schedule; continue; }
    const serverAt = Date.parse(serverSchedule.calibratedAt ?? "");
    const draftAt = Date.parse(schedule.calibratedAt ?? "");
    const newerCalibration = Number.isFinite(serverAt) && (!Number.isFinite(draftAt) || serverAt > draftAt);
    result[symbol] = {
      ...serverSchedule,
      ...schedule,
      ...(newerCalibration ? {
        silencedByDow: serverSchedule.silencedByDow,
        dataGatheringByDow: serverSchedule.dataGatheringByDow,
        silencedUtcHours: serverSchedule.silencedUtcHours,
        calibratedAt: serverSchedule.calibratedAt,
      } : {}),
    };
  }
  return result;
}

export interface PerSymbolQuietHoursPanelProps {
  perSymbolQuietHours: Record<string, QuietHoursV2>;
  masterEnabled: boolean;
  onChange: (symbol: string, value: QuietHoursV2) => void;
  onCalibrationApplied?: () => void;
  onImmediateSaveError?: (message: string) => void;
  authPost: (path: string, body: object) => Promise<unknown>;
  dgCap?: number;
  dgEnabled?: boolean;
  symbolSmartHoursModes?: Record<string, SymbolSmartHoursMode>;
}

export function PerSymbolQuietHoursPanel({
  perSymbolQuietHours, masterEnabled, onChange, onCalibrationApplied, onImmediateSaveError, authPost,
  dgCap: dgCapProp = 1, dgEnabled: dgEnabledProp = true,
  symbolSmartHoursModes,
}: PerSymbolQuietHoursPanelProps) {
  const [selectedSymbol, setSelectedSymbol] = React.useState<string>(REGULAR_BOT_SYMBOLS[0]);
  const [calibrating, setCalibrating] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [messageOk, setMessageOk] = React.useState(true);
  const [threshold, setThreshold] = React.useState(85);
  const [dgCap, setDgCap] = React.useState(dgCapProp);
  const [dgEnabled, setDgEnabled] = React.useState(dgEnabledProp);
  const schedulesRef = React.useRef(perSymbolQuietHours);
  React.useEffect(() => { schedulesRef.current = perSymbolQuietHours; }, [perSymbolQuietHours]);
  React.useEffect(() => { setDgCap(dgCapProp); }, [dgCapProp]);
  React.useEffect(() => { setDgEnabled(dgEnabledProp); }, [dgEnabledProp]);

  const post = async (body: object) => {
    try { await authPost("/crypto/bot/config", body); }
    catch (error) { onImmediateSaveError?.(error instanceof Error ? error.message : "Unable to save Smart Quiet Hours"); }
  };
  const calibrate = async () => {
    setCalibrating(true); setMessage(null);
    try {
      const result = await authPost("/crypto/bot/quiet-hours-calibrate-all", { threshold }) as {
        perSymbolQuietHours?: Record<string, QuietHoursV2>; calibratedSymbols?: string[]; skippedSymbols?: string[];
      };
      if (!result.perSymbolQuietHours || Object.keys(result.perSymbolQuietHours).length === 0) throw new Error("No markets could be calibrated");
      for (const [symbol, schedule] of Object.entries(result.perSymbolQuietHours)) {
        onChange(symbol, { ...(perSymbolQuietHours[symbol] ?? {}), ...schedule, enabled: true });
      }
      onCalibrationApplied?.();
      const count = result.calibratedSymbols?.length ?? Object.keys(result.perSymbolQuietHours).length;
      const skipped = result.skippedSymbols?.length ?? 0;
      setMessageOk(true); setMessage(skipped ? `✓ ${count} markets applied & saved · ${skipped} failed` : `✓ ${count} coins · all days applied & saved`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Calibration failed";
      setMessageOk(false); setMessage(text); onImmediateSaveError?.(text);
    } finally {
      setCalibrating(false); window.setTimeout(() => setMessage(null), 8_000);
    }
  };
  const schedule = perSymbolQuietHours[selectedSymbol] ?? { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} };
  const now = new Date();
  const currentUtcHour = now.getUTCHours();
  const currentEtDow = getEtDowClient(now);
  const tabMode = (symbol: string): "active" | "silenced" | "reduced" => {
    if (!masterEnabled) return "active";
    const serverMode = symbolSmartHoursModes?.[symbol];
    if (serverMode === "silenced" || serverMode === "reduced" || serverMode === "active") {
      return serverMode;
    }
    const symbolSchedule = perSymbolQuietHours[symbol];
    if (!symbolSchedule?.enabled) return "active";
    return getQuietHoursHourMode(currentUtcHour, symbolSchedule, currentEtDow);
  };
  const tabStyle = (mode: "active" | "silenced" | "reduced", selected: boolean): string => {
    const stateStyle = mode === "silenced"
      ? "border-red-500/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
      : mode === "reduced"
        ? "border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
        : "border-emerald-500/60 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25";
    return `${stateStyle} ${selected ? "ring-2 ring-white/45 ring-offset-1 ring-offset-background shadow-sm" : ""}`;
  };

  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex shrink-0 items-center gap-1.5"><span className="text-[11px] text-muted-foreground">Silence below</span>
          <select className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground" value={threshold} onChange={e => setThreshold(parseFloat(e.target.value))} disabled={calibrating}>
            {Array.from({ length: 31 }, (_, i) => parseFloat((90 - i * .5).toFixed(1))).map(value => <option key={value} value={value}>{value}% win rate</option>)}
          </select>
        </label>
        <button type="button" onClick={calibrate} disabled={calibrating} className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-medium transition-all disabled:opacity-50 ${message ? messageOk ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : "border-red-500/50 bg-red-500/10 text-red-400" : "border-cyan-500/40 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"}`}>
          {calibrating ? <><RefreshCw className="h-3 w-3 animate-spin" /> Calibrating all markets…</> : <><Zap className="h-3 w-3" /> {message ?? "Calibrate & Apply All Markets"}</>}
        </button>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground/50">Analyzes 90 days of bet history per coin · silences hours below the chosen win-rate threshold for each day of the week · applies &amp; saves across all markets at once.</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70">
        <DollarSign className="h-3 w-3 shrink-0 text-violet-400" /><span className="font-medium text-violet-300/80">Sparse hours bet cap</span>
        <span className="flex items-center gap-0.5">$<input type="number" min={.5} max={50} step={.5} disabled={!dgEnabled} value={dgCap} onChange={e => { const value = parseFloat(e.target.value); if (value >= .5 && value <= 50) setDgCap(value); }} onBlur={() => void post({ dataGatheringBetCap: dgCap })} className="w-14 rounded border border-violet-500/30 bg-background px-1 py-0.5 text-right text-[11px] text-violet-300 disabled:opacity-40" /></span>
        <button type="button" className={`rounded px-2 py-0.5 text-[10px] ${dgEnabled ? "bg-violet-500 text-white" : "bg-muted"}`} onClick={() => { const value = !dgEnabled; setDgEnabled(value); void post({ dataGatheringEnabled: value }); }}>{dgEnabled ? "on" : "off"}</button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-1.5">
      {REGULAR_BOT_SYMBOLS.map(symbol => {
        const mode = tabMode(symbol);
        const label = mode === "silenced" ? "Off" : mode === "reduced" ? "Restricted" : "On";
        return (
          <button
            type="button"
            key={symbol}
            onClick={() => setSelectedSymbol(symbol)}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${tabStyle(mode, selectedSymbol === symbol)}`}
            title={`${symbol}: Smart Hours ${label}`}
            aria-label={`${symbol}: Smart Hours ${label}`}
            data-smart-hours-mode={mode}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${mode === "silenced" ? "bg-red-400" : mode === "reduced" ? "bg-amber-300" : "bg-emerald-400"}`} />
            {symbol}
          </button>
        );
      })}
    </div>
    <div className="rounded-lg border border-border/50 bg-secondary/20 p-2 text-[11px] text-muted-foreground"><Activity className="mr-1 inline h-3 w-3 text-cyan-400" /> Market Status Right Now · {masterEnabled ? "Smart Hours enforcement is on" : "Smart Hours enforcement is off"}</div>
    <QuietHoursGrid key={selectedSymbol} value={schedule} onChange={value => onChange(selectedSymbol, value)} symbolFilter={selectedSymbol} dgCap={dgCap} onSave={value => { onChange(selectedSymbol, value); void post({ perSymbolQuietHours: { ...schedulesRef.current, [selectedSymbol]: value } }); }} />
  </div>;
}