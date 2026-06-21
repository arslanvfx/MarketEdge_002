import { useState, useMemo } from "react";
import { useListMarkets, Market } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Search, Plus, ExternalLink, Filter,
  TrendingUp, ArrowUpDown, ShieldCheck, Zap, Flame,
  Clock, DollarSign, ChevronDown, ChevronRight, X,
} from "lucide-react";
import { useBuilder } from "@/lib/builder-context";
import { useToast } from "@/hooks/use-toast";
import { SetAlertDialog } from "@/components/set-alert-dialog";

const DISPLAY_PAGE = 24;

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
  kalshi:     { label: "Kalshi",     className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"       },
  polymarket: { label: "Polymarket", className: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
};

const CATEGORY_COLORS: Record<string, string> = {
  Soccer:        "bg-green-500/15 text-green-400 border-green-500/30",
  Basketball:    "bg-orange-500/15 text-orange-400 border-orange-500/30",
  Baseball:      "bg-blue-500/15 text-blue-400 border-blue-500/30",
  Football:      "bg-amber-500/15 text-amber-400 border-amber-500/30",
  Hockey:        "bg-sky-500/15 text-sky-400 border-sky-500/30",
  Tennis:        "bg-lime-500/15 text-lime-400 border-lime-500/30",
  Golf:          "bg-teal-500/15 text-teal-400 border-teal-500/30",
  Crypto:        "bg-orange-500/15 text-orange-400 border-orange-500/30",
  Economics:     "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  Politics:      "bg-purple-500/15 text-purple-400 border-purple-500/30",
  Elections:     "bg-purple-500/15 text-purple-400 border-purple-500/30",
  Entertainment: "bg-pink-500/15 text-pink-400 border-pink-500/30",
  Tech:          "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  Stocks:        "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  Weather:       "bg-sky-500/15 text-sky-400 border-sky-500/30",
};

const CATEGORY_EMOJI: Record<string, string> = {
  Soccer:        "⚽",
  Basketball:    "🏀",
  Baseball:      "⚾",
  Football:      "🏈",
  Hockey:        "🏒",
  Tennis:        "🎾",
  Golf:          "⛳",
  Crypto:        "₿",
  Economics:     "📊",
  Politics:      "🗳️",
  Elections:     "🗳️",
  Entertainment: "🎬",
  Tech:          "💻",
  Stocks:        "📈",
  Weather:       "🌡️",
  "Combat Sports": "🥊",
  Motorsport:    "🏎️",
  Cricket:       "🏏",
  Esports:       "🎮",
  Other:         "•",
};

function formatPayout(p: number) { return p.toFixed(2) + "×"; }
function formatProb(p: number)   { return (p * 100).toFixed(1) + "%"; }

function formatVolume(vol: number | null | undefined): string | null {
  if (!vol || vol <= 0) return null;
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000)     return `$${(vol / 1_000).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

function formatClose(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / 86_400_000);
  if (days < 0)   return null;
  if (days === 0) return "Closes today";
  if (days === 1) return "Tomorrow";
  if (days <= 30) return `${days}d left`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Round-robin across categories so every category gets equal initial
 * representation rather than one high-volume series dominating the first page.
 * Within each category markets are already volume-sorted by the backend.
 */
function balancedSort(markets: AugmentedMarket[]): AugmentedMarket[] {
  const byCat = new Map<string, AugmentedMarket[]>();
  for (const m of markets) {
    const c = m.category ?? "Other";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(m);
  }
  const cats = [...byCat.values()];
  const result: AugmentedMarket[] = [];
  for (let i = 0; result.length < markets.length; i++) {
    let added = false;
    for (const cat of cats) {
      if (i < cat.length) { result.push(cat[i]); added = true; }
    }
    if (!added) break;
  }
  return result;
}

function buildCategoryList(markets: Market[]) {
  const counts = new Map<string, { count: number; volume: number }>();
  for (const m of markets) {
    const c = m.category ?? "Other";
    const cur = counts.get(c) ?? { count: 0, volume: 0 };
    counts.set(c, { count: cur.count + 1, volume: cur.volume + (m.volume ?? 0) });
  }
  return [...counts.entries()]
    .map(([name, { count, volume }]) => ({ name, count, volume }))
    .sort((a, b) => b.volume - a.volume);
}

const PLATFORM_TABS = [
  { value: "all" as const,        label: "Both"       },
  { value: "kalshi" as const,     label: "Kalshi"     },
  { value: "polymarket" as const, label: "Polymarket" },
];

const TOP_CAT_COUNT = 7;

type AugmentedMarket = Market & { _best: ReturnType<typeof getBestSide> };

export default function Markets() {
  const [search, setSearch]                     = useState("");
  const [platform, setPlatform]                 = useState<"all" | "kalshi" | "polymarket">("all");
  const [sortBy, setSortBy]                     = useState<SortKey>("volume");
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [displayCount, setDisplayCount]         = useState(DISPLAY_PAGE);
  const [catSearch, setCatSearch]               = useState("");
  const [moreOpen, setMoreOpen]                 = useState(false);

  const { addLeg, selectedLegs } = useBuilder();
  const { toast } = useToast();

  const platformParam = platform === "all" ? undefined : platform;

  // ── Main query: filtered by all active params ─────────────────────────────
  // allMarkets is derived DIRECTLY from data — no intermediate useState.
  // This guarantees the grid always reflects the current query immediately;
  // stale state from a previous platform/category selection cannot linger.
  const { data, isLoading } = useListMarkets({
    q:        search || undefined,
    platform: platformParam,
    category: selectedCategory || undefined,
    limit:    1000,
    offset:   0,
  });

  // ── Full-platform query: not filtered by category, drives chip counts ──────
  // When selectedCategory is empty this shares a React Query cache key with the
  // main query above, so it costs zero extra requests.
  const { data: allPlatformData } = useListMarkets({
    platform: platformParam,
    limit:    1000,
    offset:   0,
  });

  // Markets always reflect the current query — no stale data possible.
  const allMarkets = useMemo(() => data?.markets ?? [], [data]);

  // Category chip counts come from the unfiltered platform data so they remain
  // stable while the user drills into a specific category.
  const chipCategories = useMemo(
    () => buildCategoryList(allPlatformData?.markets ?? allMarkets),
    [allPlatformData, allMarkets],
  );
  const trendingCats  = chipCategories.slice(0, TOP_CAT_COUNT);
  const moreCats      = chipCategories.slice(TOP_CAT_COUNT);
  const filteredMore  = catSearch
    ? moreCats.filter((c) => c.name.toLowerCase().includes(catSearch.toLowerCase()))
    : moreCats;

  // ── Sorted / balanced view ─────────────────────────────────────────────────
  const sorted: AugmentedMarket[] = useMemo(() => {
    const enriched = allMarkets.map((m) => ({ ...m, _best: getBestSide(m) }));
    if (sortBy === "volume" && !selectedCategory && !search) {
      return balancedSort(enriched);
    }
    switch (sortBy) {
      case "probability": return [...enriched].sort((a, b) => b._best.prob - a._best.prob);
      case "payout":      return [...enriched].sort((a, b) => b._best.payout - a._best.payout);
      default:            return [...enriched].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
    }
  }, [allMarkets, sortBy, selectedCategory, search]);

  // Reset display count whenever any filter changes
  const filterKey = `${search}|${platform}|${selectedCategory}|${sortBy}`;
  const displayed = sorted.slice(0, displayCount);
  const clientHasMore = displayCount < sorted.length;
  const isInitialLoad = isLoading && allMarkets.length === 0;

  const handleAdd = (m: AugmentedMarket) => {
    addLeg(m as any, m._best.side === "YES" ? "yes" : "no");
    toast({ title: "Added to Builder", description: `"${m.title}" added.` });
  };

  const clearCategory = () => { setSelectedCategory(""); setMoreOpen(false); };

  const subtitleParts: string[] = [];
  if (sorted.length > 0) {
    subtitleParts.push(`${sorted.length} markets`);
    if (selectedCategory) subtitleParts.push(`in ${selectedCategory}`);
    if (search)           subtitleParts.push(`matching "${search}"`);
    if (!selectedCategory && !search && sortBy === "volume")
      subtitleParts.push("balanced across all categories");
    else
      subtitleParts.push(`sorted by ${SORT_OPTIONS.find(o => o.value === sortBy)?.label.toLowerCase()}`);
  }

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto w-full flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-3xl font-bold tracking-tight">Best Single Bets</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {subtitleParts.length > 0
            ? subtitleParts.join(" — ")
            : "Live odds from Kalshi & Polymarket — risk, payout, and probability at a glance."}
        </p>
      </div>

      {/* Search + Platform + Sort */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search markets…"
            className="pl-9 bg-card"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setDisplayCount(DISPLAY_PAGE); }}
            data-testid="input-search-markets"
          />
        </div>

        <div className="flex rounded-lg border border-border overflow-hidden bg-card" data-testid="toggle-platform-filter">
          {PLATFORM_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => { setPlatform(tab.value); setSelectedCategory(""); setDisplayCount(DISPLAY_PAGE); }}
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

        <div className="flex rounded-lg border border-border overflow-hidden bg-card">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setSortBy(opt.value); setDisplayCount(DISPLAY_PAGE); }}
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

      {/* Category chips */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button
          onClick={clearCategory}
          className={[
            "inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
            selectedCategory === ""
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
          ].join(" ")}
        >
          All
        </button>

        {trendingCats.map((cat) => {
          const isActive = selectedCategory === cat.name;
          const colorsClass = CATEGORY_COLORS[cat.name] ?? "bg-muted/50 text-muted-foreground border-border";
          return (
            <button
              key={cat.name}
              onClick={() => { setSelectedCategory(isActive ? "" : cat.name); setDisplayCount(DISPLAY_PAGE); }}
              data-testid={`category-chip-${cat.name.toLowerCase()}`}
              className={[
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                isActive
                  ? colorsClass + " ring-1 ring-current"
                  : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
              ].join(" ")}
            >
              <span>{CATEGORY_EMOJI[cat.name] ?? "•"}</span>
              {cat.name}
              <span className="opacity-50 font-normal">{cat.count}</span>
            </button>
          );
        })}

        {moreCats.length > 0 && (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button
                className={[
                  "inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                  moreCats.some((c) => c.name === selectedCategory)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground",
                ].join(" ")}
              >
                {moreCats.some((c) => c.name === selectedCategory)
                  ? <>{CATEGORY_EMOJI[selectedCategory] ?? "•"} {selectedCategory} <X className="w-3 h-3 ml-0.5" /></>
                  : <>More <ChevronRight className="w-3 h-3" /></>}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="start">
              <Input
                placeholder="Search categories…"
                value={catSearch}
                onChange={(e) => setCatSearch(e.target.value)}
                className="mb-2 h-8 text-xs"
              />
              <ScrollArea className="h-48">
                <div className="space-y-0.5">
                  {filteredMore.map((cat) => {
                    const isActive = selectedCategory === cat.name;
                    return (
                      <button
                        key={cat.name}
                        onClick={() => { setSelectedCategory(isActive ? "" : cat.name); setMoreOpen(false); setCatSearch(""); setDisplayCount(DISPLAY_PAGE); }}
                        className={[
                          "w-full flex items-center justify-between px-2 py-1.5 rounded text-xs transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "hover:bg-muted/50 text-muted-foreground hover:text-foreground",
                        ].join(" ")}
                      >
                        <span className="flex items-center gap-1.5">{CATEGORY_EMOJI[cat.name] ?? "•"} {cat.name}</span>
                        <span className="opacity-50">{cat.count}</span>
                      </button>
                    );
                  })}
                  {filteredMore.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No categories found</p>
                  )}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
        )}

        {selectedCategory && (
          <button
            onClick={clearCategory}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border border-dashed border-primary/40 text-primary hover:bg-primary/10 transition-colors"
          >
            <X className="w-3 h-3" /> Clear filter
          </button>
        )}
      </div>

      {/* Market grid */}
      <div className="flex-1 overflow-auto pb-8" key={filterKey}>
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
                <Skeleton className="h-8 w-24 rounded-lg" />
                <Skeleton className="h-1.5 w-full rounded-full" />
                <div className="flex justify-between pt-3 border-t border-border">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-8 w-20" />
                </div>
              </Card>
            ))}
          </div>
        ) : displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center bg-card rounded-lg border border-border border-dashed">
            <Filter className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No markets found</h3>
            <p className="text-sm text-muted-foreground">
              {selectedCategory
                ? `No ${selectedCategory} markets right now. Try another category.`
                : "Try adjusting your search or platform filter."}
            </p>
            {selectedCategory && (
              <Button variant="outline" size="sm" className="mt-4" onClick={clearCategory}>
                Show all categories
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {displayed.map((market) => {
                const { side, prob, payout } = market._best;
                const risk      = getRisk(prob);
                const RiskIcon  = RISK_CONFIG[risk].icon;
                const platCfg   = PLATFORM_CONFIG[market.platform] ?? { label: market.platform, className: "bg-muted text-muted-foreground border-border" };
                const catClass  = CATEGORY_COLORS[market.category ?? ""] ?? "bg-muted/50 text-muted-foreground border-border";
                const isAdded   = selectedLegs.some((l) => l.market.id === market.id);
                const volStr    = formatVolume(market.volume);
                const closeStr  = formatClose(market.closeTime);

                // Pick badge colours: YES = emerald, NO = rose
                const pickBg    = side === "YES"
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shadow-emerald-500/10"
                  : "bg-rose-500/15 text-rose-300 border-rose-500/40 shadow-rose-500/10";
                const barColor  = side === "YES" ? "bg-emerald-500" : (risk === "medium" ? "bg-amber-500" : risk === "low" ? "bg-emerald-500" : "bg-red-500");

                return (
                  <Card key={market.id} className="p-5 flex flex-col group hover:border-primary/40 transition-colors bg-card/50">
                    {/* Top: platform + category badges */}
                    <div className="flex items-start justify-between mb-3 gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${platCfg.className}`}>
                          {platCfg.label}
                        </span>
                        {market.category && (
                          <button
                            onClick={() => { setSelectedCategory(market.category!); setDisplayCount(DISPLAY_PAGE); }}
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border transition-opacity hover:opacity-80 ${catClass}`}
                          >
                            {market.category}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <SetAlertDialog market={market as any} />
                        <a
                          href={market.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`View on ${market.platform === "kalshi" ? "Kalshi" : "Polymarket"}`}
                          className="opacity-40 hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                          data-testid={`link-market-${market.id}`}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    </div>

                    {/* Title */}
                    <h3 className="font-semibold leading-snug line-clamp-2 mb-3 flex-1 text-sm">
                      {market.title}
                    </h3>

                    {/* ── Recommended pick — the focal point of each card ── */}
                    <div className={`flex items-center justify-between px-3 py-2.5 rounded-lg border mb-3 shadow-sm ${pickBg}`}>
                      {/* Left: label stacked above the pick value so long selections wrap cleanly */}
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-[10px] font-semibold uppercase tracking-widest opacity-60 leading-none">
                          Suggested pick
                        </span>
                        <span className="text-xl font-extrabold tracking-wide leading-tight">
                          {side}
                        </span>
                      </div>
                      {/* Right: probability */}
                      <div className="text-right shrink-0 pl-3">
                        <div className="text-lg font-black tabular-nums leading-none">{formatProb(prob)}</div>
                        <div className="text-[10px] opacity-60 mt-0.5">win probability</div>
                      </div>
                    </div>

                    {/* Probability bar */}
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-3">
                      <div
                        className={`h-full rounded-full transition-all ${barColor}`}
                        style={{ width: `${Math.round(prob * 100)}%` }}
                      />
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

                    {/* Footer */}
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

            {clientHasMore && (
              <div className="flex justify-center mt-8">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => setDisplayCount((c) => c + DISPLAY_PAGE)}
                  data-testid="button-load-more"
                >
                  <ChevronDown className="w-4 h-4 mr-2" />
                  Show more markets
                </Button>
              </div>
            )}

            {!clientHasMore && sorted.length > 0 && (
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
