import { useState } from "react";
import { Calendar, Clock, ChevronDown, ChevronUp, Database } from "lucide-react";
import { EST } from "./utils";

export interface TimeAnalyticsRow {
  symbol: string;
  dow: number;
  hour: number;
  wins: number;
  losses: number;
  total: number;
}

interface Props {
  rows: TimeAnalyticsRow[];
  totalBets: number;
  lastUpdated: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN_BETS_DOW = 3;
const MIN_BETS_HOUR = 2;

function utcHourToEst(utcHour: number): string {
  const d = new Date(Date.UTC(2000, 0, 1, utcHour));
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true, timeZone: EST }).replace(":00", "");
}

function wrColor(wr: number, bets: number, min: number): string {
  if (bets < min) return "bg-muted/30";
  if (wr >= 0.65) return "bg-emerald-500";
  if (wr >= 0.55) return "bg-sky-500";
  if (wr >= 0.40) return "bg-yellow-500";
  return "bg-red-500";
}

function wrTextColor(wr: number, bets: number, min: number): string {
  if (bets < min) return "text-muted-foreground/50";
  if (wr >= 0.65) return "text-emerald-400";
  if (wr >= 0.55) return "text-sky-400";
  if (wr >= 0.40) return "text-yellow-400";
  return "text-red-400";
}

interface Bucket { wins: number; losses: number; total: number }

function aggregate(rows: TimeAnalyticsRow[], coin: string): {
  dow: Record<number, Bucket>;
  hour: Record<number, Bucket>;
  total: number;
} {
  const dow: Record<number, Bucket> = {};
  const hour: Record<number, Bucket> = {};
  for (let d = 0; d < 7; d++) dow[d] = { wins: 0, losses: 0, total: 0 };
  for (let h = 0; h < 24; h++) hour[h] = { wins: 0, losses: 0, total: 0 };
  let total = 0;
  for (const r of rows) {
    if (coin !== "ALL" && r.symbol !== coin) continue;
    dow[r.dow].wins    += r.wins;
    dow[r.dow].losses  += r.losses;
    dow[r.dow].total   += r.total;
    hour[r.hour].wins   += r.wins;
    hour[r.hour].losses += r.losses;
    hour[r.hour].total  += r.total;
    total += r.total;
  }
  return { dow, hour, total };
}

export function TimingAnalytics({ rows, totalBets, lastUpdated }: Props) {
  const [open, setOpen] = useState(false);
  const [coin, setCoin] = useState("ALL");

  const coins = ["ALL", ...Array.from(new Set(rows.map(r => r.symbol))).sort()];
  const { dow, hour, total } = aggregate(rows, coin);

  const dowDays = [1,2,3,4,5,6,0].map(d => ({ d, ...dow[d] }));
  const maxDowTotal = Math.max(...dowDays.map(x => x.total), 1);

  const hourBars = Array.from({ length: 24 }, (_, h) => ({ h, ...hour[h] }));
  const maxHourTotal = Math.max(...hourBars.map(x => x.total), 1);

  const bestDow = dowDays
    .filter(x => x.total >= MIN_BETS_DOW)
    .reduce<typeof dowDays[0] | null>((b, x) => {
      const wr = x.total > 0 ? x.wins / x.total : 0;
      const bwr = b && b.total > 0 ? b.wins / b.total : 0;
      return wr > bwr ? x : b;
    }, null);

  const bestHour = hourBars
    .filter(x => x.total >= MIN_BETS_HOUR)
    .reduce<typeof hourBars[0] | null>((b, x) => {
      const wr = x.total > 0 ? x.wins / x.total : 0;
      const bwr = b && b.total > 0 ? b.wins / b.total : 0;
      return wr > bwr ? x : b;
    }, null);

  const pct = (b: Bucket) => b.total > 0 ? Math.round((b.wins / b.total) * 100) : null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full px-5 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <Database className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm">Timing Analytics</h2>
        <span className="ml-1 text-[10px] text-muted-foreground bg-violet-500/10 px-2 py-0.5 rounded-full">
          Paper + Live · All-time
        </span>
        {totalBets > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {totalBets} bets total
          </span>
        )}
        {open ? <ChevronUp className="w-4 h-4 ml-1 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 ml-1 text-muted-foreground" />}
      </button>

      {open && (
        <div className="p-5 space-y-5">
          <p className="text-[10px] text-muted-foreground">
            All-time win/loss data across paper and live bets — never erased. Use this to identify the best days and hours to bet per coin.
          </p>

          {/* Coin selector */}
          <div className="flex flex-wrap gap-1.5">
            {coins.map(c => (
              <button
                key={c}
                onClick={() => setCoin(c)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-colors ${
                  coin === c
                    ? "bg-violet-500 text-white"
                    : "bg-muted/30 text-muted-foreground hover:bg-muted/60"
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          {total === 0 ? (
            <p className="text-sm text-muted-foreground italic">No settled bets for this coin yet.</p>
          ) : (
            <>
              {/* Best time summary */}
              {(bestDow || bestHour) && (
                <div className="grid grid-cols-2 gap-3">
                  {bestDow && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-center">
                      <div className="text-[9px] uppercase tracking-wide text-emerald-400 mb-1">Best Day</div>
                      <div className="text-base font-bold text-emerald-300">{DAY_NAMES[bestDow.d]}</div>
                      <div className="text-[10px] text-emerald-400/80 font-semibold">
                        {Math.round((bestDow.wins / bestDow.total) * 100)}% WR · {bestDow.total} bets
                      </div>
                    </div>
                  )}
                  {bestHour && (
                    <div className="bg-sky-500/10 border border-sky-500/20 rounded-lg p-3 text-center">
                      <div className="text-[9px] uppercase tracking-wide text-sky-400 mb-1">Best Hour (EST)</div>
                      <div className="text-base font-bold text-sky-300">{utcHourToEst(bestHour.h)}</div>
                      <div className="text-[10px] text-sky-400/80 font-semibold">
                        {Math.round((bestHour.wins / bestHour.total) * 100)}% WR · {bestHour.total} bets
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Day of week */}
              <div>
                <div className="flex items-center gap-1.5 mb-3">
                  <Calendar className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Day of Week</span>
                  <span className="text-[10px] text-muted-foreground/50">· {total} bets · UTC</span>
                </div>
                <div className="flex gap-1.5">
                  {dowDays.map(({ d, wins, losses, total: t }) => {
                    const wr = t > 0 ? wins / t : 0;
                    const barH = t === 0 ? 4 : Math.max(8, Math.round(wr * 60));
                    const isTop = bestDow?.d === d && t >= MIN_BETS_DOW;
                    return (
                      <div key={d} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full flex items-end justify-center" style={{ height: 64 }}>
                          <div
                            className={`w-full rounded-t transition-all ${wrColor(wr, t, MIN_BETS_DOW)} ${isTop ? "ring-1 ring-emerald-400/70" : ""}`}
                            style={{ height: barH }}
                            title={`${DAY_NAMES[d]}: ${t} bets, ${t > 0 ? Math.round(wr * 100) : "—"}% WR (${wins}W/${losses}L)`}
                          />
                        </div>
                        <div className="text-[9px] font-medium text-muted-foreground">{DAY_NAMES[d]}</div>
                        <div className={`text-[9px] font-bold ${wrTextColor(wr, t, MIN_BETS_DOW)}`}>
                          {t === 0 ? "—" : `${Math.round(wr * 100)}%`}
                        </div>
                        <div className="text-[8px] text-muted-foreground/40">{t}b</div>
                      </div>
                    );
                  })}
                </div>
                <div className="text-[9px] text-muted-foreground/40 mt-1">Faded bars = &lt;{MIN_BETS_DOW} bets</div>
              </div>

              {/* Hour of day */}
              <div>
                <div className="flex items-center gap-1.5 mb-3">
                  <Clock className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Rate by Hour of Day (EST)</span>
                </div>
                <div className="flex gap-px">
                  {hourBars.map(({ h, wins, losses, total: t }) => {
                    const wr = t > 0 ? wins / t : 0;
                    const barH = t === 0 ? 3 : Math.max(5, Math.round(wr * 52));
                    const isTop = bestHour?.h === h && t >= MIN_BETS_HOUR;
                    return (
                      <div
                        key={h}
                        className="flex-1 flex flex-col items-center gap-px"
                        title={`${utcHourToEst(h)} EST — ${t} bets${t > 0 ? `, ${Math.round(wr * 100)}% WR (${wins}W/${losses}L)` : ""}`}
                      >
                        <div className="w-full flex items-end" style={{ height: 56 }}>
                          <div
                            className={`w-full rounded-sm ${wrColor(wr, t, MIN_BETS_HOUR)} ${isTop ? "ring-1 ring-emerald-400/60" : ""}`}
                            style={{ height: barH }}
                          />
                        </div>
                        {h % 6 === 0 && (
                          <div className="text-[8px] text-muted-foreground/60">
                            {utcHourToEst(h).replace(" AM","a").replace(" PM","p")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground/40 mt-0.5 px-px">
                  <span>7PM</span><span>1AM</span><span>7AM</span><span>1PM</span><span>6PM</span>
                </div>
                <div className="text-[9px] text-muted-foreground/40 mt-1">Hover bars · Labels every 6h EST · Faded = &lt;{MIN_BETS_HOUR} bets</div>
              </div>

              {/* Per-coin table (only shown in ALL view with enough data) */}
              {coin === "ALL" && coins.length > 2 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Per-Coin Summary</div>
                  <div className="space-y-1">
                    {coins.filter(c => c !== "ALL").map(c => {
                      const coinRows = rows.filter(r => r.symbol === c);
                      const coinTotal = coinRows.reduce((s, r) => s + r.total, 0);
                      const coinWins  = coinRows.reduce((s, r) => s + r.wins,  0);
                      if (coinTotal === 0) return null;
                      const wr = coinWins / coinTotal;
                      const bestCoinDow = [1,2,3,4,5,6,0]
                        .map(d => {
                          const b = coinRows.filter(r => r.dow === d).reduce((acc, r) => ({ wins: acc.wins + r.wins, total: acc.total + r.total }), { wins: 0, total: 0 });
                          return { d, ...b };
                        })
                        .filter(x => x.total >= MIN_BETS_DOW)
                        .sort((a, b) => (b.wins / Math.max(b.total, 1)) - (a.wins / Math.max(a.total, 1)))[0];
                      const bestCoinHour = Array.from({ length: 24 }, (_, h) => {
                        const b = coinRows.filter(r => r.hour === h).reduce((acc, r) => ({ wins: acc.wins + r.wins, total: acc.total + r.total }), { wins: 0, total: 0 });
                        return { h, ...b };
                      })
                        .filter(x => x.total >= MIN_BETS_HOUR)
                        .sort((a, b) => (b.wins / Math.max(b.total, 1)) - (a.wins / Math.max(a.total, 1)))[0];
                      return (
                        <div key={c} className="flex items-center gap-3 bg-background/30 rounded-lg px-3 py-2">
                          <span className="text-xs font-bold w-10 flex-shrink-0">{c}</span>
                          <span className={`text-[10px] font-bold w-8 ${wrTextColor(wr, coinTotal, 1)}`}>
                            {Math.round(wr * 100)}%
                          </span>
                          <span className="text-[10px] text-muted-foreground">{coinWins}W/{coinTotal - coinWins}L</span>
                          <div className="ml-auto flex items-center gap-3 text-[9px] text-muted-foreground">
                            {bestCoinDow && (
                              <span className="text-emerald-400/80">📅 {DAY_NAMES[bestCoinDow.d]} {Math.round((bestCoinDow.wins / bestCoinDow.total) * 100)}%</span>
                            )}
                            {bestCoinHour && (
                              <span className="text-sky-400/80">🕐 {utcHourToEst(bestCoinHour.h)} {Math.round((bestCoinHour.wins / bestCoinHour.total) * 100)}%</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="text-[9px] text-muted-foreground/40">
                Data pulled from all settled bets · Last queried {new Date(lastUpdated).toLocaleTimeString()}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
