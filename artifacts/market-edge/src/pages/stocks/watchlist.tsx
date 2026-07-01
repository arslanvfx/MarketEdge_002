import { useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, Plus, X, Loader2, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { StocksShell } from "./stocks-shell";
import { StockDetail } from "./stock-detail";
import {
  stockGet, stockAuth, fmtDateTime,
  type WatchlistEntry, type StockMeta,
} from "@/lib/stocks-api";
import { STOCK_UNIVERSE } from "./universe";

export default function StockWatchlist() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ watchlist: WatchlistEntry[] }>({
    queryKey: ["stocks-watchlist"],
    queryFn: () => stockGet("/watchlist"),
    refetchInterval: 10_000,
  });
  useQuery<StockMeta>({ queryKey: ["stocks-meta"], queryFn: () => stockGet("/meta"), refetchInterval: 10_000 });

  const watchlist = data?.watchlist ?? [];
  const watchSet = useMemo(() => new Set(watchlist.map((w) => w.ticker)), [watchlist]);

  const suggestions = useMemo(() => {
    const q = input.trim().toUpperCase();
    if (!q) return [];
    return STOCK_UNIVERSE.filter(
      (e) => (e.ticker.includes(q) || e.name.toUpperCase().includes(q)) && !watchSet.has(e.ticker),
    ).slice(0, 6);
  }, [input, watchSet]);

  async function add(ticker: string, companyName?: string, sector?: string) {
    setBusy(true);
    try {
      await stockAuth(getToken, "/watchlist", "POST", { ticker, companyName, sector });
      await qc.invalidateQueries({ queryKey: ["stocks-watchlist"] });
      setInput("");
    } catch (e) {
      toast({
        title: "Could not add ticker",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(ticker: string) {
    try {
      await stockAuth(getToken, `/watchlist/${ticker}`, "DELETE");
      await qc.invalidateQueries({ queryKey: ["stocks-watchlist"] });
    } catch (e) {
      toast({
        title: "Could not remove ticker",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    }
  }

  return (
    <StocksShell>
      <div className="p-6 space-y-5 max-w-3xl">
        {/* Add form */}
        <div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) {
                  const match = suggestions[0];
                  add(match?.ticker ?? input.trim().toUpperCase(), match?.name, match?.sector);
                }
              }}
              placeholder="Add a ticker or company name…"
              data-testid="input-watchlist-add"
              className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg bg-card border border-border focus:border-emerald-500/50 outline-none"
            />
          </div>
          {suggestions.length > 0 && (
            <div className="mt-1.5 rounded-lg border border-border bg-card overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.ticker}
                  onClick={() => add(s.ticker, s.name, s.sector)}
                  disabled={busy}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                >
                  <span><span className="font-semibold text-foreground">{s.ticker}</span> <span className="text-muted-foreground">{s.name}</span></span>
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">{s.sector}</span>
                    <Plus className="w-3.5 h-3.5 text-emerald-400" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="h-32 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : watchlist.length === 0 ? (
          <div className="h-32 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <Star className="w-6 h-6 mb-2 opacity-40" />
            <p>Your watchlist is empty.</p>
            <p className="text-xs mt-1">Watchlist stocks are always scanned and pinned to the top of the scanner.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {watchlist.map((w) => (
              <div
                key={w.ticker}
                data-testid={`watchlist-row-${w.ticker}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 hover:border-emerald-500/40 transition-colors"
              >
                <Star className="w-4 h-4 fill-amber-400 text-amber-400 flex-shrink-0" />
                <button onClick={() => setDetail(w.ticker)} className="flex-1 text-left">
                  <span className="font-bold text-sm text-foreground">{w.ticker}</span>
                  <span className="text-[11px] text-muted-foreground ml-2">{w.companyName ?? ""}</span>
                </button>
                <span className="text-[10px] text-muted-foreground">{w.sector ?? "—"}</span>
                <span className="text-[10px] text-muted-foreground hidden sm:block">added {fmtDateTime(w.addedAt)}</span>
                <button onClick={() => remove(w.ticker)} title="Remove" data-testid={`watchlist-remove-${w.ticker}`}
                  className="text-muted-foreground hover:text-red-400 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <StockDetail ticker={detail} onClose={() => setDetail(null)} />
    </StocksShell>
  );
}
