import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio, Clock } from "lucide-react";
import { API_BASE } from "./utils";

interface KalshiLiveCoin {
  sym: string;
  target: number | null;
  ticker: string | null;
  yesAsk: number | null;
  yesBid: number | null;
  yesPrice: number | null;
  noAsk: number | null;
  noBid: number | null;
  returnIfYesPct: number | null;
  returnIfNoPct: number | null;
  dataAgeMs: number | null;
  closeTime: string | null;
}

interface KalshiLiveResponse {
  coins: KalshiLiveCoin[];
  serverTime: number;
}

const COIN_ACCENT: Record<string, string> = {
  BTC:  "text-amber-400",
  ETH:  "text-indigo-400",
  SOL:  "text-fuchsia-400",
  XRP:  "text-sky-400",
  HYPE: "text-emerald-400",
  BNB:  "text-yellow-300",
  DOGE: "text-yellow-400",
  NEAR: "text-green-400",
  ZEC:  "text-orange-400",
};
const COIN_GLYPH: Record<string, string> = {
  BTC: "₿", ETH: "Ξ", SOL: "◎", XRP: "✕", HYPE: "H",
  BNB: "B", DOGE: "Ð", NEAR: "Ⓝ", ZEC: "ⓩ",
};

function fmtTarget(v: number | null): string {
  if (v == null) return "—";
  if (v >= 10000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 1000)  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 1)     return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

function fmtAge(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000)  return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtMinsLeft(closeTime: string | null): string | null {
  if (!closeTime) return null;
  const msLeft = new Date(closeTime).getTime() - Date.now();
  if (msLeft <= 0) return null;
  const s = Math.floor(msLeft / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m > 0 ? `${m}m ${ss}s` : `${ss}s`;
}

function AgeBadge({ ms }: { ms: number | null }) {
  const color =
    ms == null ? "text-muted-foreground/40" :
    ms < 2000  ? "text-emerald-400" :
    ms < 5000  ? "text-amber-400" :
                 "text-red-400";
  return (
    <span className={`text-[10px] font-mono tabular-nums ${color}`}>
      {fmtAge(ms)}
    </span>
  );
}

function ProbBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="relative h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

function CoinCard({ coin, flash }: { coin: KalshiLiveCoin; flash: "up" | "down" | null }) {
  const yesPct   = coin.yesAsk != null ? coin.yesAsk * 100 : null;
  const noPct    = coin.noAsk  != null ? coin.noAsk  * 100 : null;
  const minsLeft = fmtMinsLeft(coin.closeTime);
  const accent   = COIN_ACCENT[coin.sym] ?? "text-foreground";

  const ringClass =
    flash === "up"   ? "ring-1 ring-emerald-500/40 bg-emerald-500/5" :
    flash === "down" ? "ring-1 ring-red-500/40 bg-red-500/5" :
    "";

  return (
    <div className={`rounded-lg border border-border/60 p-3 transition-all duration-300 ${ringClass}`}>
      {/* Header: glyph + symbol + strike */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm font-bold leading-none ${accent}`}>
            {COIN_GLYPH[coin.sym] ?? coin.sym[0]}
          </span>
          <span className="text-xs font-bold text-foreground">{coin.sym}</span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">
          {fmtTarget(coin.target)}
        </span>
      </div>

      {/* YES row */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[10px] font-semibold text-emerald-400 tracking-wide">YES</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold tabular-nums text-emerald-300">
              {yesPct != null ? `${yesPct.toFixed(0)}¢` : "—"}
            </span>
            {coin.returnIfYesPct != null && (
              <span className="text-[10px] text-emerald-400/60 tabular-nums font-mono">
                +{coin.returnIfYesPct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        <ProbBar pct={yesPct ?? 0} color="bg-emerald-500/80" />
      </div>

      {/* NO row */}
      <div className="mb-2.5">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[10px] font-semibold text-red-400 tracking-wide">NO</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold tabular-nums text-red-300">
              {noPct != null ? `${noPct.toFixed(0)}¢` : "—"}
            </span>
            {coin.returnIfNoPct != null && (
              <span className="text-[10px] text-red-400/60 tabular-nums font-mono">
                +{coin.returnIfNoPct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        <ProbBar pct={noPct ?? 0} color="bg-red-500/80" />
      </div>

      {/* Footer: age + countdown */}
      <div className="flex items-center justify-between">
        <AgeBadge ms={coin.dataAgeMs} />
        {minsLeft && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/40 tabular-nums">
            <Clock className="w-2.5 h-2.5 shrink-0" />
            {minsLeft}
          </span>
        )}
      </div>
    </div>
  );
}

export function KalshiLiveTickerPanel() {
  const query = useQuery<KalshiLiveResponse>({
    queryKey: ["kalshi-live"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/crypto/kalshi-live`);
      if (!res.ok) throw new Error(`kalshi-live: ${res.status}`);
      return res.json() as Promise<KalshiLiveResponse>;
    },
    refetchInterval: 1000,
    staleTime: 0,
  });

  const coins = query.data?.coins ?? [];

  // Flash cards briefly when yesPrice moves
  const prevPriceRef = useRef<Record<string, number | null>>({});
  const [flash, setFlash] = useState<Record<string, "up" | "down" | null>>({});

  useEffect(() => {
    if (coins.length === 0) return;
    const updates: Record<string, "up" | "down"> = {};
    for (const c of coins) {
      const prev = prevPriceRef.current[c.sym];
      const curr = c.yesPrice;
      if (prev != null && curr != null && curr !== prev) {
        updates[c.sym] = curr > prev ? "up" : "down";
      }
      prevPriceRef.current[c.sym] = curr ?? null;
    }
    if (Object.keys(updates).length === 0) return;
    setFlash((f) => ({ ...f, ...updates }));
    const id = setTimeout(() => {
      setFlash((f) => {
        const next = { ...f };
        for (const sym of Object.keys(updates)) next[sym] = null;
        return next;
      });
    }, 500);
    return () => clearTimeout(id);
  }, [coins]);

  const hasAnyPrice = coins.some((c) => c.yesAsk != null);
  const allStale    = coins.length > 0 && coins.every(
    (c) => c.dataAgeMs != null && c.dataAgeMs > 5000,
  );

  if (!hasAnyPrice && !query.isLoading) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border">
        <div className="relative flex items-center justify-center">
          <Radio className="w-4 h-4 text-emerald-400" />
          <span className="absolute -top-0.5 -right-0.5 flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
          </span>
        </div>
        <h2 className="font-semibold text-sm text-foreground">Kalshi Live Prices</h2>
        <span className="text-xs text-muted-foreground">
          YES / NO probability · max return per side · 1s refresh
        </span>
        {allStale && (
          <span className="ml-auto text-[10px] text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-0.5">
            Prices delayed
          </span>
        )}
      </div>

      {/* Loading skeleton */}
      {query.isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border/40 h-28 animate-pulse bg-muted/20" />
          ))}
        </div>
      )}

      {/* Coin grid */}
      {!query.isLoading && coins.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4">
          {coins.map((coin) => (
            <CoinCard key={coin.sym} coin={coin} flash={flash[coin.sym] ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}
