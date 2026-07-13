import { useMemo, useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, RefreshCw, Star, TrendingUp, TrendingDown, CalendarClock, Loader2, ArrowUpDown, BarChart2, FlaskConical, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { StocksShell } from "./stocks-shell";
import { StockDetail } from "./stock-detail";
import {
  stockGet, stockAuth, fmtUsd, fmtPct, sentimentColor, SECTORS,
  type ScannerRow, type WatchlistEntry, type ResearchReport, type StockBotConfig,
  type ScanProgress,
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
  const [maAlignOnly, setMaAlignOnly] = useState(false);

  // Results: long staleTime so data stays alive when switching tabs.
  const { data: scanData, isLoading } = useQuery<{ results: ScannerRow[]; lastScanAt: number }>({
    queryKey: ["stocks-scanner"],
    queryFn: () => stockGet("/scanner"),
    staleTime: 5 * 60_000,    // keep cached for 5 min — survives tab switches
    refetchInterval: 2 * 60_000, // background refresh every 2 min
  });

  // Progress: poll every 2s; only the backend allocates computation.
  const { data: progressData } = useQuery<ScanProgress>({
    queryKey: ["stocks-scanner-progress"],
    queryFn: () => stockGet("/scanner/progress"),
    refetchInterval: 2_000,
  });

  const scanInProgress = progressData?.scanning ?? false;
  const progressPct = progressData?.pct ?? 0;
  const progressPhase = progressData?.phase ?? "idle";
  const currentTicker = progressData?.currentTicker ?? "";

  // When a scan finishes (transitions from scanning to done) refresh results.
  const [wasScanning, setWasScanning] = useState(false);
  useEffect(() => {
    if (wasScanning && !scanInProgress) {
      qc.invalidateQueries({ queryKey: ["stocks-scanner"] });
    }
    setWasScanning(scanInProgress);
  }, [scanInProgress]);

  const { data: watchData } = useQuery<{ watchlist: WatchlistEntry[] }>({
    queryKey: ["stocks-watchlist"],
    queryFn: () => stockGet("/watchlist"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const { data: researchData } = useQuery<{
    reports: ResearchReport[];
    running: boolean;
    ready: string[];
  }>({
    queryKey: ["stocks-research"],
    queryFn: () => stockGet("/research"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const { data: botCfgData } = useQuery<{ config: StockBotConfig }>({
    queryKey: ["stocks-bot-config"],
    queryFn: () => stockGet("/bot/config"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const researchMap = useMemo(() => {
    const m: Record<string, ResearchReport> = {};
    for (const r of researchData?.reports ?? []) m[r.ticker] = r;
    return m;
  }, [researchData]);
  const researchRunning = researchData?.running ?? false;
  const botSectorFocus = botCfgData?.config?.sectorFocus ?? [];

  const watchSet = useMemo(
    () => new Set((watchData?.watchlist ?? []).map((w) => w.ticker)),
    [watchData],
  );

  const results = scanData?.results ?? [];
  const lastScanAt = scanData?.lastScanAt ?? 0;

  /** 0 = screened only, 1 = deep scored, 2 = research pick */
  function rowTier(r: ScannerRow, research?: ResearchReport): 0 | 1 | 2 {
    if (research && research.stance !== "avoid") return 2;
    // Deep-scored stocks have rich details (rsi, maAlignment, etc.)
    if (r.details && (typeof r.details.rsi === "number" || typeof r.details.maAlignment === "boolean")) return 1;
    return 0;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let rows = results.filter((r) => {
      if (sector !== "All" && r.sector !== sector) return false;
      if (q && !r.ticker.includes(q) && !r.companyName.toUpperCase().includes(q)) return false;
      if (maAlignOnly && !(r.details?.maAlignment as boolean)) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      if (sortKey === "changePct") return Math.abs(b.changePct) - Math.abs(a.changePct);
      if (sortKey === "score") {
        // Tier-aware: research picks → deep scored → screened only, then score within each tier
        const ta = rowTier(a, researchMap[a.ticker]);
        const tb = rowTier(b, researchMap[b.ticker]);
        if (ta !== tb) return tb - ta;
        // Within research tier: sort by Claude confidence
        if (ta === 2) {
          const ca = researchMap[a.ticker]?.confidence ?? 0;
          const cb = researchMap[b.ticker]?.confidence ?? 0;
          if (cb !== ca) return cb - ca;
        }
        return b.score - a.score;
      }
      return (b[sortKey] as number) - (a[sortKey] as number);
    });
    return rows;
  }, [results, sector, search, sortKey, maAlignOnly, researchMap]);

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
    try {
      // Fire the scan (returns quickly; actual progress tracked via /scanner/progress).
      stockAuth(getToken, "/scanner/run", "POST").catch(() => {});
    } catch {
      toast({
        title: "Scan failed",
        description: "Broker may not be connected.",
        variant: "destructive",
      });
    }
  }

  // Human-readable scan status
  const scanStatusText = (() => {
    if (progressPhase === "snapshots") return "Fetching prices…";
    if (progressPhase === "screening") {
      return `Screening market — ${progressData?.screened ?? 0} / ${progressData?.universeSize ?? 0} stocks`;
    }
    if (progressPhase === "research") {
      return `Researching top picks — ${progressData?.researchDone ?? 0} / ${progressData?.researchTotal ?? 0}`;
    }
    if (progressPhase === "scoring") {
      return currentTicker
        ? `Scoring ${progressData?.done ?? 0} / ${progressData?.total ?? 0} — ${currentTicker}`
        : `Scoring ${progressData?.done ?? 0} / ${progressData?.total ?? 0}`;
    }
    if (progressPhase === "done") return "Scan complete ✓";
    if (lastScanAt > 0) return `Last scan ${fmtAge(lastScanAt)}`;
    return "No scan yet";
  })();

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
          <Button
            size="sm"
            variant="outline"
            onClick={triggerScan}
            disabled={scanInProgress}
            className="gap-1.5"
          >
            {scanInProgress
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            {scanInProgress ? "Scanning…" : "Run scan"}
          </Button>
          {researchRunning && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Researching…
            </span>
          )}
        </div>

        {/* Progress bar — visible while a scan is running or just finished */}
        {(scanInProgress || progressPhase === "done") && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                {scanInProgress && <Loader2 className="w-3 h-3 animate-spin" />}
                {scanStatusText}
              </span>
              {progressPhase === "scoring" && (
                <span className="font-mono text-emerald-400">{progressPct}%</span>
              )}
            </div>
            <div className="h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  progressPhase === "done" ? "bg-emerald-500" : "bg-emerald-500/70"
                }`}
                style={{
                  width: progressPhase === "snapshots" ? "5%" :
                         progressPhase === "screening" ? "15%" :
                         progressPhase === "research" ? "95%" :
                         progressPhase === "done" ? "100%" :
                         `${Math.max(15, progressPct)}%`
                }}
              />
            </div>
          </div>
        )}

        {/* Sector tabs + MA filter */}
        <div className="flex flex-wrap gap-2 items-center">
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
          <div className="h-4 w-px bg-border mx-0.5" />
          <button
            onClick={() => setMaAlignOnly(!maAlignOnly)}
            title="Show only stocks where 21-day MA is above 50-day MA — bullish trend structure"
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors flex items-center gap-1.5 ${
              maAlignOnly
                ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <BarChart2 className="w-3 h-3" /> 21D MA aligned
          </button>
        </div>

        {/* Status line below filters */}
        {!scanInProgress && progressPhase !== "done" && (
          <p className="text-[11px] text-muted-foreground -mt-2">{scanStatusText}</p>
        )}

        {isLoading ? (
          <div className="h-40 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading scanner…
          </div>
        ) : results.length === 0 && !scanInProgress ? (
          <div className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <p>No scanner results yet.</p>
            <p className="text-xs mt-1">Hit "Run scan" to load the latest prices — works any time, market open or closed.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-32 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <p>No stocks match the current filters.</p>
            {maAlignOnly && (
              <p className="text-xs mt-1">The 21D MA aligned filter requires deep-scored stocks. Run a scan first.</p>
            )}
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
                    <ScannerCard key={r.ticker} row={r} research={researchMap[r.ticker]} watched botExcluded={false} onOpen={() => setDetail(r.ticker)} onToggleWatch={() => toggleWatch(r)} />
                  ))}
                </div>
              </div>
            )}
            <div>
              {pinned.length > 0 && <div className="text-xs font-semibold text-muted-foreground mb-2">All opportunities</div>}
              {sortKey === "score"
                ? <TieredList rows={unpinned} researchMap={researchMap} botSectorFocus={botSectorFocus} rowTier={rowTier} onOpen={(t) => setDetail(t)} onToggleWatch={(r) => toggleWatch(r)} />
                : (
                  <div className="space-y-1.5">
                    {unpinned.map((r) => {
                      const excluded = botSectorFocus.length > 0 && !botSectorFocus.includes(r.sector);
                      return (
                        <ScannerCard key={r.ticker} row={r} research={researchMap[r.ticker]} watched={false} botExcluded={excluded} onOpen={() => setDetail(r.ticker)} onToggleWatch={() => toggleWatch(r)} />
                      );
                    })}
                  </div>
                )}
            </div>
          </div>
        )}
      </div>

      <StockDetail ticker={detail} onClose={() => setDetail(null)} />
    </StocksShell>
  );
}

/** Format how long ago a UNIX-ms timestamp was, e.g. "3 min ago". */
function fmtAge(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function TieredList({ rows, researchMap, botSectorFocus, rowTier, onOpen, onToggleWatch }: {
  rows: ScannerRow[];
  researchMap: Record<string, ResearchReport>;
  botSectorFocus: string[];
  rowTier: (r: ScannerRow, research?: ResearchReport) => 0 | 1 | 2;
  onOpen: (ticker: string) => void;
  onToggleWatch: (row: ScannerRow) => void;
}) {
  const tier2 = rows.filter((r) => rowTier(r, researchMap[r.ticker]) === 2);
  const tier1 = rows.filter((r) => rowTier(r, researchMap[r.ticker]) === 1);
  const tier0 = rows.filter((r) => rowTier(r, researchMap[r.ticker]) === 0);

  const renderRows = (list: ScannerRow[]) =>
    list.map((r) => {
      const excluded = botSectorFocus.length > 0 && !botSectorFocus.includes(r.sector);
      return (
        <ScannerCard
          key={r.ticker}
          row={r}
          research={researchMap[r.ticker]}
          watched={false}
          botExcluded={excluded}
          onOpen={() => onOpen(r.ticker)}
          onToggleWatch={() => onToggleWatch(r)}
        />
      );
    });

  return (
    <div className="space-y-4">
      {tier2.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-400 mb-2">
            <FlaskConical className="w-3.5 h-3.5" /> Research picks
            <span className="text-muted-foreground font-normal">— Claude-analyzed, highest conviction</span>
          </div>
          <div className="space-y-1.5">{renderRows(tier2)}</div>
        </div>
      )}
      {tier1.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 mb-2">
            <Layers className="w-3.5 h-3.5" /> Deep scored
            <span className="text-muted-foreground font-normal">— full technical analysis</span>
          </div>
          <div className="space-y-1.5">{renderRows(tier1)}</div>
        </div>
      )}
      {tier0.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-2">
            Screened
            <span className="font-normal">— initial pass only</span>
          </div>
          <div className="space-y-1.5">{renderRows(tier0)}</div>
        </div>
      )}
    </div>
  );
}

function ResearchBadge({ r }: { r: ResearchReport }) {
  const cfg =
    r.confidence >= 70
      ? { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400", dot: "bg-emerald-400" }
      : r.confidence >= 40
        ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", dot: "bg-amber-400" }
        : { cls: "border-red-500/40 bg-red-500/10 text-red-400", dot: "bg-red-400" };
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border cursor-help ${cfg.cls}`}
      title={r.summary || r.horizon}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {r.confidence} · {r.horizon}
    </span>
  );
}

function ScannerCard({ row, research, watched, botExcluded, onOpen, onToggleWatch }: {
  row: ScannerRow; research?: ResearchReport; watched: boolean; botExcluded: boolean; onOpen: () => void; onToggleWatch: () => void;
}) {
  const up = row.direction === "up";
  const rsiRaw = row.details?.rsi;
  const rsi = typeof rsiRaw === "number" && !isNaN(rsiRaw) ? rsiRaw : null;
  return (
    <div
      onClick={onOpen}
      data-testid={`scanner-row-${row.ticker}`}
      className={`flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5 hover:border-emerald-500/40 transition-colors cursor-pointer ${
        botExcluded ? "border-border/40 opacity-50" : "border-border"
      }`}
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
        {research && <ResearchBadge r={research} />}
        {botExcluded && (
          <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground/60" title={`Sector "${row.sector}" is outside the bot's active sector focus`}>
            Bot excluded
          </span>
        )}
        {rsi != null && (
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
              rsi > 50
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-border/60 text-muted-foreground"
            }`}
            title={rsi > 50 ? "RSI above 50 — bullish momentum" : "RSI at or below 50"}
            data-testid={`rsi-badge-${row.ticker}`}
          >
            RSI {Math.round(rsi)}{rsi > 50 ? " ↑" : ""}
          </span>
        )}
        {(row.details?.maAlignment as boolean) && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-400" title="21-day MA is above 50-day MA — bullish trend structure">
            <BarChart2 className="w-3 h-3" /> 21MA↑
          </span>
        )}
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
