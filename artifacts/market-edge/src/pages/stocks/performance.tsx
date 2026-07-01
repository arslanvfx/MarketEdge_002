import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, ResponsiveContainer,
  Tooltip as RTooltip, ReferenceLine, Cell,
} from "recharts";
import { Loader2, Trophy, TrendingUp, TrendingDown } from "lucide-react";
import { StocksShell } from "./stocks-shell";
import {
  stockGet, fmtSignedUsd,
  type HistoryRow, type StockPnl, type BotStatus,
} from "@/lib/stocks-api";

interface Bucket { key: string; wins: number; losses: number; pnl: number; }

function winRate(b: Bucket): number | null {
  const n = b.wins + b.losses;
  return n === 0 ? null : (b.wins / n) * 100;
}

export default function StockPerformance() {
  const { data: histData, isLoading } = useQuery<{ history: HistoryRow[] }>({
    queryKey: ["stocks-bot-history"],
    queryFn: () => stockGet("/bot/history?limit=500"),
    refetchInterval: 10_000,
  });
  const { data: pnl } = useQuery<StockPnl>({
    queryKey: ["stocks-bot-pnl"],
    queryFn: () => stockGet("/bot/pnl"),
    refetchInterval: 10_000,
  });
  const { data: status } = useQuery<BotStatus>({
    queryKey: ["stocks-bot-status"],
    queryFn: () => stockGet("/bot/status"),
    refetchInterval: 10_000,
  });

  // The summary cards come from /bot/pnl, which the backend scopes to the bot's
  // current mode (paper/live). Filter the history-derived charts to the same
  // mode so both views describe the same trades.
  const mode = status?.config.mode;
  const rows = histData?.history ?? [];
  const closed = useMemo(
    () => rows.filter(
      (r) => r.exited_at && r.outcome && r.outcome !== "push" && (!mode || r.mode === mode),
    ),
    [rows, mode],
  );

  // Cumulative P&L over time (oldest → newest)
  const pnlSeries = useMemo(() => {
    const sorted = [...closed]
      .filter((r) => r.exited_at)
      .sort((a, b) => new Date(a.exited_at!).getTime() - new Date(b.exited_at!).getTime());
    let cum = 0;
    return sorted.map((r, i) => {
      cum += Number(r.pnl) || 0;
      return { i: i + 1, cum: Number(cum.toFixed(2)), date: r.exited_at! };
    });
  }, [closed]);

  const bucketBy = (fn: (r: HistoryRow) => string | null) => {
    const map = new Map<string, Bucket>();
    for (const r of closed) {
      const k = fn(r);
      if (!k) continue;
      const b = map.get(k) ?? { key: k, wins: 0, losses: 0, pnl: 0 };
      if (r.outcome === "win") b.wins++;
      else if (r.outcome === "loss") b.losses++;
      b.pnl += Number(r.pnl) || 0;
      map.set(k, b);
    }
    return Array.from(map.values());
  };

  const bySector = useMemo(() => bucketBy((r) => r.sector).map((b) => ({ ...b, winRate: winRate(b) })), [closed]);
  const byMode = useMemo(() => bucketBy((r) => r.trading_mode).map((b) => ({ ...b, winRate: winRate(b) })), [closed]);
  const byTicker = useMemo(() => bucketBy((r) => r.ticker), [closed]);

  const bestTickers = useMemo(() => [...byTicker].sort((a, b) => b.pnl - a.pnl).slice(0, 5), [byTicker]);
  const worstTickers = useMemo(() => [...byTicker].sort((a, b) => a.pnl - b.pnl).slice(0, 5), [byTicker]);

  const modeLabel = (k: string) => (k === "day" ? "Day" : k === "swing" ? "Swing" : k === "long" ? "Long" : k);

  return (
    <StocksShell>
      <div className="p-6 space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total P&L", value: fmtSignedUsd(pnl?.totalPnl ?? 0), color: (pnl?.totalPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
            { label: "Today's P&L", value: fmtSignedUsd(pnl?.todayPnl ?? 0), color: (pnl?.todayPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
            { label: "Win Rate", value: pnl ? `${Math.round(pnl.winRate * 100)}%` : "—", sub: pnl ? `${pnl.wins}W / ${pnl.losses}L` : undefined, color: "text-violet-400" },
            { label: "Open / Closed", value: pnl ? `${pnl.open} / ${pnl.closed}` : "—", color: "text-sky-400" },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-4">
              <div className="text-xs text-muted-foreground mb-1">{label}</div>
              <div className={`text-xl font-bold ${color}`}>{value}</div>
              {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="h-40 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading performance…
          </div>
        ) : closed.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <p>No closed trades yet.</p>
            <p className="text-xs mt-1">Performance analytics build up as the bot completes trades.</p>
          </div>
        ) : (
          <>
            {/* Cumulative P&L */}
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-bold text-foreground mb-3">Cumulative P&L</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={pnlSeries} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                  <XAxis dataKey="i" tick={{ fontSize: 10 }} stroke="hsl(215 20% 65%)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(215 20% 65%)" tickFormatter={(v) => `$${v}`} />
                  <ReferenceLine y={0} stroke="hsl(216 34% 30%)" />
                  <RTooltip contentStyle={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(216 34% 17%)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number) => [fmtSignedUsd(v), "Cumulative"]} labelFormatter={(l) => `Trade #${l}`} />
                  <Line type="monotone" dataKey="cum" stroke="#34d399" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </section>

            {/* Win rate by sector & mode */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <section className="rounded-lg border border-border bg-card p-5">
                <h2 className="text-sm font-bold text-foreground mb-3">Win Rate by Sector</h2>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={bySector} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                    <XAxis dataKey="key" tick={{ fontSize: 10 }} stroke="hsl(215 20% 65%)" />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="hsl(215 20% 65%)" tickFormatter={(v) => `${v}%`} />
                    <RTooltip contentStyle={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(216 34% 17%)", borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number, _n, p) => [`${Math.round(v)}% (${(p.payload as Bucket).wins}W/${(p.payload as Bucket).losses}L)`, "Win rate"]} />
                    <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                      {bySector.map((b, i) => (
                        <Cell key={i} fill={(b.winRate ?? 0) >= 50 ? "#34d399" : "#f87171"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </section>

              <section className="rounded-lg border border-border bg-card p-5">
                <h2 className="text-sm font-bold text-foreground mb-3">Win Rate by Trading Mode</h2>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={byMode.map((b) => ({ ...b, label: modeLabel(b.key) }))} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(215 20% 65%)" />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="hsl(215 20% 65%)" tickFormatter={(v) => `${v}%`} />
                    <RTooltip contentStyle={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(216 34% 17%)", borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number, _n, p) => [`${Math.round(v)}% (${(p.payload as Bucket).wins}W/${(p.payload as Bucket).losses}L)`, "Win rate"]} />
                    <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                      {byMode.map((b, i) => (
                        <Cell key={i} fill={(b.winRate ?? 0) >= 50 ? "#818cf8" : "#f87171"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </section>
            </div>

            {/* Best / worst tickers */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <TickerBoard title="Best Performers" icon={Trophy} tickers={bestTickers} positive />
              <TickerBoard title="Worst Performers" icon={TrendingDown} tickers={worstTickers} positive={false} />
            </div>
          </>
        )}
      </div>
    </StocksShell>
  );
}

function TickerBoard({ title, icon: Icon, tickers, positive }: {
  title: string; icon: typeof Trophy; tickers: Bucket[]; positive: boolean;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
        <Icon className={`w-4 h-4 ${positive ? "text-emerald-400" : "text-red-400"}`} /> {title}
      </h2>
      {tickers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <div className="space-y-1.5">
          {tickers.map((t) => (
            <div key={t.key} className="flex items-center justify-between text-sm">
              <span className="font-semibold text-foreground">{t.key}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{t.wins}W / {t.losses}L</span>
                <span className={`font-semibold w-20 text-right ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtSignedUsd(t.pnl)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
