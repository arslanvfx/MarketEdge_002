import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Radar, Star, Bot, History, BarChart3, AlertTriangle, TrendingUp, FlaskConical } from "lucide-react";
import { stockGet, type StockMeta } from "@/lib/stocks-api";

const TABS = [
  { name: "Scanner", href: "/stocks/scanner", icon: Radar },
  { name: "Research", href: "/stocks/research", icon: FlaskConical },
  { name: "Watchlist", href: "/stocks/watchlist", icon: Star },
  { name: "Bot", href: "/stocks/bot", icon: Bot },
  { name: "History", href: "/stocks/history", icon: History },
  { name: "Performance", href: "/stocks/performance", icon: BarChart3 },
];

export function StocksShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const { data: meta } = useQuery<StockMeta>({
    queryKey: ["stocks-meta"],
    queryFn: () => stockGet<StockMeta>("/meta"),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Section header + tab bar */}
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border">
        <div className="px-6 pt-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <TrendingUp className="w-6 h-6 text-emerald-400" />
            <div>
              <h1 className="text-lg font-bold tracking-tight text-foreground">Stock Trading</h1>
              <p className="text-xs text-muted-foreground">
                Automated equities engine · {meta?.universeSize ?? "—"} stocks across {meta?.sectors?.length ?? 11} sectors
              </p>
            </div>
          </div>
          <div>
            {meta && !meta.configured ? (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                Broker not connected
              </span>
            ) : meta?.configured ? (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                Broker connected
              </span>
            ) : null}
          </div>
        </div>
        <nav className="px-4 flex items-center gap-1 overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = location === tab.href || location.startsWith(`${tab.href}/`);
            return (
              <Link key={tab.href} href={tab.href}>
                <span
                  data-testid={`tab-stocks-${tab.name.toLowerCase()}`}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? "border-emerald-400 text-emerald-400"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.name}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Broker-not-connected banner */}
      {meta && !meta.configured && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            Alpaca brokerage keys are not configured, so live prices, scans, and trading are paused.
            The dashboard is fully browsable — add <code className="text-amber-200">ALPACA_API_KEY_ID</code> and{" "}
            <code className="text-amber-200">ALPACA_API_SECRET_KEY</code> to activate live data.
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
