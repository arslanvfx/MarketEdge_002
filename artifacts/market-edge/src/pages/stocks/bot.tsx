import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Play, Pause, DollarSign, Wallet, Zap, ShieldAlert, Loader2, RefreshCw,
  TrendingUp, TrendingDown, Save, AlertTriangle, Activity, CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { StocksShell } from "./stocks-shell";
import {
  stockGet, stockAuth, fmtUsd, fmtPct,
  type BotStatus, type StockBotConfig, type TradingMode,
} from "@/lib/stocks-api";

const MODE_LABELS: Record<TradingMode, string> = {
  day: "Day Trade",
  swing: "Short-Term Swing",
  long: "Long-Term Hold",
};

export default function StockBot() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmLive, setConfirmLive] = useState(false);
  const [draft, setDraft] = useState<Partial<StockBotConfig>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cycling, setCycling] = useState(false);

  const { data: status, isLoading } = useQuery<BotStatus>({
    queryKey: ["stocks-bot-status"],
    queryFn: () => stockGet("/bot/status"),
    refetchInterval: 5_000,
  });

  const { data: posData } = useQuery<{ positions: BotStatus["positions"] }>({
    queryKey: ["stocks-bot-positions"],
    queryFn: () => stockGet("/bot/positions"),
    refetchInterval: 10_000,
  });

  // Clear stale draft when backend config changes (e.g. after a save/restart).
  const prevCfg = useRef<string>("");
  useEffect(() => {
    const key = JSON.stringify(status?.config ?? {});
    if (prevCfg.current && prevCfg.current !== key) setDraft({});
    prevCfg.current = key;
  }, [status?.config]);

  const cfg = status?.config;
  const merged = { ...cfg, ...draft } as StockBotConfig;
  const hasDraft = Object.keys(draft).length > 0;
  const positions = posData?.positions ?? status?.positions ?? [];
  const account = status?.account;

  async function patch(partial: Partial<StockBotConfig>) {
    await stockAuth(getToken, "/bot/config", "PUT", partial);
    await qc.invalidateQueries({ queryKey: ["stocks-bot-status"] });
  }

  async function patchSafe(partial: Partial<StockBotConfig>) {
    try {
      await patch(partial);
    } catch (e) {
      toast({
        title: "Could not update bot",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    }
  }

  async function saveDraft() {
    if (!hasDraft) return;
    setSaving(true);
    try {
      await patch(draft);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      toast({
        title: "Could not save settings",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function runCycle() {
    setCycling(true);
    try {
      await stockAuth(getToken, "/bot/cycle", "POST");
      await qc.invalidateQueries({ queryKey: ["stocks-bot-status"] });
      await qc.invalidateQueries({ queryKey: ["stocks-bot-positions"] });
    } catch (e) {
      toast({
        title: "Cycle failed",
        description: e instanceof Error ? e.message : "Broker may not be connected.",
        variant: "destructive",
      });
    } finally {
      setCycling(false);
    }
  }

  function toggleMode(m: TradingMode) {
    const cur = merged.tradingModes ?? [];
    const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
    setDraft((d) => ({ ...d, tradingModes: next }));
  }

  const setField = <K extends keyof StockBotConfig>(k: K, v: StockBotConfig[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  if (isLoading) {
    return (
      <StocksShell>
        <div className="h-40 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading bot…
        </div>
      </StocksShell>
    );
  }

  return (
    <StocksShell>
      <div className="p-6 space-y-6">
        {/* Control bar */}
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
              status?.config.mode === "live"
                ? "border-red-500/50 bg-red-500/10 text-red-400"
                : "border-yellow-500/50 bg-yellow-500/10 text-yellow-400"
            }`}>
              {status?.config.mode?.toUpperCase() ?? "PAPER"}
            </span>
            <span className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ${
              cfg?.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"
            }`}>
              <Activity className="w-3 h-3" />
              {cfg?.enabled ? "Running" : "Stopped"}
            </span>
            {status?.cycle?.running && (
              <span className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-sky-500/10 text-sky-400">
                <Loader2 className="w-3 h-3 animate-spin" /> cycling
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => patchSafe({ enabled: !cfg?.enabled })}>
              {cfg?.enabled ? <><Pause className="w-3.5 h-3.5" />Stop</> : <><Play className="w-3.5 h-3.5" />Start</>}
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={runCycle} disabled={cycling}>
              {cycling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Run cycle
            </Button>
            {status?.config.mode === "paper" ? (
              confirmLive ? (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="destructive" className="h-8 text-xs" onClick={() => { patchSafe({ mode: "live" }); setConfirmLive(false); }}>
                    Confirm real money
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setConfirmLive(false)}>Cancel</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="h-8 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => setConfirmLive(true)}>
                  Switch to Real
                </Button>
              )
            ) : (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => patchSafe({ mode: "paper" })}>
                Back to Paper
              </Button>
            )}
          </div>
        </div>

        {/* Real-money confirmation warning */}
        {confirmLive && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-start gap-2">
            <ShieldAlert className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <span>
              <strong>You are about to enable live trading with real money.</strong> The bot will place
              real orders through your Alpaca live account using the settings below. Confirm only if you
              understand the risk.
            </span>
          </div>
        )}

        {/* Account cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Equity", value: fmtUsd(account?.equity), icon: DollarSign, color: "text-sky-400" },
            { label: "Cash", value: fmtUsd(account?.cash), icon: Wallet, color: "text-emerald-400" },
            { label: "Buying Power", value: fmtUsd(account?.buyingPower), icon: Zap, color: "text-violet-400" },
            { label: "Day Trades", value: account ? `${account.daytradeCount}/3` : "—", sub: account?.patternDayTrader ? "PDT flagged" : undefined, icon: ShieldAlert, color: account?.patternDayTrader ? "text-red-400" : "text-amber-400" },
          ].map(({ label, value, sub, icon: Icon, color }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <div className="text-xl font-bold text-foreground">{value}</div>
              {sub && <div className="text-[11px] text-red-400 mt-0.5">{sub}</div>}
            </div>
          ))}
        </div>

        {status?.cycle?.lastCycleSummary && (
          <div className="text-xs text-muted-foreground">
            Last cycle: <span className="text-foreground">{status.cycle.lastCycleSummary}</span>
            {status.cycle.lastCycleAt > 0 && ` · ${new Date(status.cycle.lastCycleAt).toLocaleTimeString()}`}
          </div>
        )}

        {/* Live positions */}
        <section>
          <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" /> Live Positions
            <span className="text-xs font-normal text-muted-foreground">({positions.length})</span>
          </h2>
          {positions.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              No open positions.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    {["Ticker", "Qty", "Entry", "Current", "Market Value", "Unreal. P&L", "%"].map((h) => (
                      <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.ticker} className="border-t border-border" data-testid={`position-${p.ticker}`}>
                      <td className="px-3 py-2 font-bold text-foreground">{p.ticker}</td>
                      <td className="px-3 py-2 text-foreground">{p.qty}</td>
                      <td className="px-3 py-2 text-foreground">{fmtUsd(p.avgEntry)}</td>
                      <td className="px-3 py-2 text-foreground">{fmtUsd(p.currentPrice)}</td>
                      <td className="px-3 py-2 text-foreground">{fmtUsd(p.marketValue)}</td>
                      <td className={`px-3 py-2 font-semibold ${p.unrealizedPl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtUsd(p.unrealizedPl)}</td>
                      <td className={`px-3 py-2 font-semibold ${p.unrealizedPlpc >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        <span className="inline-flex items-center gap-0.5">
                          {p.unrealizedPlpc >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {fmtPct(p.unrealizedPlpc)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Trading modes */}
        <section>
          <h2 className="text-sm font-bold text-foreground mb-3">Trading Modes</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(["day", "swing", "long"] as TradingMode[]).map((m) => {
              const on = merged.tradingModes?.includes(m);
              const cap = m === "day" ? merged.maxDayPositions : m === "swing" ? merged.maxSwingPositions : merged.maxLongPositions;
              const capKey = m === "day" ? "maxDayPositions" : m === "swing" ? "maxSwingPositions" : "maxLongPositions";
              return (
                <div key={m} className={`rounded-lg border p-4 transition-colors ${on ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-card"}`}>
                  <button onClick={() => toggleMode(m)} className="flex items-center justify-between w-full mb-3">
                    <span className="text-sm font-semibold text-foreground">{MODE_LABELS[m]}</span>
                    <span className={`w-9 h-5 rounded-full relative transition-colors ${on ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
                    </span>
                  </button>
                  <label className="text-[11px] text-muted-foreground">Max positions: <span className="text-foreground font-semibold">{cap ?? 0}</span></label>
                  <input type="range" min={0} max={10} value={cap ?? 0}
                    onChange={(e) => setField(capKey as keyof StockBotConfig, Number(e.target.value) as never)}
                    className="w-full mt-1 accent-emerald-500" />
                </div>
              );
            })}
          </div>
        </section>

        {/* Settings */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-foreground">Settings</h2>
            <div className="flex items-center gap-2">
              {saved && <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" />Saved</span>}
              <Button size="sm" onClick={saveDraft} disabled={!hasDraft || saving} className="h-8 gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save{hasDraft ? " changes" : "d"}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-5">
            <NumField label="Position size (% of equity)" value={merged.positionSizePct} min={0.5} max={25} step={0.5} onChange={(v) => setField("positionSizePct", v)} />
            <NumField label="Max concurrent positions" value={merged.maxConcurrentPositions} min={1} max={20} step={1} onChange={(v) => setField("maxConcurrentPositions", v)} />
            <NumField label="Daily loss limit ($)" value={merged.dailyLossLimit} min={0} max={100000} step={50} onChange={(v) => setField("dailyLossLimit", v)} />
            <NumField label="Min confidence to enter (%)" value={merged.minConfidence} min={50} max={95} step={1} onChange={(v) => setField("minConfidence", v)} />
            <NumField label="Stop loss (%)" value={merged.stopLossPct} min={0.5} max={20} step={0.5} onChange={(v) => setField("stopLossPct", v)} />
            <NumField label="Target gain (%)" value={merged.targetGainPct} min={0.5} max={50} step={0.5} onChange={(v) => setField("targetGainPct", v)} />
            <NumField label="Swing max hold (days)" value={merged.swingMaxHoldDays} min={1} max={30} step={1} onChange={(v) => setField("swingMaxHoldDays", v)} />
            <NumField label="Long max hold (days)" value={merged.longMaxHoldDays} min={1} max={365} step={1} onChange={(v) => setField("longMaxHoldDays", v)} />
            <NumField label="News sensitivity (1–5)" value={merged.newsSensitivity} min={1} max={5} step={1} onChange={(v) => setField("newsSensitivity", v)} />
            <NumField label="Earnings blackout (hours)" value={merged.earningsBlackoutHours} min={0} max={168} step={6} onChange={(v) => setField("earningsBlackoutHours", v)} />
            <div className="flex items-center justify-between md:col-span-2 pt-1">
              <span className="text-sm text-foreground">Earnings blackout</span>
              <button onClick={() => setField("earningsBlackout", !merged.earningsBlackout)}
                className={`w-9 h-5 rounded-full relative transition-colors ${merged.earningsBlackout ? "bg-emerald-500" : "bg-muted"}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${merged.earningsBlackout ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>
          </div>
          {!status?.configured && (
            <p className="text-[11px] text-amber-400/80 mt-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Settings save normally, but trading stays paused until the broker is connected.
            </p>
          )}
        </section>
      </div>
    </StocksShell>
  );
}

function NumField({ label, value, min, max, step, onChange }: {
  label: string; value: number | undefined; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="px-3 py-2 text-sm rounded-lg bg-background border border-border focus:border-emerald-500/50 outline-none"
      />
    </label>
  );
}
