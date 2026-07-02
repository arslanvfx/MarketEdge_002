import { Link, useLocation } from "wouter";
import { useUser, useClerk, Show } from "@clerk/react";
import { Activity, LayoutDashboard, LineChart, Target, LogOut, Sparkles, CandlestickChart, Bot, Radar, Star, BarChart3, History, Zap, Leaf } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();

  const { data: aiSpend } = useQuery({
    queryKey: ["ai-spend"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/crypto/ai-spend`);
      return res.json() as Promise<{ level: string; labels: Record<string, string> }>;
    },
    refetchInterval: 20_000,
  });
  const spendLevel = (aiSpend?.level ?? "balanced") as "off" | "eco" | "balanced" | "max";

  async function setAiSpend(level: "off" | "eco" | "balanced" | "max") {
    await fetch(`${API_BASE}/crypto/ai-spend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    });
    void queryClient.invalidateQueries({ queryKey: ["ai-spend"] });
  }

  const navigation = [
    { name: "Markets", href: "/markets", icon: LineChart },
    { name: "Smart Picks", href: "/picks", icon: Sparkles },
    { name: "Crypto Predictor", href: "/predictor", icon: CandlestickChart },
    { name: "Combo Builder", href: "/builder", icon: Target },
    { name: "Portfolio", href: "/portfolio", icon: LayoutDashboard },
  ];

  const stocksNavigation = [
    { name: "Stock Scanner", href: "/stocks/scanner", icon: Radar },
    { name: "Stock Watchlist", href: "/stocks/watchlist", icon: Star },
    { name: "Stock Bot", href: "/stocks/bot", icon: Bot },
    { name: "Stock History", href: "/stocks/history", icon: History },
    { name: "Stock Performance", href: "/stocks/performance", icon: BarChart3 },
  ];

  const adminNavigation = [
    { name: "Bot Dashboard", href: "/bot", icon: Bot },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row">
      {/* Sidebar */}
      <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-border bg-card/50 flex flex-col">
        <div className="p-4 flex items-center gap-2 border-b border-border">
          <Activity className="w-6 h-6 text-primary" />
          <span className="font-bold text-lg tracking-tight">MarketEdge</span>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link key={item.name} href={item.href}>
                <span
                  data-testid={`nav-${item.name.toLowerCase().replace(" ", "-")}`}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {item.name}
                </span>
              </Link>
            );
          })}

          <div className="pt-2 mt-2 border-t border-border/50">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold px-3 mb-1">Stocks</p>
            {stocksNavigation.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.href || location.startsWith(`${item.href}/`);
              return (
                <Link key={item.name} href={item.href}>
                  <span
                    data-testid={`nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${
                      isActive
                        ? "bg-emerald-500/15 text-emerald-400 font-medium"
                        : "text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-400"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    {item.name}
                  </span>
                </Link>
              );
            })}
          </div>

          <Show when="signed-in">
            <div className="pt-2 mt-2 border-t border-border/50">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold px-3 mb-1">Admin</p>
              {adminNavigation.map((item) => {
                const Icon = item.icon;
                const isActive = location === item.href || location.startsWith(`${item.href}/`);
                return (
                  <Link key={item.name} href={item.href}>
                    <span
                      className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${
                        isActive
                          ? "bg-cyan-500/15 text-cyan-400 font-medium"
                          : "text-cyan-600/70 hover:bg-cyan-500/10 hover:text-cyan-400"
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      {item.name}
                    </span>
                  </Link>
                );
              })}
            </div>
          </Show>
        </nav>

        {/* Global AI spend level — kill switch + Eco/Balanced/Max */}
        <div className="px-4 pb-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-1.5 px-1">AI Spend</p>
          {/* Top row: Off toggle */}
          <button
            onClick={() => void setAiSpend(spendLevel === "off" ? "balanced" : "off")}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold mb-1.5 transition-colors ${
              spendLevel === "off"
                ? "border-rose-500/60 bg-rose-500/15 text-rose-300"
                : "border-border bg-background/30 text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Activity className="w-3 h-3" />
              AI Kill Switch
            </span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${spendLevel === "off" ? "bg-rose-500/30 text-rose-300" : "bg-muted text-muted-foreground"}`}>
              {spendLevel === "off" ? "OFF" : "ON"}
            </span>
          </button>
          {/* 3-level selector (disabled when off) */}
          <div className={`flex rounded-lg overflow-hidden border transition-opacity ${spendLevel === "off" ? "border-border/40 opacity-40 pointer-events-none" : "border-border"}`}>
            {(["eco", "balanced", "max"] as const).map((lvl, i) => {
              const icons = { eco: <Leaf className="w-2.5 h-2.5" />, balanced: <Zap className="w-2.5 h-2.5" />, max: <Sparkles className="w-2.5 h-2.5" /> };
              const colors = { eco: "bg-emerald-500/20 text-emerald-300", balanced: "bg-sky-500/20 text-sky-300", max: "bg-violet-500/20 text-violet-300" };
              return (
                <button
                  key={lvl}
                  onClick={() => void setAiSpend(lvl)}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[10px] font-semibold transition-colors ${i > 0 ? "border-l border-border" : ""} ${
                    spendLevel === lvl ? colors[lvl] : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  }`}
                >
                  {icons[lvl]}
                  {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                </button>
              );
            })}
          </div>
          <p className="text-[9px] text-muted-foreground/50 text-center mt-1">
            {spendLevel === "off" ? "All Claude calls gated — stat model only" :
             spendLevel === "eco" ? "Eco · snap + live price signals only" :
             spendLevel === "balanced" ? "Balanced · snap · live · stock signals" :
             "Max · all features including research"}
          </p>
        </div>

        <Show when="signed-in">
          <div className="p-4 border-t border-border mt-auto">
            <div className="flex items-center gap-3 mb-4 px-2">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
                {user?.firstName?.charAt(0) || user?.emailAddresses[0]?.emailAddress?.charAt(0) || "U"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user?.fullName || "User"}</p>
                <p className="text-xs text-muted-foreground truncate">{user?.emailAddresses[0]?.emailAddress}</p>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full justify-start text-muted-foreground"
              onClick={() => signOut({ redirectUrl: import.meta.env.BASE_URL || "/" })}
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </Show>
        
        <Show when="signed-out">
          <div className="p-4 border-t border-border mt-auto space-y-2">
            <Link href="/sign-in">
              <Button variant="outline" className="w-full" data-testid="button-signin-nav">Sign In</Button>
            </Link>
            <Link href="/sign-up">
              <Button className="w-full" data-testid="button-signup-nav">Sign Up</Button>
            </Link>
          </div>
        </Show>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 h-[100dvh] overflow-hidden">
        {children}
      </main>
    </div>
  );
}
