import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Sparkles, Minus } from "lucide-react";
import type { CoinPrediction, CoinPrice, AutoPilotDecision } from "./types";
import { computeBetSignal } from "./types";
import { COIN_STYLE, COMMODITY_SYMBOLS, DIR, formatPct } from "./utils";
import { Sparkline, LivePrice } from "./sparkline";

interface CoinGridProps {
  coins: CoinPrediction[];
  priceMap: Map<string, CoinPrice>;
  accuracyMap: Map<string, { pct: number | null; total: number }>;
  trainingCoinsSet: Set<string>;
  autoPilotMap: Map<string, AutoPilotDecision>;
  autoPilot: { enabled: boolean };
  claudeEnabledSet: Set<string>;
  selected: string;
  onSelect: (symbol: string) => void;
  livePrice: number;
  tz: string;
  isLoading: boolean;
}

export function CoinGrid({
  coins, priceMap, accuracyMap, trainingCoinsSet, autoPilotMap, autoPilot,
  claudeEnabledSet, selected, onSelect, livePrice, tz, isLoading,
}: CoinGridProps) {
  const isCommodity = (c: CoinPrediction) =>
    c.category === "commodity" || COMMODITY_SYMBOLS.includes(c.symbol);
  const cryptoCoins = coins.filter((c) => !isCommodity(c));
  const commodityCoins = coins.filter(isCommodity);

  const renderTile = (coin: CoinPrediction) => {
                const style = COIN_STYLE[coin.symbol] ?? COIN_STYLE.BTC;
                const isSel = coin.symbol === selected;
                // For the selected coin, always mirror livePrice so the tile and big display stay in sync.
                const price = isSel ? livePrice : (priceMap.get(coin.symbol)?.price ?? coin.price);
                const chg = priceMap.get(coin.symbol)?.change24hPct ?? coin.change24hPct;
                const next = coin.predictions[0];
                const nd = DIR[next?.direction ?? "flat"];
                return (
                  <button
                    key={coin.symbol}
                    onClick={() => onSelect(coin.symbol)}
                    data-testid={`coin-${coin.symbol}`}
                    className={`text-left rounded-xl border p-3 transition-all ${
                      isSel
                        ? `bg-card ring-2 ${style.ring} shadow-lg ${style.glow}`
                        : "bg-card/50 border-border hover:bg-card hover:border-border/80"
                    }`}
                  >
                    {/* Row 1: symbol + 24h change */}
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`text-base font-bold shrink-0 ${style.accent}`}>{style.glyph}</span>
                        <span className="font-semibold text-sm truncate">{coin.symbol}</span>
                      </div>
                      <span className={`text-[11px] font-medium shrink-0 ml-1 ${chg >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {formatPct(chg)}
                      </span>
                    </div>
                    {/* Row 2: badges */}
                    {(() => {
                      const acc = accuracyMap.get(coin.symbol);
                      const training = trainingCoinsSet.has(coin.symbol);
                      const auto = autoPilotMap.get(coin.symbol)?.active ?? false;
                      const hasAcc = acc && acc.pct !== null && acc.total >= 1;
                      const hasMode = training || claudeEnabledSet.has(coin.symbol) || auto;
                      if (!hasAcc && !hasMode) return <div className="mb-1.5" />;
                      const accColor = !hasAcc ? "" :
                        acc!.pct! >= 65 ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/30"
                        : acc!.pct! >= 45 ? "bg-amber-500/20 text-amber-400 ring-amber-500/30"
                        : "bg-red-500/20 text-red-400 ring-red-500/30";
                      return (
                        <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                          {hasAcc && (
                            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none ${accColor}`}>
                              {acc!.pct}%
                            </span>
                          )}
                          {training && (() => {
                            const apDec = autoPilotMap.get(coin.symbol);
                            if (!autoPilot.enabled) {
                              return (
                                <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-violet-500/25 text-violet-300 ring-violet-500/40" title="Training coin — auto-pilot off">
                                  <Bot className="w-2.5 h-2.5" /> Training
                                </span>
                              );
                            }
                            if (apDec?.active && apDec.exploring) {
                              return (
                                <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-sky-500/20 text-sky-300 ring-sky-500/30" title={apDec.reason}>
                                  <Bot className="w-2.5 h-2.5" /> Exploring
                                </span>
                              );
                            }
                            if (apDec?.active) {
                              return (
                                <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-emerald-500/20 text-emerald-300 ring-emerald-500/30" title={apDec.reason}>
                                  <Bot className="w-2.5 h-2.5" /> Claude on
                                </span>
                              );
                            }
                            return (
                              <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium ring-1 leading-none text-muted-foreground bg-muted/30 ring-border" title={apDec?.reason ?? "Stat only"}>
                                <Minus className="w-2.5 h-2.5" /> Paused
                              </span>
                            );
                          })()}
                          {!training && claudeEnabledSet.has(coin.symbol) && (
                            <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-violet-500/20 text-violet-300 ring-violet-500/30" title="Claude AI tracking active">
                              <Sparkles className="w-2.5 h-2.5" /> Claude
                            </span>
                          )}
                          {!training && !claudeEnabledSet.has(coin.symbol) && auto && (
                            <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 leading-none bg-emerald-500/20 text-emerald-300 ring-emerald-500/30" title={autoPilotMap.get(coin.symbol)?.reason ?? "Auto-pilot"}>
                              <Bot className="w-2.5 h-2.5" /> Auto
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <div className="text-sm font-bold tabular-nums mb-1">
                      <LivePrice price={price} />
                    </div>
                    <Sparkline data={coin.sparkline} color={chg >= 0 ? "#34d399" : "#f87171"} />
                    {next && (
                      <div className={`mt-1.5 flex items-center gap-1 text-[10px] font-medium ${nd.color}`}>
                        <nd.icon className="w-3 h-3" />
                        <span>{next.label} {tz}</span>
                      </div>
                    )}
                    {(() => {
                      if (coin.indicators.efficiencyRatio == null) return null;
                      const sig = computeBetSignal(coin.indicators, coin.kalshiTarget ?? null, price);
                      const meta = {
                        trending: { color: "text-emerald-400", label: "Trending" },
                        drifting: { color: "text-amber-400", label: "Drifting" },
                        choppy: { color: "text-red-400", label: "Choppy" },
                        spike: { color: "text-orange-400", label: "⚠ Spike" },
                      }[sig.level];
                      return (
                        <div className={`mt-0.5 flex items-center gap-1 text-[9px] font-bold ${meta.color}`}>
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "currentColor" }} />
                          {meta.label}
                          <span className="font-normal opacity-70">({sig.er.toFixed(2)}×)</span>
                        </div>
                      );
                    })()}
                  </button>
                );
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-2">Crypto</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {cryptoCoins.map(renderTile)}
        </div>
      </div>
      {commodityCoins.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-2">Commodities</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {commodityCoins.map(renderTile)}
          </div>
        </div>
      )}
    </div>
  );
}
