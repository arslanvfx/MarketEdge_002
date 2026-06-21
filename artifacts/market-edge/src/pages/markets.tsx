import { useState, useEffect, useRef } from "react";
import { useListMarkets, MarketPlatform } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Plus, ExternalLink, Filter, TrendingUp, Loader2 } from "lucide-react";
import { useBuilder } from "@/lib/builder-context";
import { useToast } from "@/hooks/use-toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SetAlertDialog } from "@/components/set-alert-dialog";
import { MarketSparkline } from "@/components/market-sparkline";

const PAGE_SIZE = 20;

function formatOdds(odds: number) {
  return (odds * 100).toFixed(1) + "%";
}

type Market = {
  id: string;
  title: string;
  platform: string;
  yesOdds: number;
  url: string;
  category?: string | null;
};

type Category = "All" | "Sports" | "Crypto" | "Economics" | "Elections" | "Entertainment";

const CATEGORIES: Category[] = ["All", "Sports", "Crypto", "Economics", "Elections", "Entertainment"];

const CATEGORY_COLORS: Record<string, string> = {
  Sports: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  Crypto: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  Economics: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  Elections: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  Entertainment: "bg-pink-500/15 text-pink-600 dark:text-pink-400 border-pink-500/30",
};

export default function Markets() {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<"all" | "kalshi" | "polymarket">("all");
  const [category, setCategory] = useState<Category>("All");
  const [offset, setOffset] = useState(0);
  const [allMarkets, setAllMarkets] = useState<Market[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const { addLeg, selectedLegs } = useBuilder();
  const { toast } = useToast();

  const prevFilterKey = useRef(`${search}||${platform}`);

  const { data, isLoading, isFetching } = useListMarkets({
    q: search || undefined,
    platform: platform === "all" ? undefined : platform,
    limit: PAGE_SIZE,
    offset,
  });

  useEffect(() => {
    const filterKey = `${search}||${platform}`;
    if (filterKey !== prevFilterKey.current) {
      prevFilterKey.current = filterKey;
      setOffset(0);
      setAllMarkets([]);
      setTotal(null);
      setHasMore(false);
    }
  }, [search, platform]);

  useEffect(() => {
    if (!data) return;
    setAllMarkets((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const newMarkets = (data.markets as Market[]).filter((m) => !existingIds.has(m.id));
      return [...prev, ...newMarkets];
    });
    setTotal(data.total);
    setHasMore(data.hasMore);
  }, [data]);

  const handleAdd = (market: Market) => {
    addLeg(market as any, "yes");
    toast({
      title: "Added to Builder",
      description: `Added "${market.title}" to your combo builder.`,
    });
  };

  const handleLoadMore = () => {
    setOffset((prev) => prev + PAGE_SIZE);
  };

  const isInitialLoad = isLoading && allMarkets.length === 0;

  const filteredMarkets = category === "All"
    ? allMarkets
    : allMarkets.filter((m) => m.category === category);

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto w-full flex flex-col h-full overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Market Browser</h1>
          <p className="text-muted-foreground mt-1">
            {total !== null && allMarkets.length > 0
              ? category === "All"
                ? `Showing ${allMarkets.length} of ${total} markets`
                : `Showing ${filteredMarkets.length} ${category} markets`
              : "Live odds from top prediction markets."}
          </p>
        </div>
        
        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search markets..." 
              className="pl-9 bg-card"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search-markets"
            />
          </div>
          <ToggleGroup type="single" value={platform} onValueChange={(val) => val && setPlatform(val as any)} data-testid="toggle-platform-filter">
            <ToggleGroupItem value="all" aria-label="All Platforms">All</ToggleGroupItem>
            <ToggleGroupItem value="kalshi" aria-label="Kalshi">Kalshi</ToggleGroupItem>
            <ToggleGroupItem value="polymarket" aria-label="Polymarket">Polymarket</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap mb-6" data-testid="category-filter-tabs">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            data-testid={`category-tab-${cat.toLowerCase()}`}
            className={[
              "px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
              category === cat
                ? cat === "All"
                  ? "bg-primary text-primary-foreground border-primary"
                  : `border ${CATEGORY_COLORS[cat] ?? ""} ring-1 ring-current`
                : "bg-card border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
            ].join(" ")}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto pr-2 pb-8">
        {isInitialLoad ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 9 }).map((_, i) => (
              <Card key={i} className="p-4 space-y-4">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <div className="flex justify-between pt-4">
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </Card>
            ))}
          </div>
        ) : !filteredMarkets.length ? (
          <div className="flex flex-col items-center justify-center h-64 text-center bg-card rounded-lg border border-border border-dashed">
            <Filter className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No markets found</h3>
            <p className="text-muted-foreground">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredMarkets.map((market) => {
                const isAdded = selectedLegs.some((leg) => leg.market.id === market.id);
                
                return (
                  <Card key={market.id} className="p-5 flex flex-col group hover:border-primary/50 transition-colors bg-card/50">
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant={market.platform === "kalshi" ? "default" : "secondary"} className="uppercase text-[10px] tracking-wider">
                          {market.platform === "polymarket" && <TrendingUp className="w-3 h-3 mr-1 inline" />}
                          {market.platform}
                        </Badge>
                        {market.category && (
                          <span
                            className={[
                              "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border",
                              CATEGORY_COLORS[market.category] ?? "bg-muted text-muted-foreground border-border",
                            ].join(" ")}
                            data-testid={`badge-category-${market.id}`}
                          >
                            {market.category}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <SetAlertDialog market={market as any} />
                        <a href={market.url} target="_blank" rel="noopener noreferrer" className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary" data-testid={`link-market-${market.id}`}>
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    </div>
                    
                    <h3 className="font-semibold leading-tight line-clamp-3 mb-4 flex-1">
                      {market.title}
                    </h3>
                    
                    <div className="mb-3">
                      <MarketSparkline
                        platform={market.platform as "kalshi" | "polymarket"}
                        marketId={market.id}
                        currentOdds={market.yesOdds}
                      />
                    </div>

                    <div className="flex items-end justify-between pt-4 border-t border-border mt-auto">
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Live YES Odds</p>
                        <div className="text-2xl font-bold font-mono text-primary">
                          {formatOdds(market.yesOdds)}
                        </div>
                      </div>
                      
                      <Button 
                        size="sm" 
                        variant={isAdded ? "secondary" : "default"}
                        onClick={() => handleAdd(market)}
                        disabled={isAdded}
                        data-testid={`button-add-${market.id}`}
                      >
                        {isAdded ? "Added" : <><Plus className="w-4 h-4 mr-1" /> Add to Builder</>}
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>

            {hasMore && category === "All" && (
              <div className="flex justify-center mt-8">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={handleLoadMore}
                  disabled={isFetching}
                  data-testid="button-load-more"
                >
                  {isFetching ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Loading more...
                    </>
                  ) : (
                    `Load more markets`
                  )}
                </Button>
              </div>
            )}

            {hasMore && category !== "All" && (
              <p className="text-center text-sm text-muted-foreground mt-8">
                Switch to "All" to load more markets
              </p>
            )}

            {!hasMore && filteredMarkets.length > 0 && total !== null && category === "All" && (
              <p className="text-center text-sm text-muted-foreground mt-8">
                All {total} markets loaded
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
