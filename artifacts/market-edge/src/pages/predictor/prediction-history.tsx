import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Minus, Trash2, ClipboardList, Clock, CheckCircle2, XCircle, Lock, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PredictionRecord } from "./types";
import { fetchJson, formatPrice, API_BASE } from "./utils";

export function PredictionHistory({ symbol, tz }: { symbol: string; tz: string }) {
  const ACCURACY_THRESHOLD = 1.0; // fallback for non-BTC / no Kalshi target

  // ── Clear-log dialog state ─────────────────────────────────────────────────
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearPassword, setClearPassword]     = useState("");
  const [clearPasswordError, setClearPasswordError] = useState<string | null>(null);
  const [clearing, setClearing]               = useState(false);

  function openClearDialog() {
    setClearPassword("");
    setClearPasswordError(null);
    setClearDialogOpen(true);
  }

  async function handleSoftClear(e: React.FormEvent) {
    e.preventDefault();
    setClearPasswordError(null);
    setClearing(true);
    try {
      const res = await fetch(`${API_BASE}/crypto/prediction-history/old`, {
        method: "DELETE",
        headers: { "x-clear-password": clearPassword },
      });
      if (res.status === 401) { setClearPasswordError("Incorrect password — try again."); return; }
      if (!res.ok) { setClearPasswordError("Server error — please retry."); return; }
      await query.refetch();
      setClearDialogOpen(false);
    } finally {
      setClearing(false);
    }
  }

  async function handleAccuracyOnlyClear(e: React.FormEvent) {
    e.preventDefault();
    setClearPasswordError(null);
    setClearing(true);
    try {
      const res = await fetch(`${API_BASE}/crypto/prediction-history/accuracy-only`, {
        method: "DELETE",
        headers: { "x-clear-password": clearPassword },
      });
      if (res.status === 401) { setClearPasswordError("Incorrect password — try again."); return; }
      if (!res.ok) { setClearPasswordError("Server error — please retry."); return; }
      await query.refetch();
      setClearDialogOpen(false);
    } finally {
      setClearing(false);
    }
  }

  async function handleFullReset(e: React.FormEvent) {
    e.preventDefault();
    setClearPasswordError(null);
    setClearing(true);
    try {
      const res = await fetch(`${API_BASE}/crypto/prediction-history`, {
        method: "DELETE",
        headers: { "x-clear-password": clearPassword },
      });
      if (res.status === 401) { setClearPasswordError("Incorrect password — try again."); return; }
      if (!res.ok) { setClearPasswordError("Server error — please retry."); return; }
      await query.refetch();
      setClearDialogOpen(false);
    } finally {
      setClearing(false);
    }
  }

  type SourceSummary = { hits: number; total: number; pct: number | null };
  const query = useQuery({
    queryKey: ["pred-history", symbol],
    queryFn: () =>
      fetchJson<{
        symbol: string;
        history: PredictionRecord[];
        sourceSummary?: { stat: SourceSummary; claude: SourceSummary; ensemble: SourceSummary; ml: SourceSummary };
        windowGroups?: { targetTime: string; records: PredictionRecord[] }[];
        abstention?: { evaluated: number; avoidedLoss: number; missedWin: number; avoidedLossPct: number | null };
        accuracyThresholdPct: number;
      }>(`/crypto/prediction-history?symbol=${symbol}`),
    refetchInterval: 30_000,
  });

  const history = query.data?.history ?? [];
  const evaluated = history.filter((r) => r.status === "evaluated");
  // Headline accuracy counts BET windows only — abstentions ("no bet") are not
  // wins or losses, so they're excluded from the hit-rate denominator.
  const headlineBets = evaluated.filter((r) => r.abstained !== true);
  const hits = headlineBets.filter((r) => r.correct === true).length;
  const accuracyPct = headlineBets.length > 0 ? Math.round((hits / headlineBets.length) * 100) : null;

  // Per-source hit rates come from the server rollup (over ALL records, not just
  // the one-per-window headlines shown below) so each model's rate is accurate.
  const empty: SourceSummary = { hits: 0, total: 0, pct: null };
  const claudeStats = query.data?.sourceSummary?.claude ?? empty;
  const statStats = query.data?.sourceSummary?.stat ?? empty;
  const ensembleStats = query.data?.sourceSummary?.ensemble ?? empty;
  const mlStats = query.data?.sourceSummary?.ml ?? empty;
  const abstention = query.data?.abstention;

  // Build a lookup from targetTime → all model records for the per-model strip on each card
  const windowGroupMap = new Map<string, PredictionRecord[]>();
  for (const wg of query.data?.windowGroups ?? []) {
    windowGroupMap.set(wg.targetTime, wg.records);
  }

  // Does any record in this history have a Kalshi target? (true for BTC during market hours)
  const hasKalshiData = history.some((r) => r.kalshiTarget !== null && r.kalshiTarget !== undefined);

  const accentClass = (rec: PredictionRecord) => {
    if (rec.status === "pending") return "border-l-amber-400/70";
    return rec.correct ? "border-l-emerald-500" : "border-l-red-500";
  };

  const dirLabel = (d: "up" | "down" | "flat") => {
    if (d === "up") return <TrendingUp className="w-3 h-3 text-emerald-400" />;
    if (d === "down") return <TrendingDown className="w-3 h-3 text-red-400" />;
    return <Minus className="w-3 h-3 text-muted-foreground" />;
  };

  // Accuracy log needs fixed-width full precision so $1.07 and $1.0698 are distinguishable.
  const fmtPrice = (n: number): string => {
    if (!isFinite(n)) return "—";
    const dp = n >= 1000 ? 2 : n >= 100 ? 2 : n >= 10 ? 2 : n >= 1 ? 4 : 5;
    return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4 text-primary" />
            Prediction Accuracy Log
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {hasKalshiData ? "Above/below Kalshi target" : "Direction + within 1% of actual"} · last 30 · 30 s refresh
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-4">
          {(claudeStats.pct !== null || statStats.pct !== null || ensembleStats.pct !== null || mlStats.pct !== null) && (
            <div className="text-right text-[11px] leading-tight">
              {ensembleStats.pct !== null && (
                <div className="text-primary">
                  Combined{" "}
                  <span className="font-semibold tabular-nums">{ensembleStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({ensembleStats.hits}/{ensembleStats.total})</span>
                </div>
              )}
              {claudeStats.pct !== null && (
                <div className="text-violet-300">
                  Claude{" "}
                  <span className="font-semibold tabular-nums">{claudeStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({claudeStats.hits}/{claudeStats.total})</span>
                </div>
              )}
              {statStats.pct !== null && (
                <div className="text-sky-300">
                  Stat{" "}
                  <span className="font-semibold tabular-nums">{statStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({statStats.hits}/{statStats.total})</span>
                </div>
              )}
              {mlStats.pct !== null && (
                <div className="text-teal-300">
                  ML{" "}
                  <span className="font-semibold tabular-nums">{mlStats.pct}%</span>{" "}
                  <span className="text-muted-foreground">({mlStats.hits}/{mlStats.total})</span>
                </div>
              )}
              {abstention && abstention.evaluated > 0 && (
                <div className="text-amber-300/80">
                  No-bet{" "}
                  <span className="font-semibold tabular-nums">{abstention.avoidedLossPct ?? 0}%</span>{" "}
                  <span className="text-muted-foreground">avoided ({abstention.avoidedLoss}/{abstention.evaluated})</span>
                </div>
              )}
            </div>
          )}
          {accuracyPct !== null && (
            <div className="text-right">
              <div
                className={`text-3xl font-black leading-none tabular-nums ${
                  accuracyPct >= 60 ? "text-emerald-400" : accuracyPct >= 40 ? "text-amber-400" : "text-red-400"
                }`}
              >
                {accuracyPct}%
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">
                {hits} / {headlineBets.length} correct
              </div>
            </div>
          )}
          <button
            onClick={openClearDialog}
            disabled={clearing}
            title="Clear prediction history"
            className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Clear-log dialog ── */}
      <Dialog open={clearDialogOpen} onOpenChange={(open) => { if (!clearing) setClearDialogOpen(open); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Lock className="w-4 h-4 text-muted-foreground" />
              Clear prediction logs
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Enter the admin password to continue. Both actions below require it.
            </p>

            {/* Password field shared by both actions */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Password</label>
              <input
                type="password"
                value={clearPassword}
                onChange={(e) => { setClearPassword(e.target.value); setClearPasswordError(null); }}
                placeholder="••••••••••••"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
              {clearPasswordError && (
                <p className="text-xs text-red-400 mt-1.5">{clearPasswordError}</p>
              )}
            </div>

            {/* Soft clear */}
            <div className="rounded-lg border border-border/50 p-3 space-y-2">
              <div>
                <p className="text-xs font-semibold">Clear display log</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  Removes records older than 48 hours. Best Windows, auto-pilot accuracy stats, and ML training data are <span className="text-emerald-400 font-medium">kept intact</span>.
                </p>
              </div>
              <button
                onClick={handleSoftClear}
                disabled={clearing || !clearPassword}
                className="w-full rounded-md bg-muted/50 hover:bg-muted border border-border text-xs font-medium py-1.5 transition-colors disabled:opacity-40"
              >
                {clearing ? "Clearing…" : "Clear old logs only (>48 h)"}
              </button>
            </div>

            {/* Accuracy-only clear */}
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
              <div>
                <p className="text-xs font-semibold text-amber-400">Reset accuracy stats</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  Wipes <span className="text-amber-400 font-medium">all</span> prediction records so accuracy restarts from zero. ML training snapshots and model weights are <span className="text-emerald-400 font-medium">kept intact</span>.
                </p>
              </div>
              <button
                onClick={handleAccuracyOnlyClear}
                disabled={clearing || !clearPassword}
                className="w-full rounded-md bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-xs font-medium text-amber-400 py-1.5 transition-colors disabled:opacity-40"
              >
                {clearing ? "Clearing…" : "Reset accuracy — keep ML model"}
              </button>
            </div>

            {/* Full reset */}
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-2">
              <div>
                <p className="text-xs font-semibold text-red-400">Full reset</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  Wipes <span className="text-red-400 font-medium">all</span> prediction records, ML training snapshots, and ML model weights. Best Windows, auto-pilot history, and self-learning dashboard reset to zero. Cannot be undone.
                </p>
              </div>
              <button
                onClick={handleFullReset}
                disabled={clearing || !clearPassword}
                className="w-full rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs font-medium text-red-400 py-1.5 transition-colors disabled:opacity-40"
              >
                {clearing ? "Resetting…" : "Full reset — wipe everything"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Empty state ── */}
      {history.length === 0 ? (
        <Card className="p-8 bg-card/50 text-center">
          <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">Waiting for the next 15-minute mark…</p>
          <p className="text-xs text-muted-foreground mt-1 opacity-60">
            Records snap at :00, :15, :30, :45 each hour ({tz})
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((rec) => {
            const isPending = rec.status === "pending";
            const isAbstained = rec.abstained === true;
            const hasTarget = rec.kalshiTarget !== null && rec.kalshiTarget !== undefined;
            const predictedAbove = hasTarget && rec.predictedPrice >= rec.kalshiTarget!;
            const actualAbove    = hasTarget && rec.actualPrice !== null && rec.actualPrice >= rec.kalshiTarget!;

            const borderColor = isPending
              ? "border-l-amber-400/70"
              : isAbstained
              ? "border-l-muted-foreground/40"
              : rec.correct
              ? "border-l-emerald-500"
              : "border-l-red-500";

            const statusBadge = isPending ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded-full px-2.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Pending
              </span>
            ) : isAbstained ? (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground bg-muted/30 border border-border rounded-full px-2.5 py-0.5"
                title={
                  rec.status === "evaluated"
                    ? rec.correct
                      ? "Skipped — the would-be bet would have won (missed)"
                      : "Skipped — the would-be bet would have lost (good skip)"
                    : "No bet — models disagreed or confidence too low"
                }
              >
                <Minus className="w-3 h-3" /> No bet
              </span>
            ) : rec.correct ? (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-500/25 rounded-full px-2.5 py-0.5"
                title="Model accuracy: our above/below call matched the Coinbase price captured at window close. Kalshi settles on its own data source at the exact :00/:15/:30/:45 mark — your bet outcome may differ slightly."
              >
                <CheckCircle2 className="w-3 h-3" /> Hit
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-400 bg-red-400/10 border border-red-500/25 rounded-full px-2.5 py-0.5"
                title="Model accuracy: our above/below call did not match the Coinbase price captured at window close. Kalshi settles on its own data source at the exact :00/:15/:30/:45 mark — your bet outcome may differ slightly."
              >
                <XCircle className="w-3 h-3" /> Miss
              </span>
            );

            const sideLabel = (above: boolean) => (
              <span className={`font-bold ${above ? "text-emerald-400" : "text-red-400"}`}>
                {above ? "↑ Above" : "↓ Below"} target
              </span>
            );

            return (
              <div
                key={rec.id ?? rec.targetTime}
                className={`border-l-4 ${borderColor} rounded-r-xl bg-card/50 hover:bg-card/80 transition-colors overflow-hidden`}
              >
                {/* Card header — time + status badge */}
                <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border/40">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold tabular-nums">
                      {new Intl.DateTimeFormat("en-US", {
                        timeZone: "America/New_York",
                        hour: "numeric",
                        minute: "2-digit",
                        hour12: true,
                      }).format(new Date(new Date(rec.targetTime).getTime() - 15 * 60_000))}
                      {" – "}
                      {rec.targetLabel}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{tz}</span>
                  </div>
                  {statusBadge}
                </div>

                {/* Card body */}
                <div className="px-4 py-3 space-y-3">

                  {/* Side-by-side predicted vs actual — unified layout for all cards.
                      With Kalshi target: "↑ Above target" / "↓ Below target".
                      Without target: direction-based "↑ Up" / "↓ Down" labels. */}
                  {(() => {
                    // Direction label when no Kalshi target available
                    const dirSideLabel = (dir: "up" | "down" | "flat") => (
                      <span className={`font-bold ${dir === "up" ? "text-emerald-400" : dir === "down" ? "text-red-400" : "text-muted-foreground"}`}>
                        {dir === "up" ? "↑ Up" : dir === "down" ? "↓ Down" : "— Flat"}
                      </span>
                    );
                    // Infer actual direction vs predicted price when no target
                    const actualDir = (): "up" | "down" | "flat" => {
                      if (rec.actualPrice == null || rec.priceAtSnapshot == null) return "flat";
                      const ch = (rec.actualPrice - rec.priceAtSnapshot) / rec.priceAtSnapshot * 100;
                      return ch > 0.05 ? "up" : ch < -0.05 ? "down" : "flat";
                    };
                    return (
                      <div className="grid grid-cols-2 gap-3">
                        {/* Predicted */}
                        <div className="bg-background/30 rounded-lg px-3 py-2.5">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
                            Predicted
                          </div>
                          <div className="text-sm">
                            {hasTarget ? sideLabel(predictedAbove) : dirSideLabel(rec.predictedDirection)}
                          </div>
                          <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
                            ${fmtPrice(rec.predictedPrice)}
                          </div>
                        </div>

                        {/* Actual */}
                        <div className="bg-background/30 rounded-lg px-3 py-2.5">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
                            Actual
                          </div>
                          {isPending ? (
                            <div className="text-sm text-muted-foreground/50 italic">TBD</div>
                          ) : (
                            <>
                              <div className="text-sm">
                                {hasTarget ? sideLabel(actualAbove) : dirSideLabel(actualDir())}
                              </div>
                              <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
                                ${fmtPrice(rec.actualPrice!)}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Footer stats row */}
                  <div className="flex items-center gap-4 flex-wrap text-[11px]">
                    {hasTarget && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <span className="text-[#00C805] font-semibold">K</span>
                        <span>${formatPrice(rec.kalshiTarget!)}</span>
                      </div>
                    )}
                    {hasTarget && rec.priceAtSnapshot != null && rec.kalshiTarget != null && (() => {
                      const p = Math.abs(rec.priceAtSnapshot - rec.kalshiTarget) / rec.priceAtSnapshot * 100;
                      const cls = p >= 0.1
                        ? "text-emerald-400/70"
                        : p >= 0.03
                        ? "text-amber-400/70"
                        : "text-red-400/70";
                      const bucket = p >= 0.1 ? "edge" : p >= 0.03 ? "mod" : "line";
                      return (
                        <div className={`flex items-center gap-1 ${cls}`} title={`${p.toFixed(3)}% from Kalshi strike at snap`}>
                          <span className="opacity-70">Prox</span>
                          <span className="font-medium tabular-nums">{p.toFixed(2)}%</span>
                          <span className="opacity-60 text-[9px]">{bucket}</span>
                        </div>
                      );
                    })()}
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="opacity-60">Error</span>
                      {isPending ? (
                        <span className="opacity-40">—</span>
                      ) : (
                        <span
                          className={
                            rec.errorPct! <= ACCURACY_THRESHOLD
                              ? "text-emerald-400 font-medium"
                              : rec.errorPct! <= 2.0
                              ? "text-amber-400 font-medium"
                              : "text-red-400 font-medium"
                          }
                        >
                          {rec.errorPct!.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="opacity-60">Conf</span>
                      <span className="font-medium">{rec.confidence}%</span>
                    </div>
                  </div>

                  {/* Per-model verdict strip — shows all sources that ran for this window */}
                  {(() => {
                    const wgRecs = windowGroupMap.get(rec.targetTime) ?? [];
                    if (wgRecs.length === 0) return null;
                    const srcColor: Record<string, string> = {
                      ensemble: "text-primary",
                      claude: "text-violet-300",
                      stat: "text-sky-300",
                      ml: "text-teal-300",
                    };
                    const srcLabel: Record<string, string> = {
                      ensemble: "Combined",
                      claude: "Claude",
                      stat: "Stat",
                      ml: "ML",
                    };
                    return (
                      <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-border/30">
                        {wgRecs.map((r, i) => {
                          const rAbove = r.kalshiTarget != null
                            ? r.predictedPrice >= r.kalshiTarget
                            : r.predictedDirection === "up";
                          // Detect "locked at open": snapped within 2 min of window open
                          const windowOpenMs = new Date(r.targetTime).getTime() - 15 * 60_000;
                          const snappedMs = new Date(r.snappedAt).getTime();
                          const isLockedAtOpen = Math.abs(snappedMs - windowOpenMs) <= 2 * 60_000;
                          const badge = r.status === "pending" ? (
                            <span className="text-[9px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded px-1 py-0.5 leading-none">
                              Pending
                            </span>
                          ) : r.abstained ? (
                            <span className="text-[9px] font-semibold text-muted-foreground/70 bg-muted/30 border border-border/60 rounded px-1 py-0.5 leading-none">
                              Abstain
                            </span>
                          ) : r.correct ? (
                            <span className="text-[9px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-500/30 rounded px-1 py-0.5 leading-none">
                              Hit ✓
                            </span>
                          ) : (
                            <span className="text-[9px] font-semibold text-red-400 bg-red-400/10 border border-red-500/30 rounded px-1 py-0.5 leading-none">
                              Miss ✗
                            </span>
                          );
                          return (
                            <div
                              key={(r.source ?? "unknown") + "-" + i}
                              className="group flex items-center gap-1 text-[10px] cursor-default"
                              title={`${srcLabel[r.source ?? "stat"] ?? r.source}: ${r.confidence}% confidence${isLockedAtOpen ? " · locked at window open" : " · mid-window call"}`}
                            >
                              <span className={`font-semibold ${srcColor[r.source ?? "stat"] ?? "text-muted-foreground"}`}>
                                {srcLabel[r.source ?? "stat"] ?? r.source}
                              </span>
                              <span className={rAbove ? "text-emerald-400" : "text-red-400"}>{rAbove ? "↑" : "↓"}</span>
                              {isLockedAtOpen && (
                                <Lock className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0" />
                              )}
                              {/* Confidence — always visible, highlighted on hover */}
                              <span className="tabular-nums text-muted-foreground/50 group-hover:text-muted-foreground/90 transition-colors">
                                {r.confidence}%
                              </span>
                              {badge}
                            </div>
                          );
                        })}
                        {/* ML stub — shown when no ML record was stored for this window
                            (happens when Kalshi target was unavailable at snap time, so
                            the ML feature extraction couldn't run). */}
                        {!wgRecs.some((r) => r.source === "ml") && (
                          <div
                            className="flex items-center gap-1 text-[10px] cursor-default opacity-40"
                            title="ML model verdict not available for this window — Kalshi strike was not published when the snapshot was taken"
                          >
                            <span className="font-semibold text-teal-300">ML</span>
                            <span className="text-muted-foreground">—</span>
                            <span className="text-[9px] font-semibold text-muted-foreground/60 bg-muted/20 border border-border/40 rounded px-1 py-0.5 leading-none">
                              N/A
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-4 leading-relaxed">
        Predictions snap at each :00/:15/:30/:45 mark.{" "}
        {hasKalshiData
          ? "BTC hits scored against live Kalshi target — correct if the above/below call matches the outcome."
          : `A hit requires the correct direction call and price within ${ACCURACY_THRESHOLD}% of actual.`
        }{" "}
        History resets on server restart.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Win-rate sparkline — rolling 10-bet win rate rendered as dots + SVG line
// ---------------------------------------------------------------------------
