import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ArrowDown, RefreshCw, ExternalLink, Loader2, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { KalshiTarget } from "./types";
import { fetchJson, formatPrice, API_BASE } from "./utils";


interface KalshiBtcCall {
  above: boolean;
  confidence: number;
  predictedPrice: number;
}

export function KalshiBtcCard() {
  const targetQuery = useQuery({
    queryKey: ["kalshi-btc-target"],
    queryFn: () => fetchJson<KalshiTarget>("/crypto/kalshi-btc-target"),
    refetchInterval: 15_000,
  });

  const d = targetQuery.data;
  const eventTicker = d?.eventTicker;
  const target = d?.targetPrice ?? null;

  // Keyed by eventTicker — auto-fires a fresh Claude call whenever the window changes.
  const callQuery = useQuery({
    queryKey: ["kalshi-btc-call", eventTicker],
    queryFn: () =>
      fetchJson<KalshiBtcCall>(
        `/crypto/kalshi-btc-call?eventTicker=${encodeURIComponent(eventTicker!)}&target=${target}`,
      ),
    enabled: !!eventTicker && target !== null,
    staleTime: Infinity, // cached on server per eventTicker; no need to re-fetch
    retry: 2,
  });

  if (!d?.available) return null;

  const isLive = d.isLive === true;
  const call = callQuery.data;
  const isAnalyzing = callQuery.isFetching || callQuery.isLoading;

  const above = call?.above ?? null;
  const predictedPrice = call?.predictedPrice ?? null;
  const confidence = call?.confidence ?? null;
  const diff = target !== null && predictedPrice !== null ? predictedPrice - target : null;
  const diffPct = diff !== null && target ? (diff / target) * 100 : null;

  const toET = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
      hour12: true,
    });

  const closeLabel = d.closeTime ? toET(d.closeTime) : null;
  const openLabel  = d.openTime  ? toET(d.openTime)  : null;

  return (
    <Card className="border-border bg-card/60 overflow-hidden">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#00C805]/15 border border-[#00C805]/30">
            <span className="text-[11px] font-black text-[#00C805]">K</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">Kalshi 15-min BTC Market</span>
            {isLive ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LIVE
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                Next window
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {isLive
              ? <>closes <span className="font-medium text-foreground">{closeLabel} ET</span></>
              : <>opens <span className="font-medium text-foreground">{openLabel} ET</span></>
            }
          </span>
          <button
            onClick={() => { void targetQuery.refetch(); void callQuery.refetch(); }}
            disabled={targetQuery.isFetching || isAnalyzing}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 ${(targetQuery.isFetching || isAnalyzing) ? "animate-spin" : ""}`} />
          </button>
          {d.url && (
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              View on Kalshi <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Target price */}
        <div className="px-5 py-4">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">
            Target Price
          </div>
          {target !== null ? (
            <>
              <div className="text-xl font-bold tabular-nums">${formatPrice(target)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">BTC BRTI at window open</div>
            </>
          ) : (
            <>
              <div className="text-xl font-bold text-muted-foreground">TBD</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                set at {openLabel} ET when window opens
              </div>
            </>
          )}
        </div>

        {/* Claude's verdict */}
        <div className="px-5 py-4">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">
            Claude's Call
          </div>
          {target === null ? (
            <>
              <div className="text-sm text-muted-foreground font-medium">Awaiting target…</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Will analyze once window opens
              </div>
            </>
          ) : isAnalyzing ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Analyzing market…
            </div>
          ) : above === null ? (
            <div className="text-sm text-muted-foreground">Awaiting analysis…</div>
          ) : (
            <>
              <div className={`flex items-center gap-1.5 text-base font-bold ${above ? "text-emerald-400" : "text-red-400"}`}>
                {above ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                {above ? "ABOVE TARGET" : "BELOW TARGET"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                ${formatPrice(predictedPrice!)}
                {diffPct !== null && (
                  <span className={diffPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                    {" "}({diffPct >= 0 ? "+" : ""}{diffPct.toFixed(2)}%)
                  </span>
                )}
                {confidence !== null && (
                  <span className="ml-1 text-muted-foreground">· {confidence}% conf.</span>
                )}
              </div>
              {isLive && (
                <div className={`mt-1.5 text-[11px] font-bold ${above ? "text-emerald-400" : "text-red-400"}`}>
                  → Bet {above ? "YES" : "NO"} on Kalshi
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
