import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronUp, Power, Lock, AlertTriangle, Loader2 } from "lucide-react";
import type { BotStateSnapshot, BotBetRecord, BotStats, TrendPoint, CoinBotStats } from "./types";
import { fetchJson, API_BASE } from "./utils";

function WinRateTrend({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;
  const H = 36;
  const PAD = 2;
  const n = points.length;

  const pts = points.map((p, i) => ({
    x: (i / (n - 1)) * 100,
    y: H - PAD - p.rollingWinRate * (H - PAD * 2),
    ...p,
  }));

  const pathD = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const midY = H - PAD - 0.5 * (H - PAD * 2);
  const last = pts[pts.length - 1];
  const lineColor = (last?.rollingWinRate ?? 0) >= 0.5 ? "#34d399" : "#f87171";

  return (
    <div>
      {/* Dot row: last 20 bets, oldest → newest */}
      <div className="flex gap-px mb-1.5">
        {points.slice(-20).map((p, i) => (
          <div
            key={i}
            title={`${p.symbol}: ${p.outcome} (${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)})`}
            className={`w-2 h-2 rounded-sm flex-shrink-0 ${
              p.outcome === "win" ? "bg-emerald-400" : "bg-red-500"
            }`}
          />
        ))}
      </div>
      {/* Rolling win-rate line */}
      <svg
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        className="w-full h-9"
        aria-label="Win rate trend"
      >
        <line
          x1="0" y1={midY} x2="100" y2={midY}
          stroke="#334155" strokeWidth="0.5" strokeDasharray="2,2"
        />
        <path
          d={pathD}
          fill="none"
          stroke={lineColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.9"
        />
        {last && (
          <circle
            cx={last.x.toFixed(1)}
            cy={last.y.toFixed(1)}
            r="2"
            fill={lineColor}
          />
        )}
      </svg>
      <div className="flex justify-between text-[9px] text-slate-600">
        <span>{points.length} bets</span>
        <span>
          rolling win rate:{" "}
          <span style={{ color: lineColor }}>
            {((last?.rollingWinRate ?? 0) * 100).toFixed(0)}%
          </span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-coin breakdown table (collapsible) — used inside KalshiBotPanel
// ---------------------------------------------------------------------------

function PerCoinBreakdown({ rows }: { rows: CoinBotStats[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Per-coin breakdown
      </button>
      {expanded && (
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800/50">
                <th className="text-left pb-1 font-medium">Coin</th>
                <th className="text-right pb-1 font-medium">Bets</th>
                <th className="text-right pb-1 font-medium text-emerald-500">W</th>
                <th className="text-right pb-1 font-medium text-red-500">L</th>
                <th className="text-right pb-1 font-medium">P&L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-b border-slate-800/20">
                  <td className="py-0.5 font-semibold text-slate-200">{r.symbol}</td>
                  <td className="py-0.5 text-right text-slate-300 tabular-nums">{r.bets}</td>
                  <td className="py-0.5 text-right text-emerald-400 tabular-nums">{r.wins}</td>
                  <td className="py-0.5 text-right text-red-400 tabular-nums">{r.losses}</td>
                  <td className={`py-0.5 text-right font-medium tabular-nums ${r.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kalshi Bot Panel
// ---------------------------------------------------------------------------

export function KalshiBotPanel() {
  const [open, setOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [localBetSize, setLocalBetSize] = useState<number>(0.5);
  const [localDailyLimit, setLocalDailyLimit] = useState<number>(20);
  const [localPhase2Pp, setLocalPhase2Pp] = useState<number>(30);
  const [localMinConfidence, setLocalMinConfidence] = useState<number>(60);
  const [localMaxEntryMinutes, setLocalMaxEntryMinutes] = useState<number>(3);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const botQuery = useQuery<BotStateSnapshot>({
    queryKey: ["bot-status"],
    queryFn: () => fetchJson<BotStateSnapshot>("/crypto/bot/status"),
    refetchInterval: 10_000,
  });

  // Use the active bot mode so stats/trend sparkline reflect the running mode only.
  const botActiveMode = botQuery.data?.mode ?? "paper";

  const historyQuery = useQuery<{ history: BotBetRecord[] }>({
    queryKey: ["bot-history", botActiveMode],
    queryFn: () => fetchJson<{ history: BotBetRecord[] }>(`/crypto/bot/history?limit=10&mode=${botActiveMode}`),
    refetchInterval: 30_000,
    enabled: open,
  });

  const statsQuery = useQuery<BotStats>({
    queryKey: ["bot-stats", botActiveMode],
    queryFn: () => fetchJson<BotStats>(`/crypto/bot/stats?mode=${botActiveMode}`),
    refetchInterval: 60_000,
    enabled: open,
  });

  const trendQuery = useQuery<TrendPoint[]>({
    queryKey: ["bot-trend", botActiveMode],
    queryFn: () => fetchJson<TrendPoint[]>(`/crypto/bot/trend?limit=50&mode=${botActiveMode}`),
    refetchInterval: 60_000,
    enabled: open,
  });

  const bot = botQuery.data;

  async function postJson(path: string, body: unknown) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      throw new Error((err as { error?: string }).error ?? "Request failed");
    }
    return res.json();
  }

  async function togglePause() {
    if (!bot) return;
    await postJson("/crypto/bot/pause", { paused: !bot.paused });
    void botQuery.refetch();
  }

  async function switchMode(mode: "paper" | "live") {
    if (mode === "live" && !confirmLive) { setConfirmLive(true); return; }
    setConfirmLive(false);
    await postJson("/crypto/bot/mode", { mode });
    void botQuery.refetch();
  }

  async function saveConfig() {
    setSaveStatus("saving");
    try {
      const result = await postJson("/crypto/bot/config", {
        betSize: localBetSize,
        dailyLossLimit: localDailyLimit,
        phase2ThresholdPp: localPhase2Pp,
        minConfidence: localMinConfidence,
        maxEntryMinutes: localMaxEntryMinutes,
      }) as { ok: boolean; persisted: boolean };
      setSaveStatus(result.persisted ? "saved" : "failed");
      void botQuery.refetch();
    } catch {
      setSaveStatus("failed");
    }
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  // Sync local sliders with server state on first load
  useEffect(() => {
    if (bot?.config && !configOpen) {
      setLocalBetSize(bot.config.betSize);
      setLocalDailyLimit(bot.config.dailyLossLimit);
      setLocalPhase2Pp(bot.config.phase2ThresholdPp);
      setLocalMinConfidence(bot.config.minConfidence ?? 60);
      setLocalMaxEntryMinutes(bot.config.maxEntryMinutes ?? 3);
    }
  }, [bot?.config, configOpen]);

  const statusColor = !bot
    ? "text-slate-400"
    : bot.status === "position_open"
    ? "text-emerald-400"
    : bot.status === "daily_limit_hit"
    ? "text-red-400"
    : bot.status === "paused"
    ? "text-yellow-400"
    : "text-slate-400";

  const guards = bot?.lastGuardStates;

  function GuardDot({ ok, label }: { ok: boolean; label: string }) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400/60"}`} />
        {label}
      </span>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-cyan-800/40 bg-cyan-950/20 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-cyan-900/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-400" />
          <span className="text-sm font-semibold text-cyan-300">Kalshi Bot</span>
          {bot && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              bot.mode === "live"
                ? "bg-red-900/50 text-red-300"
                : "bg-cyan-900/40 text-cyan-300"
            }`}>
              {bot.mode.toUpperCase()}
            </span>
          )}
          {bot && (
            <span className={`text-xs font-medium ${statusColor}`}>
              {bot.status === "position_open"
                ? `Open: ${bot.openPosition?.symbol} ${bot.openPosition?.direction?.toUpperCase()}`
                : bot.status === "daily_limit_hit"
                ? "Daily limit hit"
                : bot.status === "paused"
                ? "Paused"
                : bot.warmupSecondsRemaining != null && bot.warmupSecondsRemaining > 0
                ? `Warming up — entry in ${Math.ceil(bot.warmupSecondsRemaining)}s`
                : "Idle"}
            </span>
          )}
          {bot && (
            <span className={`text-xs tabular-nums ${bot.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {bot.dailyPnl >= 0 ? "+" : ""}${bot.dailyPnl.toFixed(2)} today
            </span>
          )}
          {botQuery.isLoading && <Loader2 className="h-3 w-3 animate-spin text-cyan-400 ml-1" />}
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-cyan-400" /> : <ChevronDown className="h-4 w-4 text-cyan-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3">
          {!bot?.configured && (
            <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-900/20 rounded p-2">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>
                No <code className="font-mono">KALSHI_API_KEY</code> secret configured — bot runs in paper mode only.
                Add the secret to enable live trading.
              </span>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => void togglePause()}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-medium transition-colors ${
                bot?.paused
                  ? "bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50"
                  : "bg-slate-700/50 text-slate-300 hover:bg-slate-700/80"
              }`}
            >
              <Power className="h-3 w-3" />
              {bot?.paused ? "Resume Bot" : "Pause Bot"}
            </button>

            {!confirmLive ? (
              <button
                onClick={() => void switchMode(bot?.mode === "paper" ? "live" : "paper")}
                disabled={!bot?.configured && bot?.mode !== "live"}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-medium transition-colors ${
                  bot?.mode === "live"
                    ? "bg-slate-700/50 text-slate-300 hover:bg-slate-700/80"
                    : "bg-red-900/30 text-red-300 hover:bg-red-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
                }`}
              >
                <Lock className="h-3 w-3" />
                {bot?.mode === "live" ? "Switch to Paper" : "Enable Live Mode"}
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-red-300">Real money — confirm?</span>
                <button
                  onClick={() => void switchMode("live")}
                  className="text-xs px-2 py-1 rounded bg-red-700/50 text-red-200 hover:bg-red-700/80"
                >Yes</button>
                <button
                  onClick={() => setConfirmLive(false)}
                  className="text-xs px-2 py-1 rounded bg-slate-700/50 text-slate-300 hover:bg-slate-700/80"
                >Cancel</button>
              </div>
            )}

            {bot?.accountBalance != null && (
              <span className="text-xs text-slate-400 ml-auto">
                Balance: <span className="text-slate-200 font-medium">${bot.accountBalance.toFixed(2)}</span>
              </span>
            )}
          </div>

          {/* Open Position */}
          {bot?.openPosition && (
            <div className={`rounded border p-3 space-y-2 ${
              bot.openPosition.direction === "yes"
                ? "border-emerald-700/40 bg-emerald-950/20"
                : "border-red-700/40 bg-red-950/20"
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-200">{bot.openPosition.symbol}</span>
                  <span className={`text-xs font-black ${bot.openPosition.direction === "yes" ? "text-emerald-400" : "text-red-400"}`}>
                    {bot.openPosition.direction.toUpperCase()}
                  </span>
                  <span className="text-xs text-slate-400">
                    {bot.openPosition.contractCount}× @ {(bot.openPosition.entryYesPrice * 100).toFixed(0)}¢
                  </span>
                  {bot.openPositionCurrentYesPrice != null && (
                    <span className="text-xs text-slate-400">
                      → <span className="text-slate-200">{(bot.openPositionCurrentYesPrice * 100).toFixed(0)}¢</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {bot.openPositionUnrealizedPnl != null && (
                    <span className={`text-xs font-semibold ${bot.openPositionUnrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {bot.openPositionUnrealizedPnl >= 0 ? "+" : ""}${bot.openPositionUnrealizedPnl.toFixed(2)} unrlzd
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {bot.lastGuardStates?.phase2Active
                      ? <span className="text-orange-400 font-semibold">⚠ Phase 2 — Recovery Mode</span>
                      : <span className="text-slate-400">Phase 1 — Mid-window</span>
                    }
                  </span>
                </div>
              </div>
              {bot.lastGuardReason && (
                <p className="text-[10px] text-slate-400 italic">{bot.lastGuardReason}</p>
              )}
              {guards && !guards.phase2Active && (
                <div className="flex flex-wrap gap-1 pt-1">
                  <GuardDot ok={guards.holdDurationOk} label="Hold≥4min" />
                  <GuardDot ok={guards.flipConfirmed} label="3-tick flip" />
                  <GuardDot ok={guards.magnitudeOk} label="20pp move" />
                  <GuardDot ok={guards.consensusOk} label="Consensus" />
                  <GuardDot ok={!guards.timingOverride} label="No TmgOverride" />
                  <GuardDot ok={guards.erOk} label="ER≥0.3" />
                </div>
              )}
              {guards?.phase2Active && (
                <div className="flex flex-wrap gap-1 pt-1">
                  <GuardDot ok={true} label="Phase 2 active" />
                  {guards.phase2RecentLow !== null && (
                    <span className="text-[10px] text-slate-400">
                      Low: {(guards.phase2RecentLow * 100).toFixed(0)}¢
                      {guards.phase2YesPrice !== null && ` / Now: ${(guards.phase2YesPrice * 100).toFixed(0)}¢`}
                    </span>
                  )}
                  {guards.phase2UptickDetected && <GuardDot ok={true} label="Uptick!" />}
                  {guards.phase2Timeout && <GuardDot ok={false} label="Timeout" />}
                </div>
              )}
            </div>
          )}

          {/* Stats bar */}
          {statsQuery.data && (
            <div className="border-t border-slate-800/60 pt-2 space-y-2">
              <div className="flex flex-wrap gap-3 text-xs text-slate-400">
                <span>Bets: <span className="text-slate-200">{statsQuery.data.totalBets}</span></span>
                <span className="text-emerald-400">{statsQuery.data.wins}W</span>
                <span className="text-red-400">{statsQuery.data.losses}L</span>
                <span className={statsQuery.data.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                  P&L: {statsQuery.data.totalPnl >= 0 ? "+" : ""}${statsQuery.data.totalPnl.toFixed(2)}
                </span>
              </div>
              {/* Paper vs Live breakdown */}
              <div className="flex flex-wrap gap-3 text-[10px] text-slate-500">
                {statsQuery.data.paperBets > 0 && (
                  <span>
                    Paper: {statsQuery.data.paperBets} bets
                    {" · "}
                    <span className="text-emerald-500">{statsQuery.data.paperWins}W</span>
                    {" / "}
                    <span className="text-red-500">{statsQuery.data.paperLosses}L</span>
                  </span>
                )}
                {statsQuery.data.liveBets > 0 && (
                  <span>
                    Live: {statsQuery.data.liveBets} bets
                    {" · "}
                    <span className="text-emerald-400">{statsQuery.data.liveWins}W</span>
                    {" / "}
                    <span className="text-red-400">{statsQuery.data.liveLosses}L</span>
                  </span>
                )}
                {statsQuery.data.paperBets === 0 && statsQuery.data.liveBets === 0 && (
                  <span>Paper: 0 bets / Live: 0 bets</span>
                )}
              </div>
              {statsQuery.data.bySymbol.length > 0 && (
                <PerCoinBreakdown rows={statsQuery.data.bySymbol} />
              )}
              {/* Win-rate trend sparkline */}
              {trendQuery.data && trendQuery.data.length >= 2 && (
                <div className="pt-1">
                  <p className="text-[10px] text-slate-500 mb-1">Win-rate trend (rolling 10)</p>
                  <WinRateTrend points={trendQuery.data} />
                </div>
              )}
            </div>
          )}

          {/* Recent bets */}
          {historyQuery.data && historyQuery.data.history.length > 0 && (
            <div>
              <p className="text-xs text-slate-500 mb-1.5">Recent bets</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-800/50">
                      <th className="text-left pb-1 font-medium">Coin</th>
                      <th className="text-left pb-1 font-medium">Dir</th>
                      <th className="text-right pb-1 font-medium">Entry</th>
                      <th className="text-right pb-1 font-medium">Exit</th>
                      <th className="text-right pb-1 font-medium">P&L</th>
                      <th className="text-right pb-1 font-medium">Result</th>
                      <th className="text-right pb-1 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyQuery.data.history.map((b) => {
                      const pnl = b.pnl != null ? parseFloat(b.pnl) : null;
                      return (
                        <tr key={b.id} className="border-b border-slate-800/20">
                          <td className="py-1 font-medium text-slate-200">{b.symbol}</td>
                          <td className={`py-1 font-black ${b.direction === "yes" ? "text-emerald-400" : b.direction === "no" ? "text-red-400" : "text-slate-500"}`}>
                            {b.direction?.toUpperCase() ?? "—"}
                          </td>
                          <td className="py-1 text-right text-slate-400">
                            {b.entryPrice != null ? `${(parseFloat(b.entryPrice) * 100).toFixed(0)}¢` : "—"}
                          </td>
                          <td className="py-1 text-right text-slate-400">
                            {b.exitPrice != null ? `${(parseFloat(b.exitPrice) * 100).toFixed(0)}¢` : b.action === "skip" ? "skip" : "open"}
                          </td>
                          <td className={`py-1 text-right font-medium tabular-nums ${pnl === null ? "text-slate-600" : pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {pnl !== null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—"}
                          </td>
                          <td className="py-1 text-right">
                            {b.outcome === "win" ? (
                              <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-emerald-500/20 text-emerald-400 font-bold text-[9px]">W</span>
                            ) : b.outcome === "loss" ? (
                              <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-red-500/20 text-red-400 font-bold text-[9px]">L</span>
                            ) : b.outcome === "push" ? (
                              <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-slate-700/60 text-slate-400 font-bold text-[9px]">P</span>
                            ) : (
                              <span className="text-slate-700 text-[9px]">…</span>
                            )}
                          </td>
                          <td className="py-1 text-right text-slate-600 max-w-[120px] truncate">
                            {b.phase2Activated && <span className="text-orange-400 mr-1">P2</span>}
                            {b.exitReason?.slice(0, 30) ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Config */}
          <div className="border-t border-slate-800/60 pt-2">
            <button
              onClick={() => setConfigOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {configOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Settings
            </button>
            {configOpen && bot && (
              <div className="mt-2 space-y-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    Bet size: <span className="text-slate-200 font-medium">${localBetSize.toFixed(2)}</span>
                  </label>
                  <input
                    type="range" min={0.5} max={25} step={0.5}
                    value={localBetSize}
                    onChange={(e) => setLocalBetSize(parseFloat(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>$0.50</span><span>$25</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    Daily loss limit: <span className="text-slate-200 font-medium">${localDailyLimit}</span>
                  </label>
                  <input
                    type="range" min={5} max={200} step={5}
                    value={localDailyLimit}
                    onChange={(e) => setLocalDailyLimit(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>$5</span><span>$200</span>
                  </div>
                </div>
                <div className="flex gap-2 text-xs">
                  <span className="text-slate-400">Signal threshold: </span>
                  {([2, 3, 4] as const).map((n) => (
                    <button
                      key={n}
                      onClick={() => void postJson("/crypto/bot/config", { signalThreshold: n }).then(() => void botQuery.refetch())}
                      className={`px-2 py-0.5 rounded ${bot.config.signalThreshold === n ? "bg-cyan-700/50 text-cyan-200" : "bg-slate-700/50 text-slate-400 hover:bg-slate-700"}`}
                    >
                      {n}/4
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 text-xs">
                  <span className="text-slate-400">Exit sensitivity: </span>
                  {(["conservative", "balanced", "aggressive"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => void postJson("/crypto/bot/config", { midExitSensitivity: s }).then(() => void botQuery.refetch())}
                      className={`px-2 py-0.5 rounded capitalize ${bot.config.midExitSensitivity === s ? "bg-cyan-700/50 text-cyan-200" : "bg-slate-700/50 text-slate-400 hover:bg-slate-700"}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    Phase 2 threshold: <span className="text-slate-200 font-medium">{localPhase2Pp}pp below entry</span>
                    <span className="text-slate-600 ml-1">(activates damage-control exit when losing by this much)</span>
                  </label>
                  <input
                    type="range" min={10} max={50} step={5}
                    value={localPhase2Pp}
                    onChange={(e) => setLocalPhase2Pp(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>10pp</span><span>50pp</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    Min confidence: <span className="text-slate-200 font-medium">{localMinConfidence}%</span>
                    <span className="text-slate-600 ml-1">(skip bet if signal agreement is below this)</span>
                  </label>
                  <input
                    type="range" min={40} max={100} step={5}
                    value={localMinConfidence}
                    onChange={(e) => setLocalMinConfidence(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>40%</span><span>100%</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">
                    Max entry time: <span className="text-slate-200 font-medium">{localMaxEntryMinutes} min</span>
                    <span className="text-slate-600 ml-1">(don't enter after this many minutes into the window; warmup always 45s)</span>
                  </label>
                  <input
                    type="range" min={1} max={7} step={1}
                    value={localMaxEntryMinutes}
                    onChange={(e) => setLocalMaxEntryMinutes(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>1 min</span><span>7 min</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void saveConfig()}
                    disabled={saveStatus === "saving"}
                    className="text-xs px-3 py-1.5 rounded bg-cyan-700/40 text-cyan-200 hover:bg-cyan-700/60 disabled:opacity-50"
                  >
                    {saveStatus === "saving" ? "Saving…" : "Save"}
                  </button>
                  {saveStatus === "saved" && (
                    <span className="text-xs text-emerald-400">✓ Settings saved</span>
                  )}
                  {saveStatus === "failed" && (
                    <span className="text-xs text-yellow-400">⚠ Applied (not persisted)</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
