import { Bot, Pause, Play, TrendingUp, TrendingDown, Clock, DollarSign, BarChart3, Target, Star, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Shield, Zap, ArrowUp, ArrowDown, Trophy, Minus, Settings, ChevronDown, ChevronUp, Activity, Brain, Sliders, ChevronLeft, ChevronRight, ShoppingCart, X, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QueryClient } from "@tanstack/react-query";
import React from "react";
import type { BotStatus, BotConfig, BacktestModeStats, DecisionMode } from "./types";
import { utcToEst, estToUtc, ET_LABEL, fmtPct, API_BASE } from "./utils";

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
  savingPreset: boolean;
  savePreset: () => Promise<void>;
  presetMsg: string | null;
  backtestData: { modes: BacktestModeStats[] } | undefined;
  configOpen: boolean;
  setConfigOpen: React.Dispatch<React.SetStateAction<boolean>>;
  authPost: (path: string, body: object) => Promise<unknown>;
  qc: QueryClient;
}

export function BotConfigSection({ cfg, merged, configDraft, setConfigDraft, saving, saveConfig, persistMsg, status, activeMode, presetsData, savingPreset, savePreset, presetMsg, backtestData, configOpen, setConfigOpen, authPost, qc }: BotConfigSectionProps) {
  const hasDraft = Object.keys(configDraft).length > 0;
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
                  <input type="number" min={0.5} max={25} step={0.5}
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
                  <input type="number" min={0.5} max={100} step={0.5}
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

                {/* ── Live Mode Guards ─────────────────────────────────── */}
                <div className="col-span-full border-t border-amber-500/20 pt-3 -mt-1">
                  <span className="text-xs font-semibold text-amber-400/90 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5" /> Live Mode Guards
                  </span>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">Active in live betting only — enforced before each trade</p>
                </div>

                {/* Min Account Balance */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Account Balance ($)</span>
                  <input type="number" min={0} max={1000} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minAccountBalance ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, minAccountBalance: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Abort live bet if Kalshi balance drops below this</span>
                </label>

                {/* Max Total Exposure */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Total Exposure ($)</span>
                  <input type="number" min={0} max={500} step={0.5}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxTotalExposure ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, maxTotalExposure: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Max total $ across all open positions at once</span>
                </label>

                {/* Max Daily Loss Per Coin */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Daily Loss / Coin ($)</span>
                  <input type="number" min={0} max={100} step={0.5}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxDailyLossPerCoin ?? 3}
                    onChange={e => setConfigDraft(d => ({ ...d, maxDailyLossPerCoin: parseFloat(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Per-coin daily loss cap (0 = disabled)</span>
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

                {/* Max Slippage Cents */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Slippage (¢)</span>
                  <input type="number" min={0} max={50} step={1}
                    className="bg-background border border-amber-500/20 rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxSlippageCents ?? 5}
                    onChange={e => setConfigDraft(d => ({ ...d, maxSlippageCents: parseInt(e.target.value) }))} />
                  <span className="text-[10px] text-muted-foreground/60">Fill vs expected price warning threshold (0 = off)</span>
                </label>

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

                {/* Daily Loss Limit */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Daily Loss Limit ($)</span>
                  <input type="number" min={1} max={500} step={1}
                    className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.dailyLossLimit ?? 20}
                    onChange={e => setConfigDraft(d => ({ ...d, dailyLossLimit: parseFloat(e.target.value) }))} />
                </label>

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
                      { id: "classic",   label: "Classic",   desc: "Stat → Claude → ML cascade; ML boosts if it agrees" },
                      { id: "ml_gate",   label: "ML Gate",   desc: "Stat+Claude decide direction; ML vetos if it disagrees" },
                      { id: "consensus", label: "Consensus", desc: "≥2 of [Stat, Claude, ML] must agree on the same side" },
                      { id: "unanimous", label: "Unanimous", desc: "All 3 of [Stat, Claude, ML] must agree — highest conviction, fewest bets" },
                    ] as { id: DecisionMode; label: string; desc: string }[]).map(m => {
                      const isSelected = (merged.decisionMode ?? "classic") === m.id;
                      const needsML = m.id === "ml_gate" || m.id === "unanimous";
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setConfigDraft(d => ({ ...d, decisionMode: m.id }))}
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

                {/* Mode preset — save current config as a recall point for this mode */}
                <div className="col-span-2 flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Mode Preset</span>
                    <button
                      type="button"
                      disabled={savingPreset}
                      onClick={savePreset}
                      className="text-[10px] px-2.5 py-1 rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors disabled:opacity-50"
                    >
                      {savingPreset ? "Saving…" : `Save as ${(merged.decisionMode ?? "classic")} preset`}
                    </button>
                  </div>
                  {presetMsg && (
                    <span className={`text-[10px] ${presetMsg.includes("✓") ? "text-emerald-400" : "text-yellow-400"}`}>{presetMsg}</span>
                  )}
                  {(() => {
                    const dm = merged.decisionMode ?? "classic";
                    const p = presetsData?.presets?.[dm] as Record<string, unknown> | undefined;
                    if (!p) return (
                      <p className="text-[9px] text-muted-foreground/50">No preset saved for <span className="font-medium">{dm}</span> yet. Configure settings and save to auto-apply on next mode switch.</p>
                    );
                    return (
                      <p className="text-[9px] text-muted-foreground/60">
                        Preset saved for <span className="font-medium text-sky-400/80">{dm}</span> — auto-applied when you switch to this mode.
                        {typeof p.minConfidence === "number" && ` Min conf: ${p.minConfidence}%.`}
                        {typeof p.betSize === "number" && ` Bet: $${p.betSize}.`}
                      </p>
                    );
                  })()}
                </div>

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

                {/* Max Entry Time */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Latest Entry into Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxEntryMinutes ?? 11}
                    onChange={e => setConfigDraft(d => ({ ...d, maxEntryMinutes: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled (no ceiling)</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                      <option key={m} value={m}>{m} min in ({15 - m} min left)</option>
                    ))}
                  </select>
                </label>

                {/* Min Time Remaining */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Min Time Remaining</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minRemainingMinutes ?? 2}
                    onChange={e => setConfigDraft(d => ({ ...d, minRemainingMinutes: parseInt(e.target.value) }))}>
                    <option value={0}>Disabled (no floor)</option>
                    {[1, 2, 3, 4, 5, 6, 7].map(m => (
                      <option key={m} value={m}>Don&apos;t enter with &lt;{m} min left</option>
                    ))}
                  </select>
                </label>

                {/* Window Entry Buffer */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Window Entry Buffer ({merged.windowEntryBufferSeconds ?? 120}s)
                  </span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.windowEntryBufferSeconds ?? 120}
                    onChange={e => setConfigDraft(d => ({ ...d, windowEntryBufferSeconds: parseInt(e.target.value) }))}>
                    {[60, 90, 120, 150, 180, 210, 240].map(s => (
                      <option key={s} value={s}>{s}s ({Math.floor(s / 60)}m{s % 60 ? ` ${s % 60}s` : ""} after window open)</option>
                    ))}
                  </select>
                </label>

                {/* Max Bets Per Window */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Max Bets / Window</span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.maxBetsPerWindow ?? 8}
                    onChange={e => setConfigDraft(d => ({ ...d, maxBetsPerWindow: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} bet{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </label>

                {/* Quiet Hours Start */}
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

                {/* Quiet Hours End */}
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
            </div>
          )}
        </div>


    </>
  );
}
