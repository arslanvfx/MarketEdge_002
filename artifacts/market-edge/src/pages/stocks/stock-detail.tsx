import { useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip, ReferenceLine,
} from "recharts";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  TrendingUp, TrendingDown, Loader2, AlertTriangle, ExternalLink, CalendarClock, Newspaper, Brain, Cpu, LineChart as LineIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  stockGet, closeStockPosition, fmtUsd, fmtPct, fmtSignedUsd, sentimentColor,
  type AnalystRating, type StockAnalysis, type Candle, type BotStatus, type Direction,
} from "@/lib/stocks-api";

// ─── Bollinger Bands over close prices (period 20, 2σ) ───────────────────────
function bollinger(candles: Candle[], period = 20, mult = 2) {
  return candles.map((_, i) => {
    if (i < period - 1) return { mid: null, upper: null, lower: null };
    const slice = candles.slice(i - period + 1, i + 1).map((c) => c.c);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
  });
}

function rsiSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let gains = 0, losses = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(null); continue; }
    const diff = candles[i].c - candles[i - 1].c;
    const gain = Math.max(0, diff);
    const loss = Math.max(0, -diff);
    if (i <= period) {
      gains += gain; losses += loss;
      if (i === period) {
        const rs = losses === 0 ? 100 : gains / losses;
        out.push(100 - 100 / (1 + rs));
      } else out.push(null);
    } else {
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / losses;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

// ─── SVG candlestick chart with Bollinger overlay ────────────────────────────
function CandleChart({ candles }: { candles: Candle[] }) {
  const W = 640, H = 240, padL = 48, padR = 12, padT = 12, padB = 20;
  const bb = useMemo(() => bollinger(candles), [candles]);

  if (candles.length < 2) {
    return <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">No chart data</div>;
  }

  const lows = candles.map((c) => c.l);
  const highs = candles.map((c) => c.h);
  const bbLow = bb.map((b) => b.lower).filter((v): v is number => v != null);
  const bbHigh = bb.map((b) => b.upper).filter((v): v is number => v != null);
  const min = Math.min(...lows, ...bbLow);
  const max = Math.max(...highs, ...bbHigh);
  const range = max - min || 1;

  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (i: number) => padL + (i / (candles.length - 1)) * plotW;
  const y = (v: number) => padT + (1 - (v - min) / range) * plotH;
  const cw = Math.max(1.5, (plotW / candles.length) * 0.6);

  const bandPath = (key: "upper" | "lower" | "mid") => {
    const pts = bb.map((b, i) => (b[key] != null ? `${x(i)},${y(b[key]!)}` : null)).filter(Boolean);
    return pts.join(" ");
  };

  const gridVals = [min, min + range * 0.25, min + range * 0.5, min + range * 0.75, max];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[240px]" preserveAspectRatio="none">
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke="currentColor" className="text-border" strokeWidth={0.5} opacity={0.4} />
          <text x={4} y={y(v) + 3} className="fill-muted-foreground" fontSize={9}>{v.toFixed(2)}</text>
        </g>
      ))}
      {/* Bollinger bands */}
      <polyline points={bandPath("upper")} fill="none" stroke="#38bdf8" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
      <polyline points={bandPath("lower")} fill="none" stroke="#38bdf8" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
      <polyline points={bandPath("mid")} fill="none" stroke="#a78bfa" strokeWidth={1} opacity={0.5} />
      {/* Candles */}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const color = up ? "#34d399" : "#f87171";
        const bodyTop = y(Math.max(c.o, c.c));
        const bodyBot = y(Math.min(c.o, c.c));
        return (
          <g key={i}>
            <line x1={x(i)} y1={y(c.h)} x2={x(i)} y2={y(c.l)} stroke={color} strokeWidth={1} />
            <rect x={x(i) - cw / 2} y={bodyTop} width={cw} height={Math.max(1, bodyBot - bodyTop)} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

function DirBadge({ dir, confidence }: { dir: Direction; confidence: number }) {
  const up = dir === "up";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded ${up ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"}`}>
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {up ? "LONG" : "SHORT"} · {Math.round(confidence)}%
    </span>
  );
}

function RatingBadge({ rating }: { rating: AnalystRating }) {
  const cfg = {
    buy:  { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400", label: "BUY" },
    sell: { cls: "border-red-500/40 bg-red-500/10 text-red-400",             label: "SELL" },
    hold: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400",       label: "HOLD" },
  }[rating];
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function ConfidenceBar({ label, icon: Icon, dir, confidence, reasoning, muted, rating }: {
  label: string; icon: typeof Brain; dir?: Direction; confidence?: number; reasoning?: string; muted?: string; rating?: AnalystRating;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          {label}
        </span>
        <div className="flex items-center gap-1.5">
          {rating && <RatingBadge rating={rating} />}
          {muted ? <span className="text-[11px] text-muted-foreground">{muted}</span>
            : dir && confidence != null ? <DirBadge dir={dir} confidence={confidence} /> : null}
        </div>
      </div>
      {!muted && confidence != null && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={`h-full ${dir === "up" ? "bg-emerald-400" : "bg-red-400"}`} style={{ width: `${Math.min(100, Math.max(0, confidence))}%` }} />
        </div>
      )}
      {reasoning && <p className="text-[11px] text-muted-foreground mt-1.5 line-clamp-3">{reasoning}</p>}
    </div>
  );
}

export function StockDetail({ ticker, onClose }: { ticker: string | null; onClose: () => void }) {
  const open = !!ticker;
  const { getToken } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);

  const { data, isLoading, error } = useQuery<StockAnalysis>({
    queryKey: ["stock-analysis", ticker],
    queryFn: () => stockGet<StockAnalysis>(`/analysis/${ticker}`),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
    retry: false,
  });

  const { data: botStatus } = useQuery<BotStatus>({
    queryKey: ["stocks-bot-status"],
    queryFn: () => stockGet<BotStatus>("/bot/status"),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });

  const held = botStatus?.positions?.find((p) => p.ticker === ticker) ?? null;

  async function handleClose() {
    if (!ticker) return;
    setClosing(true);
    try {
      const r = await closeStockPosition(getToken, ticker);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["stocks-bot-status"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-positions"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-history"] }),
        qc.invalidateQueries({ queryKey: ["stocks-bot-pnl"] }),
      ]);
      toast({
        title: `Closed ${r.ticker}`,
        description: `Sold ${r.qty} @ ${fmtUsd(r.exitPrice)} · P&L ${fmtSignedUsd(r.pnl)}`,
      });
    } catch (e) {
      toast({
        title: "Could not close position",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    } finally {
      setClosing(false);
      setConfirmClose(false);
    }
  }

  const rsiData = useMemo(() => {
    if (!data?.candles) return [];
    const rsi = rsiSeries(data.candles);
    return data.candles.map((c, i) => ({ i, t: c.t, rsi: rsi[i] })).filter((d) => d.rsi != null);
  }, [data?.candles]);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
        <SheetHeader className="px-6 pt-6 pb-3 border-b border-border">
          <SheetTitle className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-foreground">{ticker}</span>
              <span className="text-sm text-muted-foreground font-normal">{data?.companyName}</span>
            </div>
            {data && (
              <div className="text-right">
                <div className="text-lg font-bold text-foreground">{fmtUsd(data.price)}</div>
                <div className={`text-xs font-semibold ${data.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtPct(data.changePct)}</div>
              </div>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="p-6 space-y-5">
          {isLoading && (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading analysis…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Analysis unavailable. This usually means the broker is not connected or there is insufficient recent market data for {ticker}.</span>
            </div>
          )}

          {data && (
            <>
              {/* Combined verdict */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Combined signal</div>
                  <DirBadge dir={data.combinedDirection} confidence={data.combinedConfidence} />
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>Sector: <span className="text-foreground">{data.sector}</span></div>
                  <div>RSI: <span className="text-foreground">{Math.round(data.stat.rsi)}</span> · ER: <span className="text-foreground">{data.stat.efficiencyRatio.toFixed(2)}</span></div>
                </div>
              </div>

              {/* Chart */}
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-2">
                  <LineIcon className="w-3.5 h-3.5" /> 5-min candles · Bollinger Bands (20, 2σ)
                </div>
                <CandleChart candles={data.candles} />
                {rsiData.length > 3 && (
                  <div className="mt-2">
                    <div className="text-[11px] text-muted-foreground mb-1">RSI (14)</div>
                    <ResponsiveContainer width="100%" height={70}>
                      <LineChart data={rsiData} margin={{ top: 4, right: 12, bottom: 0, left: -18 }}>
                        <XAxis dataKey="i" hide />
                        <YAxis domain={[0, 100]} ticks={[30, 70]} tick={{ fontSize: 9 }} width={28} />
                        <ReferenceLine y={70} stroke="#f87171" strokeDasharray="3 3" opacity={0.5} />
                        <ReferenceLine y={30} stroke="#34d399" strokeDasharray="3 3" opacity={0.5} />
                        <RTooltip contentStyle={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(216 34% 17%)", borderRadius: 8, fontSize: 11 }}
                          formatter={(v: number) => [Math.round(v), "RSI"]} labelFormatter={() => ""} />
                        <Line type="monotone" dataKey="rsi" stroke="#a78bfa" strokeWidth={1.5} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* Signals */}
              <div className="grid gap-3">
                <ConfidenceBar label="Statistical" icon={LineIcon} dir={data.stat.direction} confidence={data.stat.confidence} reasoning={data.stat.reasoning} />
                <ConfidenceBar label="Claude AI" icon={Brain}
                  dir={data.claude?.direction} confidence={data.claude?.confidence} reasoning={data.claude?.reasoning}
                  rating={data.claude?.rating}
                  muted={data.claude ? undefined : "not run"} />
                <ConfidenceBar label="Machine Learning" icon={Cpu}
                  dir={data.ml?.direction} confidence={data.ml?.confidence}
                  muted={data.ml?.ready ? undefined : `training${data.ml?.windows != null ? ` · ${data.ml.windows}/${data.ml.minWindows ?? 30}` : ""}`} />
              </div>

              {/* Held position */}
              {held && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                  <div className="text-xs font-semibold text-emerald-400 mb-2">Bot is holding this stock</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><div className="text-muted-foreground">Qty</div><div className="text-foreground font-semibold">{held.qty}</div></div>
                    <div><div className="text-muted-foreground">Entry</div><div className="text-foreground font-semibold">{fmtUsd(held.avgEntry)}</div></div>
                    <div><div className="text-muted-foreground">Unreal. P&L</div><div className={`font-semibold ${held.unrealizedPl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtUsd(held.unrealizedPl)} ({fmtPct(held.unrealizedPlpc)})</div></div>
                  </div>
                  <div className="mt-3 flex items-center justify-end">
                    {confirmClose ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">Sell all {held.qty} shares at market?</span>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2.5 text-xs"
                          disabled={closing}
                          onClick={handleClose}
                          data-testid={`confirm-close-${held.ticker}`}
                        >
                          {closing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm close"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={closing}
                          onClick={() => setConfirmClose(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setConfirmClose(true)}
                        data-testid={`close-${held.ticker}`}
                      >
                        Close position
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Earnings */}
              {data.earnings && (
                <div className={`rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${data.earnings.soon ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-border bg-card text-muted-foreground"}`}>
                  <CalendarClock className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Next earnings {new Date(data.earnings.date).toLocaleDateString([], { month: "short", day: "numeric" })}
                    {data.earnings.soon && ` · within blackout (${Math.round(data.earnings.hoursUntil)}h)`}
                  </span>
                </div>
              )}

              {/* News */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-2">
                  <Newspaper className="w-3.5 h-3.5" /> Top news
                </div>
                {data.news.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent news.</p>
                ) : (
                  <div className="space-y-2">
                    {data.news.slice(0, 3).map((n) => (
                      <a key={n.id} href={n.url} target="_blank" rel="noreferrer"
                        className="block rounded-lg border border-border bg-card p-3 hover:border-emerald-500/40 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs text-foreground line-clamp-2">{n.headline}</span>
                          {n.url && <ExternalLink className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-0.5" />}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          {n.sentiment && (
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${sentimentColor(n.sentiment)}`}>{n.sentiment}</span>
                          )}
                          {n.source && <span className="text-[10px] text-muted-foreground">{n.source}</span>}
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
