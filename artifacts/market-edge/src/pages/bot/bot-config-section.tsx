import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import React from "react";
import type { BotStatus, BotConfig, BacktestModeStats, DecisionMode, QuietHoursV2 } from "./types";
import { QuietHoursGrid } from "./quiet-hours-grid";
import { utcToEst, estToUtc, ET_LABEL, fmtPct, API_BASE } from "./utils";
import { PhaseTracker } from "./phase-tracker";

const STABILITY_COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "HYPE", "NEAR", "ZEC"];

interface StabilityPreviewProps {
  minER: number;
  maxOsc: number;
  maxVolPct: number;
  minMLConf: number;
}

function StabilityPreview({ minER, maxOsc, maxVolPct, minMLConf }: StabilityPreviewProps) {
  const { data, dataUpdatedAt } = useQuery<{
    coinStability?: Record<string, { er: number; osc: number; volPct: number; mlConf: number | null; windowKey?: string }>;
  }>({
    queryKey: ["bot-pipeline-status"],
    queryFn: () => fetch(`${API_BASE}/crypto/bot/pipeline-status`).then(r => r.json()),
    refetchInterval: 5_000,
  });

  const coinStability = data?.coinStability;
  const hasData = coinStability && Object.keys(coinStability).length > 0;

  const results = STABILITY_COINS.map(sym => {
    const s = coinStability?.[sym];
    if (!s) return { sym, stable: null as boolean | null, er: null, osc: null, volPct: null, mlConf: null };
    const stable =
      s.er >= minER &&
      s.osc <= maxOsc &&
      s.volPct <= maxVolPct &&
      (s.mlConf === null || s.mlConf >= minMLConf);
    return { sym, stable, er: s.er, osc: s.osc, volPct: s.volPct, mlConf: s.mlConf };
  });

  const stableCount = results.filter(r => r.stable === true).length;
  const updatedSec = dataUpdatedAt ? Math.round((Date.now() - dataUpdatedAt) / 1000) : null;

  return (
    <div className="mt-1 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-violet-300 flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
          </span>
          Live eligibility — current thresholds
        </span>
        <span className="text-[9px] text-muted-foreground/50 font-mono">
          {hasData ? `${stableCount}/${STABILITY_COINS.length} stable` : "—"}
          {updatedSec !== null && updatedSec < 60 && <span className="ml-1 opacity-60">{updatedSec}s ago</span>}
        </span>
      </div>

      {!hasData ? (
        <span className="text-[10px] text-muted-foreground/50 italic">Waiting for indicator data…</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {results.map(({ sym, stable, er, osc, volPct, mlConf }) => {
            const failReasons: string[] = [];
            if (er !== null && er < minER) failReasons.push(`ER ${er.toFixed(2)}<${minER.toFixed(2)}`);
            if (osc !== null && osc > maxOsc) failReasons.push(`Osc ${osc}>${maxOsc}`);
            if (volPct !== null && volPct > maxVolPct) failReasons.push(`Vol ${volPct.toFixed(2)}%>${maxVolPct.toFixed(2)}%`);
            if (mlConf !== null && mlConf < minMLConf) failReasons.push(`ML ${mlConf.toFixed(0)}%<${minMLConf}%`);
            const title = stable === null
              ? `${sym}: no data`
              : stable
                ? `${sym}: STABLE → eligible for max bet roll`
                : `${sym}: volatile (${failReasons.join(", ")})`;

            return (
              <span
                key={sym}
                title={title}
                className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-default select-none transition-colors ${
                  stable === null
                    ? "bg-muted/30 text-muted-foreground/40 border-border/30"
                    : stable
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : "bg-amber-500/10 text-amber-400/80 border-amber-500/20"
                }`}
              >
                {stable === true && <Zap className="w-2.5 h-2.5" />}
                {sym}
              </span>
            );
          })}
        </div>
      )}

      <span className="text-[9px] text-muted-foreground/40 leading-relaxed">
        Green = stable → enters max bet probability roll · Amber = volatile → regular bet · Hover for details · Updates every 5 s
      </span>
    </div>
  );
}

interface BotConfigSectionProps {
  cfg: BotConfig | undefined;
  merged: BotConfig;
  configDraft: Partial<BotConfig>;
  setConfigDraft: React.Dispatch<React.SetStateAction<Partial<BotConfig>>>;
  saving: boolean;
  saveConfig: () => Promise<void>;
  persistMsg: "saved" | "failed" | "error" | null;
  status: BotStatus | undefined;
  activeMode: "paper" | "live";
  presetsData: { presets: Partial<Record<string, object>> } | undefined;
  modeDefaults: Partial<Record<string, object>> | undefined;
  savingPreset: boolean;
  savePreset: () => Promise<void>;
  presetMsg: string | null;
  backtestData: { modes: BacktestModeStats[] } | undefined;
  configOpen: boolean;
  setConfigOpen: React.Dispatch<React.SetStateAction<boolean>>;
  authPost: (path: string, body: object) => Promise<unknown>;
  qc: QueryClient;
}

type CalibrateResult = Record<string, {
  early: { n: number; mean: number | null; stdDev: number | null; suggested: number | null };
  late:  { n: number; mean: number | null; stdDev: number | null; suggested: number | null };
}>;

export function BotConfigSection({ cfg, merged, configDraft, setConfigDraft, saving, saveConfig, persistMsg, status, activeMode, presetsData, modeDefaults, savingPreset, savePreset, presetMsg, backtestData, configOpen, setConfigOpen, authPost, qc }: BotConfigSectionProps) {
  const hasDraft = Object.keys(configDraft).length > 0;
  const [defaultsAppliedFor, setDefaultsAppliedFor] = React.useState<string | null>(null);
  const [reEvalState, setReEvalState] = React.useState<{ loading: boolean; msg: string | null }>({ loading: false, msg: null });
  const [proximityCalibrating, setProximityCalibrating] = React.useState(false);
  const [proximityCalibResult, setProximityCalibResult] = React.useState<CalibrateResult | null>(null);
  const [proximityCalibMsg, setProximityCalibMsg] = React.useState<string | null>(null);
  const [proximityExpanded, setProximityExpanded] = React.useState(false);

  async function runReEvaluate() {
    setReEvalState({ loading: true, msg: null });
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
      const data = await authPost(`/crypto/bot/re-evaluate-bets?since=${encodeURIComponent(since)}&limit=500`, {}) as { ok?: boolean; checked?: number; corrected?: number; error?: string };
      if (data.ok) {
        setReEvalState({ loading: false, msg: data.corrected ? `✓ Fixed ${data.corrected} bet${data.corrected > 1 ? "s" : ""} (checked ${data.checked})` : `✓ All ${data.checked} bets correct` });
      } else {
        setReEvalState({ loading: false, msg: `⚠ ${data.error ?? "Unknown error"}` });
      }
    } catch {
      setReEvalState({ loading: false, msg: "⚠ Request failed" });
    }
  }
  const isConviction = (merged.decisionMode ?? "classic") === "conviction";
  return (
    <>
        {/* ── Config Settings ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setConfigOpen(o => !o)}
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Bot Configuration</h2>
            {hasDraft && <span className="text-xs text-amber-400 font-medium ml-1">· unsaved changes</span>}
            <span className="ml-auto text-muted-foreground">{configOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
          </button>

          {configOpen && cfg && (
            <div className="p-5 space-y-5">

              {/* ── Bet Profile ── */}
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Zap className="w-3 h-3" />
                  Bet Profile
                </span>
                <div className="grid grid-cols-2 gap-3">
                  {((): Array<{ id: "normal" | "aggressive"; label: string; sublabel: string; bullets: string[]; color: string }> => {
                    const mode = merged.decisionMode ?? "classic";
                    const mlBullet = (thresh: number): string => {
                      if (mode === "ml_gate") return `ML vetos bets it opposes (≥${merged.mlVetoMinConfidence ?? 57}% threshold)`;
                      if (mode === "consensus") return `ML is 1 of 3 majority votes`;
                      if (mode === "unanimous") return `ML must agree with all signals`;
                      return `ML leads at ≥${thresh}% confidence`;
                    };
                    return [
                      {
                        id: "normal" as const,
                        label: "Normal",
                        sublabel: "Current proven defaults",
                        bullets: [mlBullet(62), "15pp regime penalty", "No confidence cap"],
                        color: "sky",
                      },
                      {
                        id: "aggressive" as const,
                        label: "Aggressive",
                        sublabel: "More bets per window",
                        bullets: [mlBullet(58), "10pp regime penalty", "Confidence capped at 80%"],
                        color: "amber",
                      },
                    ];
                  })().map(p => {
                    const isSelected = (merged.betProfile ?? "normal") === p.id;
                    const colorSelected = p.color === "sky"
                      ? "border-sky-500/60 bg-sky-500/10 ring-1 ring-sky-500/30"
                      : "border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30";
                    const labelColor = p.color === "sky" ? "text-sky-400" : "text-amber-400";
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, betProfile: p.id }))}
                        className={`text-left rounded-xl p-3.5 border transition-all ${
                          isSelected ? colorSelected : "border-border bg-background/30 hover:border-border/80 hover:bg-muted/30"
                        }`}
                      >
                        <div className={`text-sm font-semibold mb-0.5 ${isSelected ? labelColor : "text-foreground"}`}>
                          {p.label}
                          {isSelected && <span className="ml-1.5 text-[9px] opacity-70">✓ active</span>}
                        </div>
                        <div className="text-[10px] text-muted-foreground/70 mb-2">{p.sublabel}</div>
                        <ul className="space-y-0.5">
                          {p.bullets.map(b => (
                            <li key={b} className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                              <span className="opacity-40">·</span> {b}
                            </li>
                          ))}
                        </ul>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {/* Bet Size */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {(merged.enableDynamicSizing ?? false) ? "Min Bet ($) — at min confidence" : "Bet Size ($)"}
                  </span>
                  <input type="number" min={0.5} max={500} step={0.5}
                    className={`bg-background border rounded-md px-3 py-1.5 text-sm text-foreground ${(merged.betSize ?? 1) > (merged.maxBetSize ?? 2) ? "border-red-500" : "border-border"}`}
                    value={merged.betSize ?? 1}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isNaN(v)) setConfigDraft(d => ({ ...d, betSize: v }));
                    }} />
                  {(merged.betSize ?? 1) > (merged.maxBetSize ?? 2) ? (
                    <span className="text-[10px] text-red-400">Exceeds max bet — bets will be blocked by the safety cap</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground/60">
                      Actual amounts may be slightly under due to integer contract rounding
                    </span>
                  )}
                </label>

                {/* Max Bet Size — safety cap AND dynamic-sizing target */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="text-amber-400">⚠</span>
                    {(merged.enableDynamicSizing ?? false) ? "Max Bet ($) — at highest confidence" : "Max Allowed Bet ($)"}
                  </span>
                  <input type="number" min={0.5} max={500} step={0.5}
                    className="bg-background border border-amber-500/40 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxBetSize ?? 2}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isNaN(v)) setConfigDraft(d => ({ ...d, maxBetSize: v }));
                    }} />
                  <span className="text-[10px] text-muted-foreground/60">
                    {(merged.enableDynamicSizing ?? false)
                      ? "Max bet placed at high confidence — also the hard safety cap"
                      : "Hard cap — any computed bet above this is blocked before it touches Kalshi"}
                  </span>
                </label>

                {!isConviction && (<>
                {/* Dynamic (confidence-based) sizing toggle */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Dynamic Sizing</span>
                  <button
                    type="button"
                    onClick={() => setConfigDraft(d => ({ ...d, enableDynamicSizing: !(merged.enableDynamicSizing ?? false) }))}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors ${(merged.enableDynamicSizing ?? false)
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-background border-border text-muted-foreground"}`}
                  >
                    {(merged.enableDynamicSizing ?? false) ? "On — scales with confidence" : "Off — fixed bet size"}
                  </button>
                  <span className="text-[10px] text-muted-foreground/60">
                    {(merged.enableDynamicSizing ?? false)
                      ? <>Scales from ${`${(merged.betSize ?? 1).toFixed(2)}`} (low confidence) → ${`${(merged.maxBetSize ?? 2).toFixed(2)}`} (high confidence)</>
                      : <>Off — every bet is ${`${(merged.betSize ?? 1).toFixed(2)}`} regardless of confidence</>}
                  </span>
                </label>

                {/* Max-bet confidence ceiling */}
                {(() => {
                  const dynamicOn = merged.enableDynamicSizing ?? false;
                  const minConf = merged.minConfidence ?? 60;
                  const maxBetConf = merged.dynamicSizingMaxConfidence ?? 90;
                  const belowMin = dynamicOn && maxBetConf < minConf;
                  return (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Full-Size Confidence (%)</span>
                      <input type="number" min={50} max={100} step={1}
                        disabled={!dynamicOn}
                        className={`bg-background border rounded-md px-3 py-1.5 text-sm text-foreground disabled:opacity-40 ${belowMin ? "border-amber-500" : "border-border"}`}
                        value={maxBetConf}
                        onChange={e => {
                          const raw = parseFloat(e.target.value);
                          if (!Number.isNaN(raw)) {
                            setConfigDraft(d => ({ ...d, dynamicSizingMaxConfidence: raw }));
                          }
                        }}
                        onBlur={e => {
                          const raw = parseFloat(e.target.value);
                          const clamped = Number.isNaN(raw) ? 90 : Math.min(100, Math.max(50, raw));
                          setConfigDraft(d => ({ ...d, dynamicSizingMaxConfidence: clamped }));
                        }} />
                      {!dynamicOn ? (
                        <span className="text-[10px] text-muted-foreground/40">Enable Dynamic Sizing above to use this</span>
                      ) : belowMin ? (
                        <span className="text-[10px] text-amber-400">Below Min Confidence ({minConf}%) — sizing will collapse to a flat step</span>
                      ) : maxBetConf >= 90 ? (
                        <span className="text-[10px] text-muted-foreground">90% = all models in strong agreement — rare, high-conviction entries only</span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/60">Confidence % where the max bet is reached — type any value 50–100</span>
                      )}
                    </label>
                  );
                })()}

                </>)}

                {/* ── Stat Regime Max-Bet ───────────────────────────────── */}
                {!isConviction && (<>
                <div className="flex flex-col gap-2 border border-blue-500/20 rounded-lg p-3 bg-blue-500/5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-blue-300 flex items-center gap-1.5">
                      <Activity className="w-3 h-3" />
                      Regime-Based Max Bet
                    </span>
                    <button
                      type="button"
                      onClick={() => setConfigDraft(d => ({ ...d, statRegimeBoostEnabled: !(merged.statRegimeBoostEnabled ?? false) }))}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.statRegimeBoostEnabled ?? false)
                        ? "bg-blue-500/20 border-blue-500/50 text-blue-300"
                        : "bg-background border-border text-muted-foreground"}`}
                    >
                      {(merged.statRegimeBoostEnabled ?? false) ? "On" : "Off"}
                    </button>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-relaxed">
                    Uses your max bet size only when the stat model confirms the coin is currently stable and trending — not choppy or spiking. All other entries use the regular bet size.
                  </span>
                  {(merged.statRegimeBoostEnabled ?? false) && (<>
                    {/* Min Efficiency Ratio */}
                    {(() => {
                      const er = merged.statRegimeBoostMinER ?? 0.40;
                      const label = er >= 0.55 ? "Strongly trending" : er >= 0.40 ? "Trending" : er >= 0.25 ? "Drifting" : "Any direction";
                      return (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            Min Trend Strength — <span className="text-blue-400 font-mono">{er.toFixed(2)}</span>
                            <span className="text-muted-foreground/50 ml-1.5 text-[10px]">({label})</span>
                          </span>
                          <input type="range" min={0.15} max={0.70} step={0.05}
                            className="accent-blue-500"
                            value={er}
                            onChange={e => setConfigDraft(d => ({ ...d, statRegimeBoostMinER: parseFloat(e.target.value) }))} />
                          <span className="text-[10px] text-muted-foreground/60">
                            Efficiency ratio: how cleanly price is moving (0 = pure chop, 1 = perfect trend). Higher = stricter.
                          </span>
                        </label>
                      );
                    })()}
                    {/* Max Oscillations */}
                    {(() => {
                      const osc = merged.statRegimeBoostMaxOscillations ?? 6;
                      return (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            Max Direction Reversals — <span className="text-blue-400 font-mono">{osc}</span>
                            <span className="text-muted-foreground/50 ml-1.5 text-[10px]">in last 15 min</span>
                          </span>
                          <input type="range" min={2} max={12} step={1}
                            className="accent-blue-500"
                            value={osc}
                            onChange={e => setConfigDraft(d => ({ ...d, statRegimeBoostMaxOscillations: parseInt(e.target.value, 10) }))} />
                          <span className="text-[10px] text-muted-foreground/60">
                            How many times price reversed direction. Lower = smoother price action required.
                          </span>
                        </label>
                      );
                    })()}
                  </>)}
                </div>
                </>)}

                {/* ── Live Mode Guards ─────────────────────────────────── */}
                <div className="col-span-full border-t border-amber-500/20 pt-3 -mt-1">
                  <span className="text-xs font-semibold text-amber-400/90 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5" /> Live Mode Guards
                  </span>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">Active in live betting only — enforced before each trade</p>
                </div>

                {/* Max Total Exposure — always visible; in conviction mode BNB alone can fill the cap */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Total Exposure ($)</span>
                  <input type="number" min={0} max={500} step={0.5}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxTotalExposure ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, maxTotalExposure: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Max total $ across all open positions at once</span>
                </label>

                {/* Max Daily Loss Per Coin — always visible (applies in all modes) */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Daily Loss / Coin ($)</span>
                  <input type="number" min={0} max={100} step={0.5}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxDailyLossPerCoin ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxDailyLossPerCoin: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Per-coin daily loss cap (0 = disabled)</span>
                </label>

                {!isConviction && (<>
                {/* Min Account Balance */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Account Balance ($)</span>
                  <input type="number" min={0} max={1000} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minAccountBalance ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, minAccountBalance: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Abort live bet if Kalshi balance drops below this</span>
                </label>

                {/* Streak Loss Limit */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Streak Loss Limit (windows)</span>
                  <input type="number" min={0} max={10} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.coinStreakLossLimit ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, coinStreakLossLimit: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Consecutive losses before this coin pauses (0 = off)</span>
                </label>

                {/* Streak Pause Windows */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Streak Pause (windows)</span>
                  <input type="number" min={1} max={10} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.coinStreakPauseWindows ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, coinStreakPauseWindows: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">How many windows to skip after the streak limit fires</span>
                </label>

                {/* Streak Confidence Penalty — 1 loss */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Streak Penalty · 1 Loss ({merged.coinStreakPenalty1LossPp ?? 6}pp — 0 = off)
                  </span>
                  <input type="range" min={0} max={30} step={1}
                    className="mt-1 accent-amber-400"
                    value={merged.coinStreakPenalty1LossPp ?? 6}
                    onChange={e => setConfigDraft(d => ({ ...d, coinStreakPenalty1LossPp: parseInt(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0 (off)</span><span>30pp</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    Raises the required confidence floor by this amount when a coin has exactly 1 consecutive loss. 0 disables.
                  </span>
                </label>

                {/* Streak Confidence Penalty — 2+ losses */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Streak Penalty · 2+ Losses ({merged.coinStreakPenalty2PlusLossPp ?? 12}pp — 0 = off)
                  </span>
                  <input type="range" min={0} max={30} step={1}
                    className="mt-1 accent-amber-400"
                    value={merged.coinStreakPenalty2PlusLossPp ?? 12}
                    onChange={e => setConfigDraft(d => ({ ...d, coinStreakPenalty2PlusLossPp: parseInt(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0 (off)</span><span>30pp</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    Raises the required confidence floor by this amount when a coin has 2 or more consecutive losses. 0 disables.
                  </span>
                </label>

                {/* Max Slippage Cents */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Slippage (¢)</span>
                  <input type="number" min={0} max={50} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxSlippageCents ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, maxSlippageCents: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Fill vs expected price warning threshold (0 = off)</span>
                </label>

                </>)}
                {/* Min Return Multiple */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Return (×)</span>
                  <input type="number" min={1} max={10} step={0.01}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minReturnMultiple ?? 1.44}
                    onChange={e => setConfigDraft(d => ({ ...d, minReturnMultiple: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">
                    Only enter bets paying ≥ this multiple. {(() => {
                      const r = merged.minReturnMultiple ?? 1.44;
                      return r > 1 ? `${r}× = max cost ${Math.round((1 / r) * 100)}¢` : "1 = off (any cost)";
                    })()}
                  </span>
                </label>
                {/* ──────────────────────────────────────────────────────── */}

                {/* Daily Loss Limit — visible in all modes */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Daily Loss Limit ($)</span>
                  <input type="number" min={1} max={500} step={1}
                    className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.dailyLossLimit ?? 20}
                    onChange={e => setConfigDraft(d => ({ ...d, dailyLossLimit: parseFloat(e.target.value) }))} />
                </label>

                {!isConviction && (<>

                {/* Min Signals */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Signals Agreeing</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.signalThreshold ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, signalThreshold: parseInt(e.target.value) }))}>
                    <option value={2}>2 of 4</option>
                    <option value={3}>3 of 4</option>
                    <option value={4}>4 of 4</option>
                  </select>
                </label>

                {/* Min Confidence */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Confidence ({merged.minConfidence ?? 60}%)</span>
                  <input type="range" min={40} max={90} step={5}
                    className="mt-1"
                    value={merged.minConfidence ?? 60}
                    onChange={e => setConfigDraft(d => ({ ...d, minConfidence: parseInt(e.target.value) }))} />
                </label>

                </>)}
                {/* ML Veto — only shown in ML Gate mode */}
                {(merged.decisionMode ?? "classic") === "ml_gate" && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Brain className="w-3 h-3 text-sky-400" />
                      ML Veto
                    </span>
                    <span className="text-[11px] text-muted-foreground/80 leading-relaxed">
                      ML blocks a bet only when its confidence is higher than both Stat&apos;s and Claude&apos;s.
                      A low-confidence ML that merely disagrees will not override a Stat+Claude agreement.
                    </span>
                  </div>
                )}

                {/* Decision Mode — full-width row */}
                <div className="col-span-2 flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">Decision Logic</span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {([
                      { id: "classic",          label: "Classic",          desc: "Stat → Claude → ML cascade; ML boosts if it agrees" },
                      { id: "ml_gate",          label: "ML Gate",          desc: "ML leads direction; Claude is a required co-decider — disagree → SKIP" },
                      { id: "consensus",        label: "Consensus",        desc: "≥2 of [Stat, Claude, ML] must agree on the same side" },
                      { id: "unanimous",        label: "Unanimous",        desc: "All 3 of [Stat, Claude, ML] must agree — highest conviction, fewest bets" },

                      { id: "conviction",      label: "Conviction",      desc: "Fires when Kalshi's YES price hits 90¢ (BET YES) or drops to 10¢ (BET NO) — the market itself declaring 90%+ certainty in either direction." },
                    ] as { id: DecisionMode; label: string; desc: string }[]).map(m => {
                      const isSelected = (merged.decisionMode ?? "classic") === m.id;
                      const needsML = m.id === "ml_gate" || m.id === "unanimous";
                      const hasDefaults = !!modeDefaults?.[m.id];
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            const modeSpecificDefaults = modeDefaults?.[m.id] as Partial<BotConfig> | undefined;
                            setConfigDraft(d => ({
                              ...d,
                              decisionMode: m.id,
                              ...(modeSpecificDefaults ?? {}),
                            }));
                            setDefaultsAppliedFor(m.id);
                          }}
                          className={`text-left rounded-xl p-3 border transition-all ${
                            isSelected
                              ? "border-sky-500/60 bg-sky-500/10 ring-1 ring-sky-500/30"
                              : "border-border bg-background/30 hover:border-border/80 hover:bg-muted/30"
                          }`}
                        >
                          <div className={`text-xs font-semibold mb-1 ${isSelected ? "text-sky-400" : "text-foreground"}`}>
                            {m.label}
                            {isSelected && <span className="ml-1.5 text-[9px] text-sky-400/70">✓ selected</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground/80 leading-tight">{m.desc}</div>
                          {hasDefaults && !isSelected && (
                            <div className="mt-1.5 text-[9px] text-muted-foreground/50">
                              ✦ auto-configures on select
                            </div>
                          )}
                          {needsML && (
                            <div className={`mt-1.5 text-[9px] font-medium px-1.5 py-0.5 rounded inline-block ${
                              status?.mlStatus?.ready
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-amber-500/15 text-amber-400"
                            }`}>
                              ML {status?.mlStatus?.ready ? "ready" : "warming up…"}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>


                {/* Conviction Settings */}
                {isConviction && (
                  <div className="col-span-2 flex flex-col gap-2 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
                    <span className="text-xs font-medium text-violet-400 flex items-center gap-1.5">
                      <Zap className="w-3 h-3" />
                      Conviction Settings
                    </span>
                    <span className="text-[11px] text-muted-foreground/80 leading-relaxed">
                      Fires when Kalshi&apos;s contract price itself declares certainty in either direction — YES ≥ trigger (BET YES) or NO ≥ trigger meaning YES ≤ (1 − trigger) (BET NO).
                      No spot-price math. Models are soft advisors; a bet only skips if ALL available models unanimously oppose that direction.
                      Bot re-checks every 5 seconds so a cross at any point in the window is caught quickly.
                    </span>
                    <PhaseTracker onConfigSaved={saveConfig} />
                    {(() => {
                      const floor = merged.kalshiLockPrice    ?? 0.82;
                      const cap   = merged.kalshiLockPriceCap ?? 0.91;
                      const floorYes = Math.round(floor * 100);
                      const capYes   = Math.round(cap   * 100);
                      const floorNo  = Math.round((1 - cap)   * 100);
                      const capNo    = Math.round((1 - floor) * 100);
                      return (
                        <div className="flex flex-col gap-2.5 mt-1">
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">
                              Entry Floor — <span className="font-mono text-violet-400">{floorYes}¢</span>
                              <span className="text-muted-foreground/60 ml-1.5">YES ≥ {floorYes}¢ triggers BET YES · YES ≤ {capNo}¢ triggers BET NO</span>
                            </span>
                            <div className="flex items-center gap-3">
                              <input type="range" min={0.50} max={0.97} step={0.01}
                                className="flex-1 accent-violet-500"
                                value={floor}
                                onChange={e => setConfigDraft(d => ({ ...d, kalshiLockPrice: parseFloat(e.target.value) }))} />
                              <span className="text-xs font-mono text-violet-400 w-12 text-right">{floorYes}¢</span>
                            </div>
                            <span className="text-[10px] text-muted-foreground/70">
                              Minimum Kalshi YES price to fire a BET YES. Lower = more bets, lower certainty. Max YES payout: {(1 / floor).toFixed(2)}×.
                            </span>
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">
                              Entry Cap — <span className="font-mono text-violet-400">{capYes}¢</span>
                              <span className="text-muted-foreground/60 ml-1.5">YES &gt; {capYes}¢ → window missed (SKIP)</span>
                            </span>
                            <div className="flex items-center gap-3">
                              <input type="range" min={0.51} max={0.97} step={0.01}
                                className="flex-1 accent-violet-400"
                                value={cap}
                                onChange={e => setConfigDraft(d => ({ ...d, kalshiLockPriceCap: parseFloat(e.target.value) }))} />
                              <span className="text-xs font-mono text-violet-400 w-12 text-right">{capYes}¢</span>
                            </div>
                            <span className="text-[10px] text-muted-foreground/70">
                              Maximum allowed Kalshi YES price. Above this the margin is too thin — bet is skipped. Entry zone: <span className="text-violet-400/80">{floorYes}¢–{capYes}¢ YES</span> · <span className="text-violet-400/60">{floorNo}¢–{capNo}¢ NO</span>.
                            </span>
                          </label>
                        </div>
                      );
                    })()}

                    {/* Allow Late Entries */}
                    <div className="flex items-center justify-between mt-1">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">Allow Late Entries</span>
                        <span className="text-[10px] text-muted-foreground/60 leading-relaxed">
                          When on, all time-floor guards are removed — the bot can enter right up to settlement.
                          Designed for conviction mode where the price crossing happens near window close.
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, allowLateEntries: !(merged.allowLateEntries ?? false) }))}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.allowLateEntries ?? false)
                          ? "bg-violet-500/20 border-violet-500/40 text-violet-300"
                          : "bg-muted/30 border-border text-muted-foreground"}`}
                      >
                        {(merged.allowLateEntries ?? false) ? "On" : "Off"}
                      </button>
                    </div>

                    {/* Min Time Remaining — only relevant when Allow Late Entries is off */}
                    {!(merged.allowLateEntries ?? false) && (
                      <label className="flex flex-col gap-1.5 mt-1">
                        <span className="text-xs text-muted-foreground">No Entry In Last X Min</span>
                        <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                          value={merged.minRemainingMinutes ?? 1}
                          onChange={e => setConfigDraft(d => ({ ...d, minRemainingMinutes: parseInt(e.target.value) }))}>
                          <option value={0}>No floor — enter even in the final minute</option>
                          {[1, 2, 3, 4, 5, 6, 7].map(m => (
                            <option key={m} value={m}>Block last {m} min of window</option>
                          ))}
                        </select>
                        <span className="text-[10px] text-muted-foreground/60">
                          Prevents entries when fewer than this many minutes remain. Enable Allow Late Entries above to remove this guard entirely.
                        </span>
                      </label>
                    )}

                    {/* Min Entry Wait */}
                    {(() => {
                      const minEntry = merged.convictionMinEntryMinutes ?? 0;
                      return (
                        <label className="flex flex-col gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-2">
                            Min Entry Wait —{" "}
                            {minEntry === 0
                              ? <span className="text-muted-foreground/50">No minimum</span>
                              : <span className="text-amber-400 font-mono">Wait {minEntry} min before first bet</span>}
                          </span>
                          <div className="flex items-center gap-3">
                            <input type="range" min={0} max={12} step={1}
                              className="flex-1 accent-amber-500"
                              value={minEntry}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionMinEntryMinutes: parseInt(e.target.value, 10) }))} />
                            <span className="text-xs font-mono w-20 text-right">
                              {minEntry === 0
                                ? <span className="text-muted-foreground/50">Off</span>
                                : <span className="text-amber-400">min {minEntry}</span>}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground/70">
                            {minEntry === 0
                              ? "Bot starts watching for price crossing immediately when window opens."
                              : `Bot waits ${minEntry} minute${minEntry !== 1 ? 's' : ''} after window open before placing any conviction bet. Useful to let the market settle before committing.`}
                          </span>
                        </label>
                      );
                    })()}

                    {/* Stop-loss floor */}
                    {(() => {
                      const floor = merged.convictionStopLossFloor ?? 0;
                      const floorPct = Math.round(floor * 100);
                      return (
                        <label className="flex flex-col gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-2">
                            Stop-Loss Floor —{" "}
                            {floor === 0
                              ? <span className="text-muted-foreground/50">Disabled</span>
                              : <span className="text-red-400 font-mono">Sell if contract drops to {floorPct}¢</span>}
                          </span>
                          <div className="flex items-center gap-3">
                            <input type="range" min={0} max={0.80} step={0.05}
                              className="flex-1 accent-red-500"
                              value={floor}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionStopLossFloor: parseFloat(e.target.value) }))} />
                            <span className="text-xs font-mono w-20 text-right">
                              {floor === 0
                                ? <span className="text-muted-foreground/50">Off</span>
                                : <span className="text-red-400">{floorPct}¢ floor</span>}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground/70">
                            {floor === 0
                              ? "No automatic exit — position holds until window close."
                              : `Auto-sell if the contract you hold drops to ${floorPct}¢ or below. Skipped if the contract is already at or near 0¢ (no recovery value). Checked every 5 seconds.`}
                          </span>
                        </label>
                      );
                    })()}

                    {/* Stop-loss activation minute */}
                    {(merged.convictionStopLossFloor ?? 0) > 0 && (() => {
                      const actMin = merged.convictionStopLossActivationMinute ?? 12;
                      const remaining = 15 - actMin;
                      return (
                        <label className="flex flex-col gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-2">
                            Stop-Loss Arm Time —{" "}
                            {actMin === 0
                              ? <span className="text-amber-400 font-mono">Armed immediately</span>
                              : <span className="text-orange-400 font-mono">Arms at minute {actMin} (last {remaining} min)</span>}
                          </span>
                          <div className="flex items-center gap-3">
                            <input type="range" min={0} max={13} step={1}
                              className="flex-1 accent-orange-500"
                              value={actMin}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionStopLossActivationMinute: parseInt(e.target.value, 10) }))} />
                            <span className="text-xs font-mono w-20 text-right text-orange-400">
                              min {actMin}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground/70">
                            {actMin === 0
                              ? "Stop-loss fires at any point in the window. Early dips may trigger false exits."
                              : `Stop-loss only arms after minute ${actMin} — ignores dips in the first ${actMin} min when prices can still recover.`}
                          </span>
                        </label>
                      );
                    })()}

                    {/* Conviction daily loss limit */}
                    <label className="flex flex-col gap-1.5 mt-1">
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <DollarSign className="w-3 h-3 text-red-400" />
                        Daily Loss Limit ($)
                      </span>
                      <input type="number" min={1} max={500} step={1}
                        className="bg-background border border-red-500/30 rounded-md px-3 py-1.5 text-sm text-foreground"
                        value={merged.convictionDailyLossLimit ?? 50}
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v) && v > 0) setConfigDraft(d => ({ ...d, convictionDailyLossLimit: v }));
                        }} />
                      <span className="text-[10px] text-muted-foreground/60">
                        Bot pauses for the day once net losses hit this amount. Separate from the global daily loss limit.
                      </span>
                    </label>

                    {/* Conviction daily spend limit */}
                    <label className="flex flex-col gap-1.5 mt-1">
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <DollarSign className="w-3 h-3 text-amber-400" />
                        Daily Total Spend Limit ($)
                        {(merged.convictionMaxDailySpend ?? 0) === 0 && (
                          <span className="text-muted-foreground/50 text-[10px]">— disabled</span>
                        )}
                      </span>
                      <input type="number" min={0} max={10000} step={5}
                        className="bg-background border border-amber-500/30 rounded-md px-3 py-1.5 text-sm text-foreground"
                        value={merged.convictionMaxDailySpend ?? 0}
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          setConfigDraft(d => ({ ...d, convictionMaxDailySpend: Number.isNaN(v) || v <= 0 ? undefined : v }));
                        }} />
                      <span className="text-[10px] text-muted-foreground/60">
                        Hard cap on total $ placed as bets today (wins don't reduce this — it only goes up). 0 = no limit.
                      </span>
                    </label>

                    {/* Catastrophic fill threshold */}
                    {(() => {
                      const raw = merged.convictionCatastrophicFillThresholdCents ?? 15;
                      return (
                        <label className="flex flex-col gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <AlertTriangle className="w-3 h-3 text-red-400" />
                            Catastrophic Fill Threshold (¢)
                            {raw === 0 && (
                              <span className="text-muted-foreground/50 text-[10px]">— emergency close disabled</span>
                            )}
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={50}
                            step={1}
                            className="bg-background border border-red-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                            value={raw}
                            onChange={e => {
                              const v = parseInt(e.target.value, 10);
                              setConfigDraft(d => ({ ...d, convictionCatastrophicFillThresholdCents: Number.isNaN(v) || v < 0 ? 0 : v }));
                            }}
                          />
                          <span className="text-[10px] text-muted-foreground/60 leading-relaxed">
                            {raw === 0
                              ? "Emergency close is disabled — all fills are held to settlement regardless of price."
                              : `Fills more than ${raw}¢ below the zone floor trigger an immediate emergency close instead of holding to settlement. Default: 15¢.`}
                          </span>
                        </label>
                      );
                    })()}

                    {/* Strike Proximity Guard */}
                    <div className="flex flex-col gap-2 mt-2 border-t border-violet-500/10 pt-2">
                      <span className="text-[11px] font-medium text-sky-300 flex items-center gap-1.5">
                        <Activity className="w-3 h-3" />
                        Strike Proximity Guard
                      </span>
                      <span className="text-[10px] text-muted-foreground/70 leading-relaxed">
                        Blocks a FOK when the live crypto price is within <span className="text-sky-400 font-mono">{((merged.strikeProximityMinPct ?? 0.30)).toFixed(2)}%</span> of the Kalshi strike — too close means a single adverse candle can flip the outcome. Fail-open: passes when price data is unavailable.
                        {(merged.strikeProximityAtrScale ?? true) && <span className="text-sky-400/70"> Threshold is ATR-scaled (wider for volatile coins).</span>}
                      </span>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          Min Gap% <span className="font-mono text-sky-400">{(merged.strikeProximityMinPct ?? 0.30).toFixed(2)}%</span>
                        </span>
                        <input
                          type="number"
                          min={0.01}
                          max={2.00}
                          step={0.01}
                          className="bg-background border border-sky-500/20 rounded-md px-3 py-1.5 text-sm text-foreground w-28"
                          value={merged.strikeProximityMinPct ?? 0.05}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            if (!Number.isNaN(v) && v >= 0.01 && v <= 2.00) {
                              setConfigDraft(d => ({ ...d, strikeProximityMinPct: v }));
                            }
                          }}
                        />
                        <span className="text-[10px] text-muted-foreground/60">|livePrice − strike| / strike × 100. Default: 0.05%. Range: 0.01–2.00%.</span>
                      </label>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-xs text-muted-foreground">ATR Scale</span>
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, strikeProximityAtrScale: !(merged.strikeProximityAtrScale ?? true) }))}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.strikeProximityAtrScale ?? true)
                            ? "bg-sky-500/15 text-sky-400 border-sky-500/30 hover:bg-sky-500/25"
                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"}`}
                        >
                          {(merged.strikeProximityAtrScale ?? true) ? "On" : "Off"}
                        </button>
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 leading-relaxed">When on: threshold × max(1, volPct/0.20). High-volatility coins require a wider gap. Baseline 0.20% = typical BTC quiet session.</span>

                      {/* Per-coin threshold overrides */}
                      {(() => {
                        const COINS = ["BTC","ETH","XRP","BNB","SOL","DOGE","NEAR","HYPE","ZEC"];
                        const SUGGESTED: Record<string,number> = { BTC:0.02, ETH:0.02, XRP:0.03, BNB:0.03, SOL:0.03, DOGE:0.04, NEAR:0.04, HYPE:0.05, ZEC:0.05 };
                        const overrides: Record<string,number> = { ...(merged.strikeProximityMinPctOverrides ?? {}) };
                        const globalFloor = merged.strikeProximityMinPct ?? 0.30;
                        return (
                          <div className="mt-2">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[11px] font-medium text-sky-300/80">Per-coin thresholds</span>
                              <button
                                type="button"
                                className="text-[10px] text-sky-400/70 hover:text-sky-400 underline"
                                onClick={() => {
                                  setConfigDraft(d => ({ ...d, strikeProximityMinPctOverrides: { ...SUGGESTED } }));
                                }}
                              >
                                Apply suggested
                              </button>
                            </div>
                            <span className="text-[9.5px] text-muted-foreground/50 block mb-2 leading-relaxed">
                              Overrides the global threshold for each coin. Leave blank to use the global floor ({globalFloor.toFixed(2)}%). Suggested values are derived from each coin's typical 15-min ATR and Kalshi orderbook depth.
                            </span>
                            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
                              {COINS.map(sym => {
                                const currentVal = overrides[sym];
                                const suggested  = SUGGESTED[sym];
                                return (
                                  <div key={sym} className="flex flex-col gap-0.5">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] font-mono text-foreground/80">{sym}</span>
                                      {currentVal != null ? (
                                        <button
                                          type="button"
                                          className="text-[9px] text-muted-foreground/50 hover:text-red-400"
                                          title="Clear override (use global)"
                                          onClick={() => {
                                            setConfigDraft(d => {
                                              const next = {
                                                ...(merged.strikeProximityMinPctOverrides ?? {}),
                                                ...(d.strikeProximityMinPctOverrides ?? {}),
                                              };
                                              delete next[sym];
                                              return { ...d, strikeProximityMinPctOverrides: next };
                                            });
                                          }}
                                        >×</button>
                                      ) : (
                                        <span className="text-[9px] text-muted-foreground/30">global</span>
                                      )}
                                    </div>
                                    <input
                                      type="number"
                                      min={0.01}
                                      max={3.00}
                                      step={0.01}
                                      placeholder={`${(suggested ?? globalFloor).toFixed(2)}`}
                                      className={`w-full bg-background border rounded px-1.5 py-1 text-[11px] font-mono text-foreground ${currentVal != null ? "border-sky-500/30 text-sky-400" : "border-border/50 text-muted-foreground"}`}
                                      value={currentVal != null ? currentVal : ""}
                                      onChange={e => {
                                        const raw = e.target.value.trim();
                                        const v = parseFloat(raw);
                                        setConfigDraft(d => {
                                          const next = {
                                            ...(merged.strikeProximityMinPctOverrides ?? {}),
                                            ...(d.strikeProximityMinPctOverrides ?? {}),
                                          };
                                          if (raw === "" || Number.isNaN(v)) {
                                            delete next[sym];
                                          } else if (v >= 0.01 && v <= 3.00) {
                                            next[sym] = v;
                                          }
                                          return { ...d, strikeProximityMinPctOverrides: next };
                                        });
                                      }}
                                    />
                                    <span className="text-[9px] text-muted-foreground/40">sugg: {(suggested ?? globalFloor).toFixed(2)}%</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Direction Guard */}
                    <div className="flex flex-col gap-2 mt-2 border-t border-violet-500/10 pt-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-sky-300 flex items-center gap-1.5">
                          <TrendingUp className="w-3 h-3" />
                          Direction Guard
                        </span>
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, convictionDirectionGuardEnabled: !(merged.convictionDirectionGuardEnabled ?? true) }))}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.convictionDirectionGuardEnabled ?? true)
                            ? "bg-sky-500/15 text-sky-400 border-sky-500/30 hover:bg-sky-500/25"
                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"}`}
                        >
                          {(merged.convictionDirectionGuardEnabled ?? true) ? "On" : "Off"}
                        </button>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70 leading-relaxed">
                        Blocks entry when price has been falling continuously for N seconds toward the strike. Measures second-by-second from the live 1 s poller — a single noisy tick will not trigger it.
                      </span>
                      {(merged.convictionDirectionGuardEnabled ?? true) && (
                        <div className="flex flex-col gap-2 mt-1">
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">Min adverse seconds to block</span>
                            <select
                              className="bg-background border border-sky-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                              value={merged.convictionDirectionGuardMinSeconds ?? 4}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionDirectionGuardMinSeconds: parseInt(e.target.value) }))}
                            >
                              {[2,3,4,5,6,7,8,9,10].map(n => (
                                <option key={n} value={n}>{n}s consecutive{n === 4 ? " — default" : n <= 3 ? " — sensitive" : n >= 7 ? " — permissive" : ""}</option>
                              ))}
                            </select>
                            <span className="text-[10px] text-muted-foreground/60">Price must move toward the strike for this many seconds in a row before the entry is blocked. Lower = blocks sooner; higher = only blocks sustained slides.</span>
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground/80">Candle fallback lookback</span>
                            <select
                              className="bg-background border border-sky-500/20 rounded-md px-3 py-1.5 text-sm text-foreground/80"
                              value={merged.convictionDirectionLookbackCandles ?? 3}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionDirectionLookbackCandles: parseInt(e.target.value) }))}
                            >
                              {[1,2,3,4,5].map(n => (
                                <option key={n} value={n}>{n} candle{n > 1 ? "s" : ""}{n === 3 ? " — default" : ""}</option>
                              ))}
                            </select>
                            <span className="text-[10px] text-muted-foreground/50">Used only in the first few seconds of a window before tick data is available. Has no effect once live ticks are flowing.</span>
                          </label>
                        </div>
                      )}
                    </div>

                    {/* Candle-slope gate */}
                    {(merged.convictionDirectionGuardEnabled ?? true) && (
                      <div className="flex flex-col gap-2 mt-2 border-t border-sky-500/10 pt-2">
                        <span className="text-[11px] font-medium text-sky-300/80 flex items-center gap-1.5">
                          <TrendingUp className="w-3 h-3 opacity-60" />
                          Candle-slope gate
                        </span>
                        <span className="text-[10px] text-muted-foreground/70 leading-relaxed">
                          Checks the last N minute-candles for a sustained prior trend against your bet — catches a 5-minute decline even when price goes flat in the final 7 seconds before entry. Binary like the tick gate: any real directional move over N candles exceeds the 0.01% noise floor and blocks.
                        </span>
                        <div className="flex flex-col gap-2">
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">Candle lookback</span>
                            <select
                              className="bg-background border border-sky-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                              value={merged.convictionCandleLookback ?? 5}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionCandleLookback: parseInt(e.target.value) }))}
                            >
                              {[2,3,4,5,6,7,8,9,10].map(n => (
                                <option key={n} value={n}>{n} min{n === 5 ? " — default" : n <= 3 ? " — tight" : n >= 8 ? " — wide" : ""}</option>
                              ))}
                            </select>
                            <span className="text-[10px] text-muted-foreground/60">How many 1-minute candles to look back when measuring the prior trend. Default 5 = last 5 minutes.</span>
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">Slope threshold (%)</span>
                            <select
                              className="bg-background border border-sky-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                              value={merged.convictionCandleSlopeThresholdPct ?? 0.01}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionCandleSlopeThresholdPct: parseFloat(e.target.value) }))}
                            >
                              {[0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20].map(v => (
                                <option key={v} value={v}>{v.toFixed(2)}%{v === 0.01 ? " — default" : v <= 0.03 ? " — sensitive" : v >= 0.10 ? " — permissive" : ""}</option>
                              ))}
                            </select>
                            <span className="text-[10px] text-muted-foreground/60">Minimum net price move over the lookback period to block entry. 0.01% is a sub-penny noise floor — any real directional move exceeds it.</span>
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">ATR scaling</span>
                            <button
                              type="button"
                              onClick={() => setConfigDraft(d => ({ ...d, convictionCandleAtrScaleEnabled: !(merged.convictionCandleAtrScaleEnabled ?? false) }))}
                              className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors ${(merged.convictionCandleAtrScaleEnabled ?? false)
                                ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                                : "bg-background border-border text-muted-foreground"}`}
                            >
                              {(merged.convictionCandleAtrScaleEnabled ?? false) ? "On — threshold widens for volatile coins" : "Off — flat threshold (default)"}
                            </button>
                            <span className="text-[10px] text-muted-foreground/60">Off is recommended: for a direction gate, a volatile coin moving adversely is MORE dangerous, not less. ATR scaling widens the threshold for the very coins that need stricter blocking.</span>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* Stability Gate */}
                    <div className="flex flex-col gap-2 mt-2 border-t border-violet-500/10 pt-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-violet-300 flex items-center gap-1.5">
                          <Zap className="w-3 h-3" />
                          Stability Gate
                        </span>
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, convictionStabilityEnabled: !(merged.convictionStabilityEnabled ?? true) }))}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.convictionStabilityEnabled ?? true)
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"}`}
                        >
                          {(merged.convictionStabilityEnabled ?? true) ? "On" : "Off"}
                        </button>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70 leading-relaxed">
                        Classifies each coin as stable or volatile every tick using stat model + ML metrics. Stable coins bet max size; volatile coins use regular bet size. Deterministic — no random rolls.
                      </span>
                      {/* Boost bet size */}
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <DollarSign className="w-3 h-3 text-violet-400" />
                          Stable Bet Size ($)
                          {(merged.convictionBoostBetSize ?? 0) === 0 && (
                            <span className="text-muted-foreground/50 text-[10px]">— uses Max Bet Size</span>
                          )}
                        </span>
                        <input type="number" min={0} max={100} step={1}
                          className="bg-background border border-violet-500/30 rounded-md px-3 py-1.5 text-sm text-foreground"
                          value={merged.convictionBoostBetSize ?? 0}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            setConfigDraft(d => ({ ...d, convictionBoostBetSize: Number.isNaN(v) || v <= 0 ? undefined : v }));
                          }} />
                        <span className="text-[10px] text-muted-foreground/60">
                          Dollar amount for stable-market bets. Leave at 0 to use the global Max Bet Size.
                        </span>
                      </label>
                      {(merged.convictionStabilityEnabled ?? true) && (<>
                        {/* Min ER */}
                        {(() => {
                          const er = merged.convictionStabilityMinER ?? 0.12;
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground">
                                Min Efficiency Ratio — <span className="text-violet-400 font-mono">{er.toFixed(2)}</span>
                              </span>
                              <input type="range" min={0.05} max={0.40} step={0.01}
                                className="accent-violet-500"
                                value={er}
                                onChange={e => setConfigDraft(d => ({ ...d, convictionStabilityMinER: parseFloat(e.target.value) }))} />
                              <span className="text-[10px] text-muted-foreground/60">
                                ER = |net move| ÷ total path in last 15 min. Typical crypto values: 0.05–0.25. 0.12 = gentle bias; 0.20+ = strong trend required.
                              </span>
                            </label>
                          );
                        })()}
                        {/* Max oscillations */}
                        {(() => {
                          const osc = merged.convictionStabilityMaxOsc ?? 8;
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground">
                                Max Oscillations — <span className="text-amber-400 font-mono">{osc}</span>
                              </span>
                              <input type="range" min={2} max={14} step={1}
                                className="accent-amber-500"
                                value={osc}
                                onChange={e => setConfigDraft(d => ({ ...d, convictionStabilityMaxOsc: parseInt(e.target.value, 10) }))} />
                              <span className="text-[10px] text-muted-foreground/60">
                                Direction reversals in last 15 min. Fewer = choppier market classified volatile.
                              </span>
                            </label>
                          );
                        })()}
                        {/* Max vol% */}
                        {(() => {
                          const vol = merged.convictionStabilityMaxVolPct ?? 0.15;
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground">
                                Max Volatility % — <span className="text-red-400 font-mono">{vol.toFixed(2)}%</span>
                              </span>
                              <input type="range" min={0.02} max={0.50} step={0.01}
                                className="accent-red-500"
                                value={vol}
                                onChange={e => setConfigDraft(d => ({ ...d, convictionStabilityMaxVolPct: parseFloat(e.target.value) }))} />
                              <span className="text-[10px] text-muted-foreground/60">
                                1-min log-return std dev. Typical calm crypto: 0.03–0.08%. 0.15% = loose; 0.06% = strict. Coins above this are volatile regardless of ER/osc.
                              </span>
                            </label>
                          );
                        })()}
                        {/* Min ML conf */}
                        {(() => {
                          const mlConf = merged.convictionStabilityMinMLConf ?? 52;
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground">
                                Min ML Confidence — <span className="text-blue-400 font-mono">{mlConf}%</span>
                              </span>
                              <input type="range" min={50} max={70} step={1}
                                className="accent-blue-500"
                                value={mlConf}
                                onChange={e => setConfigDraft(d => ({ ...d, convictionStabilityMinMLConf: parseInt(e.target.value, 10) }))} />
                              <span className="text-[10px] text-muted-foreground/60">
                                ML model confidence floor. Coins with ML confidence below this are classified volatile. Coins with no ML signal pass this check.
                              </span>
                            </label>
                          );
                        })()}
                        {/* Max bet probability */}
                        {(() => {
                          const prob = merged.convictionStabilityMaxBetProbability ?? 0.25;
                          const pct = Math.round(prob * 100);
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                <Zap className="w-3 h-3 text-emerald-400" />
                                Max bet chance — <span className="text-emerald-400 font-mono">{pct}% chance per window</span>
                              </span>
                              <input type="range" min={0} max={100} step={5}
                                className="accent-emerald-500"
                                value={pct}
                                onChange={e => setConfigDraft(d => ({ ...d, convictionStabilityMaxBetProbability: parseInt(e.target.value, 10) / 100 }))} />
                              <span className="text-[10px] text-muted-foreground/60">
                                Rolled once per window. If it hits, the first stable qualifying coin gets max bet size — all others use regular size regardless.
                              </span>
                            </label>
                          );
                        })()}
                        {/* Max bet slots per window */}
                        {(() => {
                          const slots = merged.convictionStabilityMaxBetsPerWindow ?? 1;
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                <Zap className="w-3 h-3 text-emerald-400" />
                                Max bet slots per window — <span className="text-emerald-400 font-mono">{slots} slot{slots !== 1 ? "s" : ""}</span>
                              </span>
                              <input type="range" min={1} max={3} step={1}
                                className="accent-emerald-500"
                                value={slots}
                                onChange={e => setConfigDraft(d => ({ ...d, convictionStabilityMaxBetsPerWindow: parseInt(e.target.value, 10) }))} />
                              <span className="text-[10px] text-muted-foreground/60">
                                How many coins can claim max-bet size in a single window when the roll hits. Set above 1 only for high-conviction windows.
                              </span>
                            </label>
                          );
                        })()}
                        {/* Max-bet entry timing gate */}
                        {(() => {
                          const gate = merged.maxBetMinWindowEntryMinutes ?? 0;
                          return (
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                <Zap className="w-3 h-3 text-amber-400" />
                                Max-Bet Entry Wait
                                {gate > 0 && (
                                  <span className="ml-1 text-amber-400 font-mono">T+{gate}m</span>
                                )}
                              </span>
                              <select className="bg-background border border-violet-500/30 rounded-md px-3 py-1.5 text-sm text-foreground"
                                value={gate}
                                onChange={e => setConfigDraft(d => ({ ...d, maxBetMinWindowEntryMinutes: parseInt(e.target.value, 10) }))}>
                                <option value={0}>No wait — max bet allowed immediately</option>
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                                  <option key={m} value={m}>Wait until T+{m} min</option>
                                ))}
                              </select>
                              <span className="text-[10px] text-muted-foreground/60">
                                Max-size bets are blocked until this many minutes into the window. If STABLE but the gate hasn't elapsed, the bot falls back to regular size — the token is not consumed.
                              </span>
                            </label>
                          );
                        })()}
                        <StabilityPreview
                          minER={merged.convictionStabilityMinER ?? 0.12}
                          maxOsc={merged.convictionStabilityMaxOsc ?? 8}
                          maxVolPct={merged.convictionStabilityMaxVolPct ?? 0.15}
                          minMLConf={merged.convictionStabilityMinMLConf ?? 52}
                        />
                      </>)}
                    </div>

                    {/* ── Extreme Caution ──────────────────────────────────── */}
                    <div className="flex flex-col gap-2 mt-2 border-t border-orange-500/15 pt-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-orange-300 flex items-center gap-1.5">
                          <Shield className="w-3 h-3" />
                          Extreme Caution
                        </span>
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, extremeCautionEnabled: !(merged.extremeCautionEnabled ?? false) }))}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.extremeCautionEnabled ?? false)
                            ? "bg-orange-500/15 text-orange-400 border-orange-500/30 hover:bg-orange-500/25"
                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"}`}
                        >
                          {(merged.extremeCautionEnabled ?? false) ? "On" : "Off"}
                        </button>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70 leading-relaxed">
                        When on: (1) if a YES conviction bet is aborted this window because the YES bid dropped below the zone floor, all further YES re-entries for that coin are blocked for the rest of the window; (2) the NO cross-check uses zero tolerance instead of the normal +1¢ spread allowance.
                      </span>
                      <label className="flex flex-col gap-1 mt-0.5">
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <DollarSign className="w-3 h-3 text-orange-400" />
                          Bet Override ($)
                          {((merged.extremeCautionBetOverride ?? 0) === 0) && (
                            <span className="text-muted-foreground/50 text-[10px]">— uses normal sizing</span>
                          )}
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.5}
                          disabled={!(merged.extremeCautionEnabled ?? false)}
                          className={`border rounded-md px-3 py-1.5 text-sm w-32 transition-opacity ${(merged.extremeCautionEnabled ?? false)
                            ? "bg-background border-orange-500/30 text-foreground"
                            : "bg-muted/30 border-border text-muted-foreground opacity-50 cursor-not-allowed"}`}
                          value={merged.extremeCautionBetOverride ?? 0}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            setConfigDraft(d => ({ ...d, extremeCautionBetOverride: Number.isNaN(v) || v <= 0 ? null : v }));
                          }}
                        />
                        <span className="text-[10px] text-muted-foreground/60">
                          When &gt; 0, every conviction bet uses this fixed $ amount (only when no time bracket matches). 0 = no override.
                        </span>
                      </label>
                    </div>

                  </div>
                )}

                {/* Time-Based Bet Schedule — visible for all modes */}
                <div className="col-span-2 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-sky-300 flex items-center gap-1.5">
                      <Clock className="w-3 h-3" />
                      Time-Based Bet Schedule
                    </span>
                    <button
                      type="button"
                      onClick={() => setConfigDraft(d => ({ ...d, timeBetScheduleEnabled: !(merged.timeBetScheduleEnabled ?? false) }))}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.timeBetScheduleEnabled ?? false)
                        ? "bg-sky-500/15 text-sky-400 border-sky-500/30 hover:bg-sky-500/25"
                        : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"}`}
                    >
                      {(merged.timeBetScheduleEnabled ?? false) ? "On" : "Off"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 -mt-1">
                    Override bet size based on how far into the window the entry fires. The bracket with the highest minute threshold ≤ current elapsed minutes wins. Falls through to normal sizing when no bracket matches. In conviction mode, the Extreme Caution bet override takes priority over this.
                  </p>
                  {(() => {
                    const schedule = (configDraft.timeBetSchedule !== undefined ? configDraft.timeBetSchedule : merged.timeBetSchedule) ?? [];
                    return (
                      <div className="flex flex-col gap-1.5">
                        {schedule.length === 0 && (
                          <span className="text-[10px] text-muted-foreground/50 italic">No brackets yet — add one below.</span>
                        )}
                        {schedule.map((bracket, i) => (
                          <div key={i} className="flex items-center gap-2 bg-muted/20 border border-sky-500/15 rounded-md px-2 py-1.5">
                            <span className="text-[10px] text-sky-400/70 shrink-0">≥ min</span>
                            <input
                              type="number"
                              min={0}
                              max={14}
                              step={1}
                              value={bracket.minutesElapsed}
                              className="w-12 bg-background border border-sky-500/30 rounded px-1.5 py-0.5 text-xs text-foreground text-center"
                              onChange={e => {
                                const v = parseInt(e.target.value, 10);
                                if (Number.isNaN(v)) return;
                                setConfigDraft(d => {
                                  const cur = d.timeBetSchedule !== undefined ? d.timeBetSchedule : (merged.timeBetSchedule ?? []);
                                  return { ...d, timeBetSchedule: cur.map((b, j) => j === i ? { ...b, minutesElapsed: Math.min(14, Math.max(0, v)) } : b) };
                                });
                              }}
                            />
                            <span className="text-[10px] text-muted-foreground/50">→</span>
                            <span className="text-[10px] text-sky-400/70 shrink-0">$</span>
                            <input
                              type="number"
                              min={0.5}
                              max={100}
                              step={0.5}
                              value={bracket.betAmount}
                              className="w-16 bg-background border border-sky-500/30 rounded px-1.5 py-0.5 text-xs text-foreground"
                              onChange={e => {
                                const v = parseFloat(e.target.value);
                                if (Number.isNaN(v)) return;
                                setConfigDraft(d => {
                                  const cur = d.timeBetSchedule !== undefined ? d.timeBetSchedule : (merged.timeBetSchedule ?? []);
                                  return { ...d, timeBetSchedule: cur.map((b, j) => j === i ? { ...b, betAmount: v } : b) };
                                });
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setConfigDraft(d => {
                                const cur = d.timeBetSchedule !== undefined ? d.timeBetSchedule : (merged.timeBetSchedule ?? []);
                                return { ...d, timeBetSchedule: cur.filter((_, j) => j !== i) };
                              })}
                              className="ml-auto text-red-400/50 hover:text-red-400 transition-colors"
                              title="Remove bracket"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => {
                            const cur = d.timeBetSchedule !== undefined ? d.timeBetSchedule : (merged.timeBetSchedule ?? []);
                            const usedMins = cur.map(b => b.minutesElapsed);
                            const nextMin = usedMins.length > 0 ? Math.min(14, Math.max(...usedMins) + 1) : 0;
                            return { ...d, timeBetSchedule: [...cur, { minutesElapsed: nextMin, betAmount: merged.betSize ?? 0.5 }] };
                          })}
                          className="self-start text-[10px] text-sky-400/70 hover:text-sky-400 border border-sky-500/30 hover:border-sky-400/60 rounded px-2 py-1 transition-colors"
                        >
                          + Add bracket
                        </button>
                        <span className="text-[10px] text-muted-foreground/50">
                          Example: bracket at min 0 → $1, min 8 → $2 means first 8 min bets $1, after minute 8 bets $2.
                        </span>
                      </div>
                    );
                  })()}
                </div>

                {/* Bet Amount Randomizer */}
                <div className="col-span-2 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <DollarSign className="w-3 h-3 text-amber-400" />
                      Bet Amount Randomizer
                    </span>
                    <button
                      type="button"
                      onClick={() => setConfigDraft(d => ({ ...d, betRandomizerEnabled: !(merged.betRandomizerEnabled ?? false) }))}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.betRandomizerEnabled ?? false)
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25"
                        : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"}`}
                    >
                      {(merged.betRandomizerEnabled ?? false) ? "On" : "Off"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 -mt-1">
                    Each bet independently picks a random dollar amount from the list below. Overrides all other bet sizing (bet size, max bet size, conviction boost, time schedule). Per-coin max bet limits in Bot Config still apply as a ceiling.
                  </p>
                  {(merged.betRandomizerEnabled ?? false) && (configDraft.betRandomizerValues !== undefined ? configDraft.betRandomizerValues : (merged.betRandomizerValues ?? [])).length < 2 && (
                    <p className="text-[10px] text-amber-400 font-medium -mt-1">
                      ⚠ Add at least 2 values to activate the randomizer.
                    </p>
                  )}
                  {(() => {
                    const values = (configDraft.betRandomizerValues !== undefined ? configDraft.betRandomizerValues : merged.betRandomizerValues) ?? [];
                    return (
                      <div className="flex flex-col gap-1.5">
                        {values.length === 0 && (
                          <span className="text-[10px] text-muted-foreground/50 italic">No values yet — add some below.</span>
                        )}
                        {values.map((val, i) => (
                          <div key={i} className="flex items-center gap-2 bg-muted/20 border border-amber-500/15 rounded-md px-2 py-1.5">
                            <span className="text-[10px] text-amber-400/70 shrink-0">$</span>
                            <input
                              type="number"
                              min={0.5}
                              max={100}
                              step={0.5}
                              value={val}
                              className="w-20 bg-background border border-amber-500/30 rounded px-1.5 py-0.5 text-xs text-foreground"
                              onChange={e => {
                                const v = parseFloat(e.target.value);
                                if (Number.isNaN(v)) return;
                                setConfigDraft(d => {
                                  const cur = d.betRandomizerValues !== undefined ? d.betRandomizerValues : (merged.betRandomizerValues ?? []);
                                  return { ...d, betRandomizerValues: cur.map((x, j) => j === i ? Math.max(0.5, Math.min(100, v)) : x) };
                                });
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setConfigDraft(d => {
                                const cur = d.betRandomizerValues !== undefined ? d.betRandomizerValues : (merged.betRandomizerValues ?? []);
                                return { ...d, betRandomizerValues: cur.filter((_, j) => j !== i) };
                              })}
                              className="ml-auto text-red-400/50 hover:text-red-400 transition-colors"
                              title="Remove value"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => {
                            const cur = d.betRandomizerValues !== undefined ? d.betRandomizerValues : (merged.betRandomizerValues ?? []);
                            return { ...d, betRandomizerValues: [...cur, merged.betSize ?? 1] };
                          })}
                          className="self-start text-[10px] text-amber-400/70 hover:text-amber-400 border border-amber-500/30 hover:border-amber-400/60 rounded px-2 py-1 transition-colors"
                        >
                          + Add value
                        </button>
                      </div>
                    );
                  })()}
                </div>

                {/* Trajectory Gate toggles — visible for all modes */}
                <div className="col-span-2 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <TrendingUp className="w-3 h-3 text-violet-400" />
                    Trajectory Gate
                  </span>
                  <p className="text-[10px] text-muted-foreground/60 -mt-1">
                    Silent for most of the window. Activates only in the <strong className="text-violet-300">final {merged.maxBetTrajectoryFinalMinutes ?? 5} minutes</strong> and blocks a max bet only when the price is in a freefall with enough momentum to cross the Kalshi strike before close. Does not block based on proximity — only on direction and projected crossing.
                    Lookback: <span className="font-mono text-violet-300">{merged.maxBetTrajectoryLookbackMinutes ?? 3} min</span>
                  </p>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <button
                        type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, maxBetTrajectoryEnabled: !(merged.maxBetTrajectoryEnabled ?? true) }))}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.maxBetTrajectoryEnabled ?? true)
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : "bg-muted/40 text-muted-foreground border-border"}`}
                      >
                        Max Bets: {(merged.maxBetTrajectoryEnabled ?? true) ? "On" : "Off"}
                      </button>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <button
                        type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, regularBetTrajectoryEnabled: !(merged.regularBetTrajectoryEnabled ?? false) }))}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${(merged.regularBetTrajectoryEnabled ?? false)
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : "bg-muted/40 text-muted-foreground border-border"}`}
                      >
                        Regular Bets: {(merged.regularBetTrajectoryEnabled ?? false) ? "On" : "Off"}
                      </button>
                    </label>
                  </div>
                </div>

                {/* Mode config panel — defaults, saved preset, and save actions */}
                <div className="col-span-2 flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Mode Configuration</span>
                    <div className="flex items-center gap-2">
                      {/* Reset to built-in defaults for this mode */}
                      {modeDefaults?.[(merged.decisionMode ?? "classic")] && (
                        <button
                          type="button"
                          onClick={() => {
                            const dm = merged.decisionMode ?? "classic";
                            const d = modeDefaults?.[dm] as Partial<BotConfig> | undefined;
                            if (d) {
                              setConfigDraft(prev => ({ ...prev, ...d }));
                              setDefaultsAppliedFor(dm);
                            }
                          }}
                          className="text-[10px] px-2.5 py-1 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 transition-colors"
                        >
                          Reset to defaults
                        </button>
                      )}
                      {/* Save current config as preset for this mode */}
                      <button
                        type="button"
                        disabled={savingPreset}
                        onClick={savePreset}
                        className="text-[10px] px-2.5 py-1 rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors disabled:opacity-50"
                      >
                        {savingPreset ? "Saving…" : `Save as preset`}
                      </button>
                    </div>
                  </div>

                  {/* Defaults-applied confirmation banner */}
                  {defaultsAppliedFor === (merged.decisionMode ?? "classic") && (
                    <div className="flex items-start gap-2 rounded-lg bg-sky-500/10 border border-sky-500/20 px-2.5 py-2">
                      <Zap className="w-3 h-3 text-sky-400 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-sky-400 font-medium">Optimised defaults applied for {defaultsAppliedFor}</p>
                        <p className="text-[9px] text-muted-foreground/70 mt-0.5">
                          Review settings below, then click <strong>Save Config</strong> to apply. You can still adjust individual fields.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDefaultsAppliedFor(null)}
                        className="text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  {presetMsg && (
                    <span className={`text-[10px] ${presetMsg.includes("✓") ? "text-emerald-400" : "text-yellow-400"}`}>{presetMsg}</span>
                  )}

                  {/* Built-in defaults summary for the current mode */}
                  {(() => {
                    const dm = merged.decisionMode ?? "classic";
                    const d = modeDefaults?.[dm] as Record<string, unknown> | undefined;
                    const savedPreset = presetsData?.presets?.[dm] as Record<string, unknown> | undefined;
                    return (
                      <div className="space-y-1">
                        {d && (
                          <p className="text-[9px] text-muted-foreground/60 leading-relaxed">
                            <span className="text-sky-400/70 font-medium">Built-in defaults:</span>{" "}
                            {typeof d.minConfidence === "number" && `conf ≥${d.minConfidence}%`}
                            {typeof d.minReturnMultiple === "number" && ` · return ≥${d.minReturnMultiple}×`}
                            {typeof d.betDelayMinutes === "number" && d.betDelayMinutes > 0 ? ` · entry at T+${d.betDelayMinutes}m` : " · enter immediately"}
                            {typeof d.maxEntryMinutes === "number" && d.maxEntryMinutes > 0 && ` · latest T+${d.maxEntryMinutes}m`}
                            {typeof d.minRemainingMinutes === "number" && d.minRemainingMinutes > 0 && ` · ≥${d.minRemainingMinutes}m left`}
                            {typeof (d as Record<string, unknown>).priceBufferPct === "number" && (d as Record<string, unknown>).priceBufferPct as number > 0 && ` · ≥${(d as Record<string, unknown>).priceBufferPct}% strike clearance`}
                            {typeof d.betSize === "number" && ` · $${d.betSize} bet`}
                          </p>
                        )}
                        {savedPreset ? (
                          <p className="text-[9px] text-emerald-400/70">
                            ✓ Saved preset for <span className="font-medium">{dm}</span> — overrides built-in defaults on mode switch.
                            {typeof savedPreset.minConfidence === "number" && ` Conf: ${savedPreset.minConfidence}%.`}
                            {typeof savedPreset.betSize === "number" && ` Bet: $${savedPreset.betSize}.`}
                          </p>
                        ) : (
                          <p className="text-[9px] text-muted-foreground/40">
                            No custom preset saved yet — built-in defaults auto-apply when switching to this mode.
                            Save a preset to lock in your own calibrated settings.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {!isConviction && (<>
                {/* Profit Lock */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Profit Lock</span>
                  <div className="flex flex-wrap gap-1.5">
                    {([0, 90, 92, 95, 97, 99] as const).map(pct => (
                      <button key={pct} type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, profitLockPct: pct }))}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors ${(merged.profitLockPct ?? 0) === pct
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-foreground border-border hover:bg-muted"}`}>
                        {pct === 0 ? "Off" : `${pct}%`}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {(merged.profitLockPct ?? 0) === 0
                      ? "Disabled — hold until window expires or exit guard fires"
                      : `Cash out when position reaches ${merged.profitLockPct}% of max payout (with ≥2 min remaining)`}
                  </span>
                </div>

                {/* Market Consensus Gate */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Market Consensus Gate (¢)</span>
                  <div className="flex flex-wrap gap-1.5">
                    {([0, 10, 15, 20, 25, 30, 35] as const).map(c => (
                      <button key={c} type="button"
                        onClick={() => setConfigDraft(d => ({ ...d, consensusMinCents: c }))}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors ${(merged.consensusMinCents ?? 25) === c
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-foreground border-border hover:bg-muted"}`}>
                        {c === 0 ? "Off" : `${c}¢`}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {(merged.consensusMinCents ?? 25) === 0
                      ? "Disabled — no market-price veto on bets"
                      : `Skip YES bets when Kalshi YES < ${merged.consensusMinCents ?? 25}¢, skip NO bets when YES > ${100 - (merged.consensusMinCents ?? 25)}¢`}
                  </span>
                </div>

                {/* Momentum Lookback Candles */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Momentum Lookback ({merged.momentumLookbackCandles ?? 8} min)</span>
                  <input type="range" min={4} max={12} step={1}
                    className="mt-1"
                    value={merged.momentumLookbackCandles ?? 8}
                    onChange={e => setConfigDraft(d => ({ ...d, momentumLookbackCandles: parseInt(e.target.value) }))} />
                  <span className="text-xs text-muted-foreground">
                    Candle window for the reversal guard — wider catches drops that started {merged.momentumLookbackCandles ?? 8}+ min ago
                  </span>
                </label>

                {/* Mid-Exit System */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Mid-Window Exit System</span>
                  <button type="button"
                    onClick={() => setConfigDraft(d => ({ ...d, enableMidExit: !(merged.enableMidExit ?? false) }))}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors w-fit ${(merged.enableMidExit ?? false)
                      ? "bg-amber-500/20 text-amber-400 border-amber-500/40 hover:bg-amber-500/30"
                      : "bg-background text-muted-foreground border-border hover:bg-muted"}`}>
                    {(merged.enableMidExit ?? false) ? "Enabled — bot may exit positions early" : "Disabled — hold all positions to window close"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {(merged.enableMidExit ?? false)
                      ? "Bot will cashout early when signal divergence, price flip, or Phase 2 conditions are met."
                      : "Bot holds every position until the 15-min window closes. Safest option — no early exit risk."}
                  </span>
                  {isConviction && (
                    <div className="mt-1 rounded-md border border-violet-500/25 bg-violet-500/8 px-3 py-2 flex items-start gap-2">
                      <Shield className="w-3 h-3 text-violet-400 mt-0.5 shrink-0" />
                      <span className="text-[11px] text-violet-300/80 leading-relaxed">
                        <span className="font-semibold text-violet-300">Conviction mode:</span> mid-exit is automatically suppressed regardless of the toggle above.
                        Conviction positions always hold to window expiry — the edge is in the price cross, not ongoing signals.
                        Only the conviction stop-loss (below) can close a position early.
                      </span>
                    </div>
                  )}
                </div>

                {/* Time-Stop */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Late-Window Time-Stop</span>
                  <button type="button"
                    onClick={() => setConfigDraft(d => ({ ...d, enableTimeStop: !(merged.enableTimeStop ?? false) }))}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors w-fit ${(merged.enableTimeStop ?? false)
                      ? "bg-amber-500/20 text-amber-400 border-amber-500/40 hover:bg-amber-500/30"
                      : "bg-background text-muted-foreground border-border hover:bg-muted"}`}>
                    {(merged.enableTimeStop ?? false) ? "Enabled — exit losing positions with <2 min left" : "Disabled — never force-close based on time"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {(merged.enableTimeStop ?? false)
                      ? "Bot will sell a losing position in the final 2 minutes if the crypto price is on the wrong side of the strike."
                      : "Bot lets every position resolve naturally at window close, even if losing in the final minutes."}
                  </span>
                </div>

                {/* Min Hold Minutes */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Hold Before Any Exit ({merged.minHoldMinutes ?? 4} min)</span>
                  <input type="range" min={1} max={8} step={1}
                    className="mt-1"
                    value={merged.minHoldMinutes ?? 4}
                    onChange={e => setConfigDraft(d => ({ ...d, minHoldMinutes: parseInt(e.target.value) }))} />
                  <span className="text-xs text-muted-foreground">
                    No exit of any kind will fire until a position has been held for this many minutes. Applies even when mid-exit is enabled.
                  </span>
                </label>

                {/* Exit Sensitivity */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Exit Sensitivity</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.midExitSensitivity ?? "balanced"}
                    onChange={e => setConfigDraft(d => ({ ...d, midExitSensitivity: e.target.value as BotConfig["midExitSensitivity"] }))}>
                    <option value="conservative">Conservative</option>
                    <option value="balanced">Balanced</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </label>

                {/* Phase 2 Threshold */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Phase 2 Threshold ({merged.phase2ThresholdPp ?? 30}¢)</span>
                  <input type="range" min={10} max={50} step={5}
                    className="mt-1"
                    value={merged.phase2ThresholdPp ?? 30}
                    onChange={e => setConfigDraft(d => ({ ...d, phase2ThresholdPp: parseInt(e.target.value) }))} />
                </label>

                </>)}

                {/* Early-Window Lockout (minWindowEntryMinutes) — always visible, applies to all modes */}
                {(() => {
                  const lockMin = merged.minWindowEntryMinutes ?? 0;
                  const bypassOn = merged.convictionEarlyBypassEnabled !== false;
                  const bypassFloor = merged.convictionEarlyBypassThreshold ?? 0.81;
                  const bypassCap   = merged.convictionEarlyBypassCap ?? 0.95;
                  const floorPct = Math.round(bypassFloor * 100);
                  const capPct   = Math.round(bypassCap * 100);
                  const noFloorPct = 100 - capPct;
                  const noCapPct   = 100 - floorPct;
                  return (
                    <div className="flex flex-col gap-2">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          No Bets Before
                          {lockMin > 0 && (
                            <span className="ml-1 text-amber-400">T+{lockMin}m</span>
                          )}
                        </span>
                        <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                          value={lockMin}
                          onChange={e => setConfigDraft(d => ({ ...d, minWindowEntryMinutes: parseInt(e.target.value, 10) }))}>
                          <option value={0}>No lockout — bets allowed immediately</option>
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                            <option key={m} value={m}>
                              Block first {m} min{bypassOn ? ` (bypass ${floorPct}–${capPct}¢ YES / ${noFloorPct}–${noCapPct}¢ NO)` : " (no bypass)"}
                            </option>
                          ))}
                        </select>
                        {lockMin > 0 && (
                          <span className="text-xs text-muted-foreground/70">
                            {bypassOn
                              ? `No bets in the first ${lockMin} min unless YES price is ${floorPct}–${capPct}¢ (YES zone) or ${noFloorPct}–${noCapPct}¢ (NO zone).`
                              : `No bets in the first ${lockMin} min — timer is always respected (bypass disabled).`}
                          </span>
                        )}
                      </label>

                      {/* Bypass toggle — only shown when a lockout is active */}
                      {lockMin > 0 && (
                        <div className="flex flex-col gap-1.5 pl-3 border-l border-border/40">
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input type="checkbox"
                              className="accent-amber-400"
                              checked={bypassOn}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionEarlyBypassEnabled: e.target.checked }))} />
                            <span className="text-xs text-muted-foreground">
                              Allow extreme-price bypass
                            </span>
                          </label>
                          {bypassOn && (
                            <div className="flex flex-col gap-2">
                              <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground/70">Bypass floor (YES — lower bound)</span>
                                <select className="bg-background border border-border/60 rounded-md px-2 py-1 text-xs text-foreground"
                                  value={bypassFloor}
                                  onChange={e => setConfigDraft(d => ({ ...d, convictionEarlyBypassThreshold: parseFloat(e.target.value) }))}>
                                  {[0.75, 0.78, 0.80, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88, 0.90].map(v => {
                                    const pct = Math.round(v * 100);
                                    return (
                                      <option key={v} value={v}>{pct}¢ (NO mirror: ≤{100 - pct}¢)</option>
                                    );
                                  })}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground/70">Bypass cap (YES — upper bound)</span>
                                <select className="bg-background border border-border/60 rounded-md px-2 py-1 text-xs text-foreground"
                                  value={bypassCap}
                                  onChange={e => setConfigDraft(d => ({ ...d, convictionEarlyBypassCap: parseFloat(e.target.value) }))}>
                                  {[0.90, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98].map(v => {
                                    const pct = Math.round(v * 100);
                                    return (
                                      <option key={v} value={v}>{pct}¢ (NO mirror: ≥{100 - pct}¢)</option>
                                    );
                                  })}
                                </select>
                              </label>
                              <span className="text-[10px] text-muted-foreground/50">
                                Timer is skipped when YES price is in the {floorPct}–{capPct}¢ range (YES bets) or {noFloorPct}–{noCapPct}¢ range (NO bets).
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Max Bets Per Window — visible in all modes */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Bets / Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxBetsPerWindow ?? 8}
                    onChange={e => setConfigDraft(d => ({ ...d, maxBetsPerWindow: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                  <span className="text-[10px] text-muted-foreground/60">
                    Max bets placed per 15-min window across all coins (e.g. 2 bets × $10 = $20 max per window)
                  </span>
                </label>

                {!isConviction && (<>
                {/* ── Entry Timing ───────────────────────────────── */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Entry Timing</span>

                  {/* Earliest Entry (betDelayMinutes) — FLOOR: bot won't buy before T+X */}
                  <label className="flex flex-col gap-1.5 mt-1">
                    <span className="text-xs text-muted-foreground">Earliest Entry <span className="text-muted-foreground/50 font-normal">(bot won't buy before this point)</span></span>
                    <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                      value={merged.betDelayMinutes ?? 0}
                      onChange={e => setConfigDraft(d => ({ ...d, betDelayMinutes: parseInt(e.target.value) }))}>
                      <option value={0}>Immediately — enter as soon as signals are ready (~T+2 min)</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                        <option key={m} value={m}>Wait {m} min — hold until T+{m}m, re-analyze, then bet</option>
                      ))}
                    </select>
                    <span className="text-xs text-muted-foreground/70">
                      Bot holds the entry until this many minutes into the window, then runs a fresh Claude analysis before placing any bet.
                    </span>
                  </label>

                  {/* Latest Entry (maxEntryMinutes) — CEILING: bot won't buy after T+X */}
                  <label className="flex flex-col gap-1.5 mt-1">
                    <span className="text-xs text-muted-foreground">Latest Entry <span className="text-muted-foreground/50 font-normal">(bot won't buy after this point)</span></span>
                    <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                      value={merged.maxEntryMinutes ?? 11}
                      onChange={e => setConfigDraft(d => ({ ...d, maxEntryMinutes: parseInt(e.target.value) }))}>
                      <option value={0}>No ceiling — enter any time signals are ready</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                        <option key={m} value={m}>By T+{m} min — skip coin if already past this point ({15 - m} min left)</option>
                      ))}
                    </select>
                    <span className="text-xs text-muted-foreground/70">
                      If signals aren't ready by this point, the bot skips the coin for this window rather than betting late.
                    </span>
                  </label>

                  {/* Min Time Remaining (minRemainingMinutes) */}
                  <label className="flex flex-col gap-1.5 mt-1">
                    <span className="text-xs text-muted-foreground">Min Time Remaining</span>
                    <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                      value={merged.minRemainingMinutes ?? 2}
                      onChange={e => setConfigDraft(d => ({ ...d, minRemainingMinutes: parseInt(e.target.value) }))}>
                      <option value={0}>No floor — enter even in the final minute</option>
                      {[1, 2, 3, 4, 5, 6, 7].map(m => (
                        <option key={m} value={m}>Skip if &lt;{m} min left in window</option>
                      ))}
                    </select>
                  </label>
                </div>

                {/* Max Consecutive Losses */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Circuit Breaker Trigger (losses)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxConsecutiveLosses ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxConsecutiveLosses: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} consecutive loss{n > 1 ? "es" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Circuit Breaker Pause Windows */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Circuit Breaker Pause (windows)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.circuitBreakerPauseWindows ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, circuitBreakerPauseWindows: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                      <option key={n} value={n}>Pause {n} window{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                </>)}

                {/* ── Smart Quiet Hours V2 — visible in all modes ── */}
                <div className="col-span-full">
                  <QuietHoursGrid
                    value={merged.quietHoursV2 ?? { enabled: false, silencedUtcHours: [], reducedBetUtcHours: {} }}
                    onChange={(v: QuietHoursV2) => setConfigDraft(d => ({ ...d, quietHoursV2: v }))}
                    autoTuneLastRunAt={status?.autoTuneQHLastRunAt}
                    autoTuneLastChanges={status?.autoTuneQHLastChanges}
                  />
                </div>

                {/* ── Legacy quiet hours (collapsed) ── */}
                <div className="col-span-full">
                  <details className="group">
                    <summary className="flex items-center gap-1.5 cursor-pointer list-none text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors select-none">
                      <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="currentColor" viewBox="0 0 20 20"><path d="M7 7l3-3 3 3m0 6l-3 3-3-3" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
                      Legacy quiet hours range (simple start–end UTC)
                    </summary>
                    <div className="mt-2 flex flex-col gap-3 pl-4 border-l border-border/50">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">Quiet Hours Start ({ET_LABEL})</span>
                        <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                          value={utcToEst(merged.quietHoursStart ?? 0)}
                          onChange={e => setConfigDraft(d => ({ ...d, quietHoursStart: estToUtc(parseInt(e.target.value)) }))}>
                          {Array.from({ length: 24 }, (_, i) => (
                            <option key={i} value={i}>{String(i).padStart(2, "0")}:00 {ET_LABEL}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">Quiet Hours End ({ET_LABEL}) — set equal to start to disable</span>
                        <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                          value={utcToEst(merged.quietHoursEnd ?? 0)}
                          onChange={e => setConfigDraft(d => ({ ...d, quietHoursEnd: estToUtc(parseInt(e.target.value)) }))}>
                          {Array.from({ length: 24 }, (_, i) => (
                            <option key={i} value={i}>{String(i).padStart(2, "0")}:00 {ET_LABEL}{i === utcToEst(merged.quietHoursStart ?? 0) ? " (disabled)" : ""}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </details>
                </div>

                {!isConviction && (<>
                {/* Direction Cap Enable */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Directional Balance Filter</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableDirectionCap: !(merged.enableDirectionCap ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableDirectionCap ?? true) ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableDirectionCap ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableDirectionCap ?? true) ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {(merged.enableDirectionCap ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* Max Same-Direction Bets */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Same-Direction Bets / Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxSameDirectionBets ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxSameDirectionBets: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Momentum Filter Enable */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Momentum Override Filter</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableMomentumFilter: !(merged.enableMomentumFilter ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableMomentumFilter ?? true) ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableMomentumFilter ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableMomentumFilter ?? true) ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {(merged.enableMomentumFilter ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* Momentum Window Count */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Momentum Windows Required</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.momentumWindowCount ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, momentumWindowCount: parseInt(e.target.value) }))}>
                    {[2, 3, 4, 5, 6, 7, 8].map(n => (
                      <option key={n} value={n}>{n} consecutive windows</option>
                    ))}
                  </select>
                </label>

                {/* Directional Regime Dampener */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Directional Dampener Penalty ({merged.directionalRegressionPenaltyPp ?? 10}pp — 0 = off)
                  </span>
                  <input type="range" min={0} max={20} step={1}
                    className="mt-1 accent-orange-400"
                    value={merged.directionalRegressionPenaltyPp ?? 10}
                    onChange={e => setConfigDraft(d => ({ ...d, directionalRegressionPenaltyPp: parseInt(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0 (off)</span><span>20pp</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    Raises the confidence floor for a direction (YES or NO) that has lost too many times recently. 0 disables.
                  </span>
                </label>

                {/* Directional Dampener — win-rate threshold */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Dampener Win-Rate Threshold ({Math.round((merged.directionalRegressionThreshold ?? 0.35) * 100)}% — fire when below)
                  </span>
                  <input type="range" min={0.1} max={0.6} step={0.05}
                    className="mt-1 accent-orange-400"
                    value={merged.directionalRegressionThreshold ?? 0.35}
                    onChange={e => setConfigDraft(d => ({ ...d, directionalRegressionThreshold: parseFloat(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>10% (aggressive)</span><span>60% (cautious)</span>
                  </div>
                </label>

                {/* Directional Dampener — lookback windows */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Dampener Lookback (windows)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.directionalRegressionLookback ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, directionalRegressionLookback: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                      <option key={n} value={n}>Last {n} window{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    How many recent completed windows to examine when checking directional win rate. Penalty persists this long once triggered.
                  </span>
                </label>

                {/* Border Proximity Guard */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Border Proximity Guard</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableBorderGuard: !(merged.enableBorderGuard ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableBorderGuard ?? true) ? "bg-amber-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableBorderGuard ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableBorderGuard ?? true) ? "text-amber-400" : "text-muted-foreground"}`}>
                      {(merged.enableBorderGuard ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
                    Skips bets when price has been hovering within X% of the strike in recent settled windows.
                  </span>
                </label>

                {/* Border Proximity Threshold */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Proximity Threshold — {((merged.borderProximityPct ?? 3.0)).toFixed(1)}% of strike
                  </span>
                  <input
                    type="range" min={0.1} max={5.0} step={0.1}
                    value={merged.borderProximityPct ?? 3.0}
                    onChange={e => setConfigDraft(d => ({ ...d, borderProximityPct: parseFloat(e.target.value) }))}
                    className="w-full accent-amber-500"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0.1% (tight)</span><span>5.0% (wide)</span>
                  </div>
                </label>

                {/* Border Lookback Bets */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Proximity Lookback (bets)</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.borderLookbackBets ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, borderLookbackBets: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>Last {n} settled bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* ── Entry Proximity Guard ─────────────────────────────── */}
                <div className="col-span-full border border-border/60 rounded-xl bg-muted/10 p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left flex-1 min-w-0"
                      onClick={() => setProximityExpanded(x => !x)}
                    >
                      <Target className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                      <span className="text-xs font-semibold text-teal-400">Entry Proximity Guard</span>
                      <span className="ml-auto text-muted-foreground">{proximityExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}</span>
                    </button>
                    <button
                      type="button"
                      title={(merged.proximityGuardEnabled ?? false) ? "Click to disable proximity guard" : "Click to enable proximity guard"}
                      onClick={() => setConfigDraft(d => ({ ...d, proximityGuardEnabled: !(merged.proximityGuardEnabled ?? false) }))}
                      className={`shrink-0 text-[10px] px-2 py-0.5 rounded font-medium border transition-colors ${(merged.proximityGuardEnabled ?? false)
                        ? "bg-teal-500/20 text-teal-300 border-teal-500/40 hover:bg-red-500/20 hover:text-red-300 hover:border-red-500/40"
                        : "bg-muted text-muted-foreground border-border hover:bg-teal-500/20 hover:text-teal-300 hover:border-teal-500/40"}`}>
                      {(merged.proximityGuardEnabled ?? false) ? "ON" : "OFF"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                    Skips entry when the live price is within X% of the Kalshi strike. In coin-flip territory the bot has no real edge — this guard filters those bets out.
                    Two phases: <span className="text-teal-400/80">Early</span> (first 8 min) and <span className="text-teal-400/80">Late</span> (final 7 min). Per-coin overrides take precedence.
                  </p>

                  {proximityExpanded && (
                    <div className="space-y-3 pt-1">
                      {/* Master toggle */}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <button
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, proximityGuardEnabled: !(merged.proximityGuardEnabled ?? false) }))}
                          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${(merged.proximityGuardEnabled ?? false) ? "bg-teal-500" : "bg-muted"}`}>
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.proximityGuardEnabled ?? false) ? "translate-x-4" : ""}`} />
                        </button>
                        <span className={`text-xs font-medium ${(merged.proximityGuardEnabled ?? false) ? "text-teal-400" : "text-muted-foreground"}`}>
                          {(merged.proximityGuardEnabled ?? false) ? "Enabled — proximity gate is active" : "Disabled — no proximity filtering"}
                        </span>
                      </label>

                      <div className="grid grid-cols-2 gap-3">
                        {/* Late-window phase threshold */}
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] text-muted-foreground">Late Phase Starts (min remaining)</span>
                          <select
                            className="bg-background border border-border rounded-md px-2 py-1.5 text-xs text-foreground"
                            value={merged.proximityLateWindowMinutes ?? 7}
                            onChange={e => setConfigDraft(d => ({ ...d, proximityLateWindowMinutes: parseInt(e.target.value, 10) }))}>
                            {[3, 4, 5, 6, 7, 8, 9, 10].map(m => (
                              <option key={m} value={m}>≤ {m} min remaining</option>
                            ))}
                          </select>
                        </label>

                        {/* Early-window global threshold */}
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] text-muted-foreground">Early Phase Min Distance (%)</span>
                          <input
                            type="number" min={0} max={5} step={0.05}
                            className="bg-background border border-border rounded-md px-2 py-1.5 text-xs text-foreground"
                            value={merged.proximityEarlyPct ?? 0}
                            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setConfigDraft(d => ({ ...d, proximityEarlyPct: v })); }} />
                          <span className="text-[9px] text-muted-foreground/60">0 = disabled for early phase</span>
                        </label>

                        {/* Late-window global threshold */}
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] text-muted-foreground">Late Phase Min Distance (%)</span>
                          <input
                            type="number" min={0} max={5} step={0.05}
                            className="bg-background border border-border rounded-md px-2 py-1.5 text-xs text-foreground"
                            value={merged.proximityLatePct ?? 0}
                            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setConfigDraft(d => ({ ...d, proximityLatePct: v })); }} />
                          <span className="text-[9px] text-muted-foreground/60">0 = disabled for late phase</span>
                        </label>

                        {/* Auto-calibrate button */}
                        <div className="flex flex-col gap-1 justify-end">
                          <button
                            type="button"
                            disabled={proximityCalibrating}
                            onClick={async () => {
                              setProximityCalibrating(true);
                              setProximityCalibMsg(null);
                              try {
                                const resp = await fetch(`${API_BASE}/crypto/bot/calibrate-proximity`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  credentials: "include",
                                  body: JSON.stringify({ lateWindowMinutes: merged.proximityLateWindowMinutes ?? 7, days: 60 }),
                                });
                                const data = await resp.json() as { ok?: boolean; bySym?: CalibrateResult; error?: string };
                                if (data.ok && data.bySym) {
                                  setProximityCalibResult(data.bySym);
                                  setProximityCalibMsg("✓ Calibration complete — review suggestions below");
                                } else {
                                  setProximityCalibMsg(`⚠ ${data.error ?? "Calibration failed"}`);
                                }
                              } catch {
                                setProximityCalibMsg("⚠ Request failed");
                              } finally {
                                setProximityCalibrating(false);
                              }
                            }}
                            className="rounded-md px-3 py-1.5 text-xs font-medium border border-teal-500/40 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20 transition-colors disabled:opacity-50 flex items-center gap-1.5 justify-center"
                          >
                            {proximityCalibrating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <BarChart3 className="w-3 h-3" />}
                            {proximityCalibrating ? "Calibrating…" : "Auto-calibrate"}
                          </button>
                          {proximityCalibMsg && (
                            <span className={`text-[9px] ${proximityCalibMsg.startsWith("✓") ? "text-teal-400" : "text-yellow-400"}`}>{proximityCalibMsg}</span>
                          )}
                        </div>
                      </div>

                      {/* Calibration results */}
                      {proximityCalibResult && (() => {
                        const coins = Object.keys(proximityCalibResult).sort();
                        if (coins.length === 0) return null;
                        return (
                          <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-2.5 space-y-2">
                            <div className="text-[10px] font-medium text-teal-400">Calibration Suggestions (1.5× std dev below mean — apply per coin or as globals)</div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-[9px]">
                                <thead>
                                  <tr className="text-muted-foreground/60 border-b border-border/40">
                                    <th className="text-left pb-1 pr-2">Coin</th>
                                    <th className="text-right pb-1 pr-2">Early bets</th>
                                    <th className="text-right pb-1 pr-2">Early suggest</th>
                                    <th className="text-right pb-1 pr-2">Late bets</th>
                                    <th className="text-right pb-1 pr-2">Late suggest</th>
                                    <th className="text-right pb-1">Apply</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {coins.map(sym => {
                                    const r = proximityCalibResult[sym];
                                    const earlySugg = r.early.suggested ?? 0;
                                    const lateSugg = r.late.suggested ?? 0;
                                    const earlyOverride = (merged.proximityEarlyPctOverrides ?? {})[sym];
                                    const lateOverride = (merged.proximityLatePctOverrides ?? {})[sym];
                                    return (
                                      <tr key={sym} className="border-b border-border/20 last:border-0">
                                        <td className="py-1 pr-2 font-medium text-foreground">{sym}</td>
                                        <td className="py-1 pr-2 text-right text-muted-foreground">{r.early.n}</td>
                                        <td className="py-1 pr-2 text-right text-teal-300">{earlySugg > 0 ? `${earlySugg.toFixed(3)}%` : "—"}</td>
                                        <td className="py-1 pr-2 text-right text-muted-foreground">{r.late.n}</td>
                                        <td className="py-1 pr-2 text-right text-teal-300">{lateSugg > 0 ? `${lateSugg.toFixed(3)}%` : "—"}</td>
                                        <td className="py-1 text-right">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setConfigDraft(d => ({
                                                ...d,
                                                proximityEarlyPctOverrides: {
                                                  ...(d.proximityEarlyPctOverrides ?? merged.proximityEarlyPctOverrides ?? {}),
                                                  [sym]: earlySugg,
                                                },
                                                proximityLatePctOverrides: {
                                                  ...(d.proximityLatePctOverrides ?? merged.proximityLatePctOverrides ?? {}),
                                                  [sym]: lateSugg,
                                                },
                                              }));
                                            }}
                                            className="px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-300 hover:bg-teal-500/30 transition-colors text-[8px]"
                                          >
                                            Apply
                                          </button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Per-coin override table (current values) */}
                      {(() => {
                        const earlyOverrides = merged.proximityEarlyPctOverrides ?? {};
                        const lateOverrides = merged.proximityLatePctOverrides ?? {};
                        const allCoins = Array.from(new Set([...Object.keys(earlyOverrides), ...Object.keys(lateOverrides)])).sort();
                        if (allCoins.length === 0) return (
                          <p className="text-[9px] text-muted-foreground/50">No per-coin overrides set. Use Auto-calibrate or edit manually.</p>
                        );
                        return (
                          <div className="space-y-1">
                            <div className="text-[10px] font-medium text-muted-foreground">Per-coin overrides (active)</div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-[9px]">
                                <thead>
                                  <tr className="text-muted-foreground/60 border-b border-border/40">
                                    <th className="text-left pb-1 pr-2">Coin</th>
                                    <th className="text-right pb-1 pr-2">Early %</th>
                                    <th className="text-right pb-1 pr-2">Late %</th>
                                    <th className="text-right pb-1">Clear</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {allCoins.map(sym => (
                                    <tr key={sym} className="border-b border-border/20 last:border-0">
                                      <td className="py-1 pr-2 font-medium">{sym}</td>
                                      <td className="py-1 pr-2 text-right">
                                        <input
                                          type="number" min={0} max={5} step={0.05}
                                          className="w-16 bg-background border border-border/60 rounded px-1 py-0.5 text-right text-[9px]"
                                          value={earlyOverrides[sym] ?? ""}
                                          placeholder="global"
                                          onChange={e => {
                                            const v = parseFloat(e.target.value);
                                            setConfigDraft(d => ({
                                              ...d,
                                              proximityEarlyPctOverrides: {
                                                ...(d.proximityEarlyPctOverrides ?? merged.proximityEarlyPctOverrides ?? {}),
                                                [sym]: isNaN(v) ? 0 : v,
                                              },
                                            }));
                                          }} />
                                      </td>
                                      <td className="py-1 pr-2 text-right">
                                        <input
                                          type="number" min={0} max={5} step={0.05}
                                          className="w-16 bg-background border border-border/60 rounded px-1 py-0.5 text-right text-[9px]"
                                          value={lateOverrides[sym] ?? ""}
                                          placeholder="global"
                                          onChange={e => {
                                            const v = parseFloat(e.target.value);
                                            setConfigDraft(d => ({
                                              ...d,
                                              proximityLatePctOverrides: {
                                                ...(d.proximityLatePctOverrides ?? merged.proximityLatePctOverrides ?? {}),
                                                [sym]: isNaN(v) ? 0 : v,
                                              },
                                            }));
                                          }} />
                                      </td>
                                      <td className="py-1 text-right">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setConfigDraft(d => {
                                              const newEarly = { ...(d.proximityEarlyPctOverrides ?? merged.proximityEarlyPctOverrides ?? {}) };
                                              const newLate  = { ...(d.proximityLatePctOverrides  ?? merged.proximityLatePctOverrides  ?? {}) };
                                              delete newEarly[sym];
                                              delete newLate[sym];
                                              return { ...d, proximityEarlyPctOverrides: newEarly, proximityLatePctOverrides: newLate };
                                            });
                                          }}
                                          className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 text-[8px]"
                                        >
                                          ✕
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

                {/* Window Monitor Readiness Gate */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Window Monitor Ready Gate</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, requireMonitorReady: !(merged.requireMonitorReady ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.requireMonitorReady ?? true) ? "bg-violet-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.requireMonitorReady ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.requireMonitorReady ?? true) ? "text-violet-400" : "text-muted-foreground"}`}>
                      {(merged.requireMonitorReady ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
                    Defers entry until the window monitor has ≥2 min of intra-window data. First 2 ticks (~0–1 min) are skipped; bets start at minute 2. Recommended: ON.
                  </span>
                </label>

                {/* Auto-Tuning */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Self-Learning Auto-Tune</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enableAutoTuning: !(merged.enableAutoTuning ?? true) }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${(merged.enableAutoTuning ?? true) ? "bg-sky-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${(merged.enableAutoTuning ?? true) ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${(merged.enableAutoTuning ?? true) ? "text-sky-400" : "text-muted-foreground"}`}>
                      {(merged.enableAutoTuning ?? true) ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>

                {/* Auto-Tune Window Size */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Auto-Tune Window (bets, 20–500)</span>
                  <input
                    type="number" min={20} max={500} step={10}
                    value={merged.autoTuneWindowSize ?? 100}
                    onChange={e => setConfigDraft(d => ({ ...d, autoTuneWindowSize: parseInt(e.target.value) }))}
                    className="bg-background border border-border rounded-md px-3 py-1.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-sky-500"
                  />
                </label>

                {/* Regime Penalty */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Regime Penalty ({merged.regimePenalty ?? 15}pp)
                  </span>
                  <input type="range" min={0} max={20} step={1}
                    className="mt-1"
                    value={merged.regimePenalty ?? 15}
                    onChange={e => setConfigDraft(d => ({ ...d, regimePenalty: parseInt(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0 (off)</span><span>20pp</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    Confidence deducted when betting against the recent settlement direction. Lower = more bets.
                  </span>
                </label>

                {/* Unanimous Model Floor */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Unanimous Model Floor ({merged.unanimousMinModelConfidence ?? 57}% — 0 = off)
                  </span>
                  <input type="range" min={0} max={70} step={1}
                    className="mt-1 accent-violet-400"
                    value={merged.unanimousMinModelConfidence ?? 57}
                    onChange={e => setConfigDraft(d => ({ ...d, unanimousMinModelConfidence: parseInt(e.target.value) }))} />
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>0 (off)</span><span>70%</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/70 leading-tight">
                    When all models unanimously agree, each individual model must still clear this confidence floor or the unanimous bonus is downgraded to a penalty. 0 disables.
                  </span>
                </label>

                </>)}
                {/* Master Enable */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Bot Master Switch</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setConfigDraft(d => ({ ...d, enabled: !merged.enabled }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${merged.enabled ? "bg-emerald-500" : "bg-muted"}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${merged.enabled ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${merged.enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {merged.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </label>
              </div>

              {/* Shadow paper bets — always visible; relevant in live mode */}
              <div className="border border-border/60 rounded-lg p-4 bg-violet-500/5 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-violet-400">Shadow Paper Bets (Live Mode)</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground/70 leading-snug">
                      While running live, also record every bet as a paper entry in the background.
                      Doubles the data available for quiet-hours learning without extra API calls.
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={merged.shadowPaperBets !== false}
                    onClick={() => setConfigDraft(d => ({ ...d, shadowPaperBets: !(merged.shadowPaperBets !== false) }))}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${merged.shadowPaperBets !== false ? "bg-violet-500" : "bg-muted"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${merged.shadowPaperBets !== false ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                </div>
                {/* Quiet-hours bypass for shadow paper — fills the auto-tune blind spot */}
                <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/40">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-xs font-medium text-violet-300">Evaluate During Quiet Hours</span>
                    <span className="text-[10px] text-muted-foreground/60 leading-snug">
                      Run paper-only signal evaluation during silenced hours so auto-tune can discover
                      whether those slots should be unsilenced. Live orders are never placed.
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={merged.shadowPaperIgnoreQuietHours === true}
                    onClick={() => setConfigDraft(d => ({ ...d, shadowPaperIgnoreQuietHours: !(merged.shadowPaperIgnoreQuietHours === true) }))}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${merged.shadowPaperIgnoreQuietHours === true ? "bg-violet-500" : "bg-muted"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${merged.shadowPaperIgnoreQuietHours === true ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                </div>
              </div>

              {/* Paper Trading Simulation — only visible in paper mode */}
              {status?.mode === "paper" && (
                <div className="border border-border/60 rounded-lg p-4 space-y-4 bg-sky-500/5">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-xs font-semibold text-sky-400">Paper Trading Simulation</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {/* Starting Balance */}
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Starting Wallet ($)</span>
                      <input type="number" min={1} max={100000} step={10}
                        className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                        value={merged.paperStartingBalance ?? 100}
                        onChange={e => setConfigDraft(d => ({ ...d, paperStartingBalance: parseFloat(e.target.value) }))} />
                      <span className="text-[10px] text-muted-foreground/70">
                        Balance when the wallet is reset.
                      </span>
                    </label>

                    {/* Win Return Rate */}
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        Win Profit Rate ({((merged.paperWinReturnRate ?? 0.5) * 100).toFixed(0)}%)
                      </span>
                      <input type="range" min={0.05} max={1.0} step={0.05}
                        className="mt-1"
                        value={merged.paperWinReturnRate ?? 0.5}
                        onChange={e => setConfigDraft(d => ({ ...d, paperWinReturnRate: parseFloat(e.target.value) }))} />
                      <div className="flex justify-between text-[10px] text-muted-foreground/60">
                        <span>5%</span><span>100%</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70">
                        Profit returned as % of bet on a win (e.g. 50% → +$0.50 per $1 bet).
                      </span>
                    </label>

                    {/* Reset Wallet */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Reset Wallet</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-sky-500/40 text-sky-400 hover:bg-sky-500/10 text-xs"
                        onClick={() => {
                          const now = new Date().toISOString();
                          setConfigDraft(d => ({
                            ...d,
                            paperBalanceResetAt: now,
                            paperStartingBalance: merged.paperStartingBalance ?? 100,
                          }));
                        }}
                      >
                        Reset to ${(merged.paperStartingBalance ?? 100).toFixed(0)}
                      </Button>
                      <span className="text-[10px] text-muted-foreground/70">
                        Resets the wallet to the Starting Wallet amount. Save to apply.
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Per-Coin Overrides ── */}
              {(() => {
                const COINS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "XRP", "HYPE", "NEAR", "ZEC"];
                const overrides = (merged.coinOverrides ?? {}) as Record<string, { paused?: boolean; maxBetSize?: number }>;
                const globalMax = merged.maxBetSize ?? 2;
                return (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Sliders className="w-3 h-3" />
                      Per-Coin Overrides
                    </span>
                    <div className="rounded-xl border border-border overflow-hidden">
                      {COINS.map((coin, i) => {
                        const ov = overrides[coin] ?? {};
                        const isPaused = ov.paused === true;
                        const perMax = ov.maxBetSize;
                        return (
                          <div
                            key={coin}
                            className={`flex items-center gap-3 px-3 py-2 ${i > 0 ? "border-t border-border" : ""} ${isPaused ? "bg-muted/30" : ""}`}
                          >
                            {/* Coin label */}
                            <span className={`text-xs font-mono w-12 font-semibold ${isPaused ? "text-muted-foreground/40 line-through" : "text-foreground"}`}>
                              {coin}
                            </span>

                            {/* Pause toggle */}
                            <button
                              type="button"
                              onClick={() => setConfigDraft(d => {
                                const cur = ((d.coinOverrides ?? merged.coinOverrides ?? {}) as Record<string, { paused?: boolean; maxBetSize?: number }>);
                                const next = { ...cur, [coin]: { ...cur[coin], paused: !isPaused } };
                                if (!next[coin].paused && next[coin].maxBetSize == null) delete next[coin];
                                return { ...d, coinOverrides: next };
                              })}
                              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors ${
                                isPaused
                                  ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
                                  : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"
                              }`}
                            >
                              <Pause className="w-2.5 h-2.5" />
                              {isPaused ? "Paused" : "Pause"}
                            </button>

                            {/* Max bet input */}
                            <div className="flex items-center gap-1.5 ml-auto">
                              <span className="text-[10px] text-muted-foreground/60">Max $</span>
                              <input
                                type="number"
                                min={0.5}
                                max={100}
                                step={0.5}
                                placeholder={globalMax.toFixed(2)}
                                value={perMax != null ? perMax : ""}
                                className="w-20 bg-background border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/40"
                                onChange={e => {
                                  const v = e.target.value === "" ? undefined : parseFloat(e.target.value);
                                  setConfigDraft(d => {
                                    const cur = ((d.coinOverrides ?? merged.coinOverrides ?? {}) as Record<string, { paused?: boolean; maxBetSize?: number }>);
                                    const updated = { ...cur[coin], maxBetSize: v };
                                    if (v == null) delete updated.maxBetSize;
                                    const next = { ...cur, [coin]: updated };
                                    if (!next[coin].paused && next[coin].maxBetSize == null) delete next[coin];
                                    return { ...d, coinOverrides: next };
                                  });
                                }}
                              />
                            </div>

                            {/* Active indicator */}
                            {perMax != null && (
                              <span className={`text-[10px] font-mono ${perMax < globalMax ? "text-sky-400" : "text-muted-foreground/50"}`}>
                                {perMax < globalMax ? `↓ capped` : `= global`}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <span className="text-[10px] text-muted-foreground/60">
                      Pause stops all new bets for that coin. Max $ caps the bet size per contract (blank = use global max). Save to apply.
                    </span>
                  </div>
                );
              })()}

              <div className="flex items-center gap-2 pt-2 border-t border-border">
                <Button size="sm" disabled={!hasDraft || saving} onClick={saveConfig} className="gap-1">
                  {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
                  {saving ? "Saving…" : "Save Configuration"}
                </Button>
                {hasDraft && !saving && (
                  <Button size="sm" variant="outline" onClick={() => setConfigDraft({})}>Reset</Button>
                )}
                {persistMsg === "saved" && (
                  <span className="text-xs text-emerald-400">✓ Settings saved</span>
                )}
                {persistMsg === "failed" && (
                  <span className="text-xs text-yellow-400">⚠ Applied (not persisted)</span>
                )}
              </div>

              {/* Admin: re-evaluate historical bets against Kalshi's authoritative RTI result */}
              <div className="flex flex-col gap-1.5 pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reEvalState.loading}
                    onClick={runReEvaluate}
                    className="border-violet-500/40 text-violet-400 hover:bg-violet-500/10 text-xs gap-1"
                  >
                    {reEvalState.loading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    {reEvalState.loading ? "Checking…" : "Re-evaluate Settled Bets"}
                  </Button>
                  {reEvalState.msg && (
                    <span className={`text-xs ${reEvalState.msg.startsWith("✓") ? "text-emerald-400" : "text-yellow-400"}`}>
                      {reEvalState.msg}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground/70">
                  Re-checks the last 30 days of settled bets against Kalshi's authoritative RTI result and corrects any mis-evaluated outcomes.
                </span>
              </div>
            </div>
          )}
        </div>


    </>
  );
}
