import { useState, useEffect, useRef, useMemo } from "react";
import { useListMarkets, Market } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search, Plus, ExternalLink, Filter,
  TrendingUp, ArrowUpDown, ShieldCheck, Zap, Flame,
  Clock, DollarSign, ChevronDown, Loader2,
} from "lucide-react";
import { useBuilder } from "@/lib/builder-context";
import { useToast } from "@/hooks/use-toast";
import { SetAlertDialog } from "@/components/set-alert-dialog";

const PAGE_SIZE = 20;

type SortKey = "volume" | "probability" | "payout";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "volume",      label: "Most active"    },
  { value: "probability", label: "Safest bet"      },
  { value: "payout",      label: "Highest return" },
];

type RiskLevel = "low" | "medium" | "high";

function getBestSide(m: Market): { side: "YES" | "NO"; prob: number; payout: number } {
  const useYes = m.yesOdds >= m.noOdds;
  const prob   = useYes ? m.yesOdds : m.noOdds;
  return { side: useYes ? "YES" : "NO", prob, payout: prob > 0 ? 1 / prob : 0 };
}

function getRisk(prob: number): RiskLevel {
  if (prob >= 0.68) return "low";
  if (prob >= 0.50) return "medium";
  return "high";
}

const RISK_CONFIG: Record<RiskLevel, { label: string; icon: React.ElementType; className: string }> = {
  low:    { label: "Low risk",  icon: ShieldCheck, className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
  medium: { label: "Med risk",  icon: Zap,         className: "text-amber-400 border-amber-500/30 bg-amber-500/10"       },
  high:   { label: "High risk", icon: Flame,       className: "text-red-400 border-red-500/30 bg-red-500/10"            },
};

const PLATFORM_CONFIG: Record<string, { label: string; className: string }> = {
  kalshi:     { label: "Kalshi",     className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"         },
  polymarket: { label: "Polymarket", className: "bg-violet-500/15 text-violet-400 border-violet-500/30"   },
};

const CATEGORY_COLORS: Record<string, string> = {
  Soccer:        "bg-green-500/15 text-green-400 border-green-500/30",
  Basketball:    "bg-orange-500/15 text-orange-400 border-orange-500/30",
  Baseball:      "bg-blue-500/15 text-blue-400 border-blue-500/30",
  Football:      "bg-amber-500/15 text-amber-400 border-amber-500/30",
  Hockey:        "bg-sky-500/15 text-sky-400 border-sky-500/30",
  Tennis:        "bg-lime-500/15 text-lime-400 border-lime-500/30",
  Golf:          "bg-teal-500/15 text-teal-400 border-teal-500/30",
  MMA:           "bg-red-500/15 text-red-400 border-red-500/30",
  Boxing:        "bg-rose-500/15 text-rose-400 border-rose-500/30",
  Crypto:        "bg-orange-500/15 text-orange-400 border-orange-500/30",
  Economics:     "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  Politics:      "bg-purple-500/15 text-purple-400 border-purple-500/30",
  Elections:     "bg-purple-500/15 text-purple-400 border-purple-500/30",
  Entertainment: "bg-pink-500/15 text-pink-400 border-pink-500/30",
};

function formatPayout(payout: number) {
  return payout.toFixed(2) + "×";
}

function formatProb(prob: number) {
  return (prob * 100).toFixed(1) + "%";
}

function formatVolume(vol: number | null | undefined): string | null {
  if (!vol || vol <= 0) return null;
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000)     return `${(vol / 1_000).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

function formatClose(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / 86_400_000);
  if (days < 0)  return null;
  if (days === 0) return "Closes today";
  if (days === 1) return "Tomorrow";
  if (days <= 30) return `${days}d left`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const PLATFORM_TABS = [
  { value: "all" as const,        label: "Both" },
  { value: "kalshi" as const,     label: "Kalshi" },
  { value: "polymarket" as const, label: "Polymarket" },
];

type AugmentedMarket = Market & { _best: ReturnType<typeof getBestSide> };

export default function Markets() {
  const [search, setSearch]     = useState("");
  const [platform, setPlatform] = useState<"all" | "kalshi" | "polymarket">("all");
  const [sortBy, setSortBy]     = useState<SortKey>("volume");
  const [offset, setOffset]     = useState(0);
  const [allMarkets, setAllMarkets] = useState<Market[]>([]);
  const [hasMore, setHasMore]   = useState(false);
  const [total, setTotal]       = useState<number | null>(null);

  const { addLeg, selectedLegs } = useBuilder();
  const { toast } = useToast();

  const prevFilterKey = useRef(`${search}||${platform}`);

  const { data, isLoading, isFetching } = useListMarkets({
    q: search || undefined,
    platform: platform === "all" ? undefined : platform,
    limit: PAGE_SIZE,
    offset,
  });

  // Reset accumulated list when filter/search changes
  useEffect(() => {
    const key = `${search}||${platform}`;
    if (key !== prevFilterKey.current) {
      prevFilterKey.current = key;
      setOffset(0);
      setAllMarkets([]);
      setTotal(null);
      setHasMore(false);
    }
  }, [search, platform]);

  // Accumulate pages
  useEffect(() => {
    if (!data) return;
    setAllMarkets((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      return [...prev, ...data.markets.filter((m) => !existingIds.has(m.id))];
    });
    setTotal(data.total);
    setHasMore(data.hasMore);
  }, [data]);

  const sorted: AugmentedMarket[] = useMemo(() => {
    const enriched = allMarkets.map((m) => ({ ...m, _best: getBestSide(m) }));
    switch (sortBy) {
      case "probability": return [...enriched].sort((a, b) => b._best.prob - a._best.prob);
      case "payout":      return [...enriched].sort((a, b) => b._best.payout - a._best.payout);
      default:            return [...enriched].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
    }
  }, [allMarkets, sortBy]);

  const isInitialLoad = isLoading && allMarkets.length === 0;

  const handleAdd = (m: AugmentedMarket) => {
    addLeg(m as any, m._best.side === "YES" ? "yes" : "no");
    toast({ title: "Added to Builder", description: `"${m.title}" added to your combo builder.` });
  };

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto w-full flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Best Single Bets</h1>
        <p className="text-muted-foreground mt-1">
          {total !== null && allMarkets.length > 0
            ? `${allMarkets.length} of ${total} markets — sorted by ${SORT_OPTIONS.find(o => o.value === sortBy)?.label.toLowerCase()}`
            : "Live odds from Kalshi & Polymarket — risk, payout, and probability at a glance."}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search markets…"
            className="pl-9 bg-card"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-markets"
          />
        </div>

        {/* Platform */}
        <div className="flex rounded-lg border border-border overflow-hidden bg-card" data-testid="toggle-platform-filter">
          {PLATFORM_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setPlatform(tab.value)}
              data-testid={`platform-tab-${tab.value}`}
              className={[
                "px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                platform === tab.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              ].join(" ")}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex rounded-lg border border-border overflow-hidden bg-card">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              data-testid={`sort-${opt.value}`}
              className={[
                "px-3 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap",
                sortBy === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              ].join(" ")}
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Market grid */}
      <div className="flex-1 overflow-auto pb-8">
        {isInitialLoad ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 9 }).map((_, i) => (
              <Card key={i} className="p-5 space-y-4">
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-1.5 w-full rounded-full" />
                <div className="flex justify-between pt-3 border-t border-border">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-8 w-20" />
                </div>
              </Card>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center bg-card rounded-lg border border-border border-dashed">
            <Filter className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No markets found</h3>
            <p className="text-muted-foreground">Try adjusting your search or platform filter.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {sorted.map((market) => {
                const { side, prob, payout } = market._best;
                const risk = getRisk(prob);
                const RiskIcon = RISK_CONFIG[risk].icon;
                const platformCfg = PLATFORM_CONFIG[market.platform] ?? { label: market.platform, className: "bg-muted text-muted-foreground border-border" };
                const catClass = CATEGORY_COLORS[market.category ?? ""] ?? "bg-muted/50 text-muted-foreground border-border";
                const isAdded = selectedLegs.some((leg) => leg.market.id === market.id);
                const volStr = formatVolume(market.volume);
                const closeStr = formatClose(market.closeTime);

                return (
                  <Card key={market.id} className="p-5 flex flex-col group hover:border-primary/40 transition-colors bg-card/50">
                    {/* Top: platform + category + actions */}
                    <div className="flex items-start justify-between mb-3 gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${platformCfg.className}`}>
                          {platformCfg.label}
                        </span>
                        {market.category && (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${catClass}`}>
                            {market.category}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <SetAlertDialog market={market as any} />
                        <a
                          href={market.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                          data-testid={`link-market-${market.id}`}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    </div>

                    {/* Title */}
                    <h3 className="font-semibold leading-snug line-clamp-2 mb-4 flex-1 text-sm">
                      {market.title}
                    </h3>

                    {/* Probability bar */}
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-muted-foreground">{side} probability</span>
                        <span className="text-xs font-semibold tabular-nums">{formatProb(prob)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            risk === "low" ? "bg-emerald-500" :
                            risk === "medium" ? "bg-amber-500" : "bg-red-500"
                          }`}
                          style={{ width: `${Math.round(prob * 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats: payout + risk + volume */}
                    <div className="flex items-center gap-3 mb-4 flex-wrap">
                      <div className="flex items-center gap-1">
                        <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-sm font-bold tabular-nums text-primary">{formatPayout(payout)}</span>
                        <span className="text-xs text-muted-foreground">payout</span>
                      </div>

                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${RISK_CONFIG[risk].className}`}>
                        <RiskIcon className="w-3 h-3" />
                        {RISK_CONFIG[risk].label}
                      </span>

                      {volStr && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                          <DollarSign className="w-3 h-3" />
                          {volStr}
                        </span>
                      )}
                    </div>

                    {/* Footer: close date + add button */}
                    <div className="flex items-center justify-between pt-3 border-t border-border mt-auto gap-2">
                      <span className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                        {closeStr
                          ? <><Clock className="w-3 h-3 shrink-0" />{closeStr}</>
                          : <span className="opacity-40">No close date</span>}
                      </span>
                      <Button
                        size="sm"
                        variant={isAdded ? "secondary" : "default"}
                        onClick={() => handleAdd(market)}
                        disabled={isAdded}
                        data-testid={`button-add-${market.id}`}
                        className="shrink-0"
                      >
                        {isAdded ? "Added" : <><Plus className="w-3.5 h-3.5 mr-1" />Add</>}
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Pagination */}
            {hasMore && (
              <div className="flex justify-center mt-8">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => setOffset((p) => p + PAGE_SIZE)}
                  disabled={isFetching}
                  data-testid="button-load-more"
                >
                  {isFetching
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading…</>
                    : <><ChevronDown className="w-4 h-4 mr-2" />Load more markets</>}
                </Button>
              </div>
            )}

            {!hasMore && sorted.length > 0 && (
              <p className="text-center text-sm text-muted-foreground mt-8">
                All {sorted.length} markets loaded
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
