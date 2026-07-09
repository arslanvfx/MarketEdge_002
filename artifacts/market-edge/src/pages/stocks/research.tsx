import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FlaskConical, Loader2, Search, Globe, TrendingUp, TrendingDown, ChevronDown, ChevronUp,
} from "lucide-react";
import { StocksShell } from "./stocks-shell";
import { StockDetail } from "./stock-detail";
import {
  stockGet, fmtUsd,
  type ResearchReport, type ResearchProgress, type TradingMode,
} from "@/lib/stocks-api";

const HORIZON_LABELS: Record<TradingMode, string> = {
  day: "Day Trade",
  swing: "Swing (2–10d)",
  long: "Long-Term",
};

const HORIZON_STYLES: Record<TradingMode, string> = {
  day: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  swing: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  long: "border-violet-500/40 bg-violet-500/10 text-violet-400",
};

function confidenceStyle(c: number): string {
  if (c >= 70) return "text-emerald-400";
  if (c >= 50) return "text-amber-400";
  return "text-red-400";
}

function fmtAge(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function StockResearch() {
  const [search, setSearch] = useState("");
  const [horizon, setHorizon] = useState<TradingMode | "all">("all");
  const [detail, setDetail] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{
    reports: ResearchReport[];
    running: boolean;
    ready: string[];
    progress: ResearchProgress;
  }>({
    queryKey: ["stocks-research"],
    queryFn: () => stockGet("/research"),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const reports = data?.reports ?? [];
  const running = data?.running ?? false;
  const progress = data?.progress;

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return reports.filter((r) => {
      if (horizon !== "all" && r.horizon !== horizon) return false;
      if (q && !r.ticker.includes(q) && !r.companyName.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [reports, search, horizon]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { day: 0, swing: 0, long: 0 };
    for (const r of reports) c[r.horizon] = (c[r.horizon] ?? 0) + 1;
    return c;
  }, [reports]);

  return (
    <StocksShell>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-foreground flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-sky-400" /> AI Research Reports
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Claude researches the strongest scanner candidates with live web search — horizon, conviction, bull and bear factors.
            </p>
          </div>
          {running && progress && (
            <span className="flex items-center gap-1.5 text-xs text-sky-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Researching {progress.done} / {progress.total}
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ticker or company…"
              data-testid="input-research-search"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-card border border-border focus:border-emerald-500/50 outline-none"
            />
          </div>
          <div className="flex gap-1.5">
            {(["all", "day", "swing", "long"] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  horizon === h
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {h === "all" ? `All (${reports.length})` : `${HORIZON_LABELS[h]} (${counts[h] ?? 0})`}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="h-40 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading research…
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <p>{reports.length === 0 ? "No research reports yet." : "No reports match the current filters."}</p>
            {reports.length === 0 && (
              <p className="text-xs mt-1">
                Run a scan from the Scanner tab — the top candidates are researched automatically.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {filtered.map((r) => (
              <ReportCard key={`${r.ticker}-${r.createdAt}`} r={r} onOpen={() => setDetail(r.ticker)} />
            ))}
          </div>
        )}
      </div>

      <StockDetail ticker={detail} onClose={() => setDetail(null)} />
    </StocksShell>
  );
}

function ReportCard({ r, onOpen }: { r: ResearchReport; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="rounded-lg border border-border bg-card p-4 hover:border-emerald-500/40 transition-colors"
      data-testid={`report-${r.ticker}`}
    >
      <div className="flex items-start justify-between gap-3">
        <button onClick={onOpen} className="text-left">
          <div className="font-bold text-foreground text-sm hover:text-emerald-400 transition-colors">
            {r.ticker}
            {r.price != null && <span className="ml-2 font-normal text-muted-foreground text-xs">{fmtUsd(r.price)}</span>}
          </div>
          <div className="text-[11px] text-muted-foreground truncate max-w-[220px]">
            {r.companyName} · {r.sector}
          </div>
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${HORIZON_STYLES[r.horizon]}`}>
            {HORIZON_LABELS[r.horizon]}
          </span>
          <span className={`text-lg font-bold ${confidenceStyle(r.confidence)}`}>{r.confidence}</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{r.summary}</p>

      {expanded && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400 mb-1">
              <TrendingUp className="w-3 h-3" /> Bull case
            </div>
            <ul className="space-y-1">
              {r.bullFactors.map((f, i) => (
                <li key={i} className="text-[11px] text-muted-foreground pl-2 border-l-2 border-emerald-500/40">{f}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="flex items-center gap-1 text-[11px] font-semibold text-red-400 mb-1">
              <TrendingDown className="w-3 h-3" /> Bear risks
            </div>
            <ul className="space-y-1">
              {r.bearFactors.map((f, i) => (
                <li key={i} className="text-[11px] text-muted-foreground pl-2 border-l-2 border-red-500/40">{f}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{fmtAge(r.createdAt)}</span>
          {r.webSearchUsed && (
            <span className="inline-flex items-center gap-1 text-sky-400" title="Claude used live web search for this report">
              <Globe className="w-3 h-3" /> web
            </span>
          )}
        </div>
        {(r.bullFactors.length > 0 || r.bearFactors.length > 0) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            data-testid={`expand-${r.ticker}`}
          >
            {expanded ? <>Less <ChevronUp className="w-3 h-3" /></> : <>Factors <ChevronDown className="w-3 h-3" /></>}
          </button>
        )}
      </div>
    </div>
  );
}
