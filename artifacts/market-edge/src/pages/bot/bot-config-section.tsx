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

export function BotConfigSection({ cfg, merged, configDraft, setConfigDraft, saving, saveConfig, persistMsg, status, activeMode, presetsData, modeDefaults, savingPreset, savePreset, presetMsg, backtestData, configOpen, setConfigOpen, authPost, qc }: BotConfigSectionProps) {
  const hasDraft = Object.keys(configDraft).length > 0;
  const [defaultsAppliedFor, setDefaultsAppliedFor] = React.useState<string | null>(null);
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

                {!isConviction && (<>
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
                      { id: "position_confirm", label: "Position Confirm", desc: "Bet on WHERE price IS (above/below strike) — models become vetoes, not predictors" },
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

                {/* Price Buffer — only shown in Position Confirm mode */}
                {(merged.decisionMode ?? "classic") === "position_confirm" && (
                  <div className="col-span-2 flex flex-col gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 p-3">
                    <span className="text-xs font-medium text-sky-400 flex items-center gap-1.5">
                      <Target className="w-3 h-3" />
                      Position Confirm Settings
                    </span>
                    <span className="text-[11px] text-muted-foreground/80 leading-relaxed">
                      Instead of predicting where price will go, the bot bets on where it <em>already is</em> relative to the Kalshi strike.
                      Models become soft vetoes — if ≥2 disagree with the current position, the bet is skipped.
                      Works best paired with <strong>Earliest Entry: 7–8 min</strong> so there&apos;s less time left for a reversal.
                    </span>
                    <label className="flex flex-col gap-1.5 mt-1">
                      <span className="text-xs text-muted-foreground">
                        Price Buffer — {(merged.priceBufferPct ?? 0) === 0 ? "Off (any distance from strike)" : `${merged.priceBufferPct ?? 0}% min distance from strike`}
                      </span>
                      <div className="flex items-center gap-3">
                        <input type="range" min={0} max={1} step={0.05}
                          className="flex-1"
                          value={merged.priceBufferPct ?? 0}
                          onChange={e => setConfigDraft(d => ({ ...d, priceBufferPct: parseFloat(e.target.value) }))} />
                        <span className="text-xs font-mono text-sky-400 w-12 text-right">
                          {(merged.priceBufferPct ?? 0) === 0 ? "Off" : `${(merged.priceBufferPct ?? 0).toFixed(2)}%`}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70">
                        {(merged.priceBufferPct ?? 0) === 0
                          ? "Any price position qualifies — bet fires as soon as models don't veto"
                          : `Price must be ≥${(merged.priceBufferPct ?? 0).toFixed(2)}% above/below the Kalshi strike — smaller buffer = more bets, larger = safer cushion against reversals`}
                      </span>
                    </label>
                  </div>
                )}

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
                    <label className="flex flex-col gap-1.5 mt-1">
                      <span className="text-xs text-muted-foreground">
                        Kalshi Price Trigger — {(merged.kalshiLockPrice ?? 0.90).toFixed(2)} ({((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢)
                      </span>
                      <div className="flex items-center gap-3">
                        <input type="range" min={0.80} max={0.97} step={0.01}
                          className="flex-1 accent-violet-500"
                          value={merged.kalshiLockPrice ?? 0.90}
                          onChange={e => setConfigDraft(d => ({ ...d, kalshiLockPrice: parseFloat(e.target.value) }))} />
                        <span className="text-xs font-mono text-violet-400 w-16 text-right">
                          {((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢ / {((1 - (merged.kalshiLockPrice ?? 0.90)) * 100).toFixed(0)}¢
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70">
                        BET YES when Kalshi YES ≥ {((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢ · BET NO when YES ≤ {((1 - (merged.kalshiLockPrice ?? 0.90)) * 100).toFixed(0)}¢.
                        Higher threshold = fewer bets, higher certainty. 90¢ means the market assigns 90%+ probability.
                        Max payout at {((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢ entry: {(1 / (merged.kalshiLockPrice ?? 0.90)).toFixed(2)}×.
                      </span>
                    </label>
                    {/* Resting GTC toggle */}
                    <label className="flex items-center gap-2 mt-1 cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-violet-500 w-3.5 h-3.5"
                        checked={merged.useRestingLimitOrders !== false}
                        onChange={e => setConfigDraft(d => ({ ...d, useRestingLimitOrders: e.target.checked }))}
                      />
                      <span className="text-xs text-muted-foreground">
                        Resting GTC pre-position — place a limit order at lock price when market enters the pre-entry zone
                      </span>
                    </label>
                    {/* Pre-entry threshold slider — only shown when resting is enabled */}
                    {merged.useRestingLimitOrders !== false && (
                      <>
                        <label className="flex flex-col gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground">
                            Pre-entry Zone — {((merged.preConvictionThreshold ?? 0.87) * 100).toFixed(0)}¢ to {((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢
                          </span>
                          <div className="flex items-center gap-3">
                            <input type="range" min={0.75} max={0.95} step={0.01}
                              className="flex-1 accent-violet-500"
                              value={merged.preConvictionThreshold ?? 0.87}
                              onChange={e => setConfigDraft(d => ({ ...d, preConvictionThreshold: parseFloat(e.target.value) }))} />
                            <span className="text-xs font-mono text-violet-400 w-16 text-right">
                              {((merged.preConvictionThreshold ?? 0.87) * 100).toFixed(0)}¢
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground/70">
                            When YES price enters this zone a GTC limit order is queued at the lock price (
                            {((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢). Catches gaps where the
                            market jumps from {((merged.preConvictionThreshold ?? 0.87) * 100).toFixed(0)}¢
                            directly to 96¢+ without stopping at {((merged.kalshiLockPrice ?? 0.90) * 100).toFixed(0)}¢.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground">
                            GTC Entry Gate — arm when {(merged.convictionRestingWindowMinutes ?? 5) === 0 ? "any time" : `≤ ${merged.convictionRestingWindowMinutes ?? 5} min remain`}
                            {(merged.convictionRestingWindowMinutes ?? 5) === 0 && <span className="text-amber-400 ml-1">(arms any time)</span>}
                          </span>
                          <div className="flex items-center gap-3">
                            <input type="range" min={0} max={14} step={1}
                              className="flex-1 accent-violet-500"
                              value={merged.convictionRestingWindowMinutes ?? 5}
                              onChange={e => setConfigDraft(d => ({ ...d, convictionRestingWindowMinutes: parseInt(e.target.value, 10) }))} />
                            <span className="text-xs font-mono text-violet-400 w-16 text-right">
                              {(merged.convictionRestingWindowMinutes ?? 5) === 0 ? "any time" : `≤ ${merged.convictionRestingWindowMinutes ?? 5} min`}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground/70">
                            Only queue the resting GTC when this many minutes or fewer remain. With time
                            to spare the price can reverse before the window closes. Default 5 min = only
                            pre-position in the final stretch. Set to 0 to arm immediately.
                          </span>
                        </label>
                      </>
                    )}
                  </div>
                )}

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
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    No Bets Before
                    {(merged.minWindowEntryMinutes ?? 0) > 0 && (
                      <span className="ml-1 text-amber-400">T+{merged.minWindowEntryMinutes}m</span>
                    )}
                  </span>
                  <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                    value={merged.minWindowEntryMinutes ?? 0}
                    onChange={e => setConfigDraft(d => ({ ...d, minWindowEntryMinutes: parseInt(e.target.value, 10) }))}>
                    <option value={0}>No lockout — bets allowed immediately</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                      <option key={m} value={m}>Block first {m} min (override at ≥92¢ / ≤8¢)</option>
                    ))}
                  </select>
                  {(merged.minWindowEntryMinutes ?? 0) > 0 && (
                    <span className="text-xs text-muted-foreground/70">
                      No bets in the first {merged.minWindowEntryMinutes} min unless YES price hits ≥92¢ or ≤8¢.
                    </span>
                  )}
                </label>

                {!isConviction && (<>
                {/* ── Entry Timing ───────────────────────────────── */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Entry Timing</span>

                  {/* Earliest Entry (betDelayMinutes) */}
                  <label className="flex flex-col gap-1.5 mt-1">
                    <span className="text-xs text-muted-foreground">Earliest Entry</span>
                    <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                      value={merged.betDelayMinutes ?? 0}
                      onChange={e => setConfigDraft(d => ({ ...d, betDelayMinutes: parseInt(e.target.value) }))}>
                      <option value={0}>Immediately — enter as soon as signals are ready (~T+2 min)</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(m => (
                        <option key={m} value={m}>Wait {m} min — re-analyze at T+{m}m, then bet</option>
                      ))}
                    </select>
                    <span className="text-xs text-muted-foreground/70">
                      "Wait" holds the entry and runs a fresh Claude analysis at the deadline — so the bot acts on current market direction, not the opening snapshot.
                    </span>
                  </label>

                  {/* Latest Entry (maxEntryMinutes) */}
                  <label className="flex flex-col gap-1.5 mt-1">
                    <span className="text-xs text-muted-foreground">Latest Entry</span>
                    <select className="bg-background border border-border rounded-md px-3 py-1.5 text-sm text-foreground"
                      value={merged.maxEntryMinutes ?? 11}
                      onChange={e => setConfigDraft(d => ({ ...d, maxEntryMinutes: parseInt(e.target.value) }))}>
                      <option value={0}>No ceiling — enter any time signals are ready</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(m => (
                        <option key={m} value={m}>By T+{m} min ({15 - m} min left in window)</option>
                      ))}
                    </select>
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

                </>)}
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
