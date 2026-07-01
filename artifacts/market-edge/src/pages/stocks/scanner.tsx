import { useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, RefreshCw, Star, TrendingUp, TrendingDown, CalendarClock, Loader2, ArrowUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { StocksShell } from "./stocks-shell";
import { StockDetail } from "./stock-detail";
import {
  stockGet, stockAuth, fmtUsd, fmtPct, sentimentColor, SECTORS,
  type ScannerRow, type WatchlistEntry,
} from "@/lib/stocks-api";

type SortKey = "score" | "changePct" | "confidence" | "price";

export default function StockScanner() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [sector, setSector] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [detail, setDetail] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const { data: scanData, isLoading } = useQuery<{ results: ScannerRow[]; lastScanAt: number }>({
    queryKey: ["stocks-scanner"],
    queryFn: () => stockGet("/scanner"),
    refetchInterval: 10_000,
  });

  const { data: watchData } = useQuery<{ watchlist: WatchlistEntry[] }>({
    queryKey: ["stocks-watchlist"],
    queryFn: () => stockGet("/watchlist"),
    refetchInterval: 30_000,
  });

  const watchSet = useMemo(
    () => new Set((watchData?.watchlist ?? []).map((w) => w.ticker)),
    [watchData],
  );

  const results = scanData?.results ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let rows = results.filter((r) => {
      if (sector !== "All" && r.sector !== sector) return false;
      if (q && !r.ticker.includes(q) && !r.companyName.toUpperCase().includes(q)) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      if (sortKey === "changePct") return Math.abs(b.changePct) - Math.abs(a.changePct);
      return (b[sortKey] as number) - (a[sortKey] as number);
    });
    return rows;
  }, [results, sector, search, sortKey]);

  const pinned = filtered.filter((r) => watchSet.has(r.ticker));
  const unpinned = filtered.filter((r) => !watchSet.has(r.ticker));

  async function toggleWatch(row: ScannerRow) {
    const removing = watchSet.has(row.ticker);
    try {
      if (removing) {
        await stockAuth(getToken, `/watchlist/${row.ticker}`, "DELETE");
      } else {
        await stockAuth(getToken, "/watchlist", "POST", {
          ticker: row.ticker, companyName: row.companyName, sector: row.sector,
        });
      }
      await qc.invalidateQueries({ queryKey: ["stocks-watchlist"] });
    } catch (e) {
      toast({
        title: removing ? "Could not remove from watchlist" : "Could not add to watchlist",
        description: e instanceof Error ? e.message : "Sign in and try again.",
        variant: "destructive",
      });
    }
  }

  async function triggerScan() {
    setScanning(true);
    try {
      await stockAuth(getToken, "/scanner/run", "POST");
      await qc.invalidateQueries({ queryKey: ["stocks-scanner"] });
    } catch (e) {
      toast({
        title: "Scan failed",
        description: e instanceof Error ? e.message : "Broker may not be connected.",
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  }

  return (
    <StocksShell>
      <div className="p-6 space-y-5">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ticker or company…"
              data-testid="input-scanner-search"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-card border border-border focus:border-emerald-500/50 outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-card border border-border rounded-lg px-2 py-2 text-sm outline-none"
            >
              <option value="score">Opportunity score</option>
              <option value="confidence">Confidence</option>
              <option value="changePct">Daily move</option>
              <option value="price">Price</option>
            </select>
          </div>
          <Button size="sm" variant="outline" onClick={triggerScan} disabled={scanning} className="gap-1.5">
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Run scan
          </Button>
        </div>

        {/* Sector tabs */}
        <div className="flex flex-wrap gap-2">
          {["All", ...SECTORS].map((s) => (
            <button
              key={s}
              onClick={() => setSector(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                sector === s
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="h-40 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading scanner…
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <p>No scanner results yet.</p>
            <p className="text-xs mt-1">Hit "Run scan" to load the latest prices — works any time, market open or closed.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pinned.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 mb-2">
                  <Star className="w-3.5 h-3.5 fill-amber-400" /> Watchlist
                </div>
                <div className="space-y-1.5">
                  {pinned.map((r) => (
                    <ScannerCard key={r.ticker} row={r} watched onOpen={() => setDetail(r.ticker)} onToggleWatch={() => toggleWatch(r)} />
                  ))}
                </div>
              </div>
            )}
            <div>
              {pinned.length > 0 && <div className="text-xs font-semibold text-muted-foreground mb-2">All opportunities</div>}
              <div className="space-y-1.5">
                {unpinned.map((r) => (
                  <ScannerCard key={r.ticker} row={r} watched={false} onOpen={() => setDetail(r.ticker)} onToggleWatch={() => toggleWatch(r)} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <StockDetail ticker={detail} onClose={() => setDetail(null)} />
    </StocksShell>
  );
}

function ScannerCard({ row, watched, onOpen, onToggleWatch }: {
  row: ScannerRow; watched: boolean; onOpen: () => void; onToggleWatch: () => void;
}) {
  const up = row.direction === "up";
  return (
    <div
      onClick={onOpen}
      data-testid={`scanner-row-${row.ticker}`}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 hover:border-emerald-500/40 transition-colors cursor-pointer"
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggleWatch(); }}
        className="flex-shrink-0"
        title={watched ? "Remove from watchlist" : "Add to watchlist"}
        data-testid={`watch-toggle-${row.ticker}`}
      >
        <Star className={`w-4 h-4 ${watched ? "fill-amber-400 text-amber-400" : "text-muted-foreground hover:text-amber-400"}`} />
      </button>

      <div className="w-24 flex-shrink-0">
        <div className="font-bold text-sm text-foreground">{row.ticker}</div>
        <div className="text-[11px] text-muted-foreground truncate">{row.companyName}</div>
      </div>

      <div className="w-20 flex-shrink-0 text-right">
        <div className="text-sm font-semibold text-foreground">{fmtUsd(row.price)}</div>
        <div className={`text-[11px] font-medium ${row.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtPct(row.changePct)}</div>
      </div>

      <div className="flex-1 flex items-center justify-end gap-2 flex-wrap">
        {row.direction && (
          <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded ${up ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"}`}>
            {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.round(row.confidence)}%
          </span>
        )}
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${sentimentColor(row.newsSentiment)}`}>{row.newsSentiment}</span>
        {row.earningsSoon && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-400" title="Earnings within blackout window">
            <CalendarClock className="w-3 h-3" /> earnings
          </span>
        )}
        <span className="text-[11px] text-muted-foreground w-14 text-right" title="Opportunity score">
          {row.score.toFixed(1)}
        </span>
      </div>
    </div>
  );
}
