import { Link, useLocation } from "wouter";
import { useUser, useClerk, Show } from "@clerk/react";
import { Activity, LayoutDashboard, LineChart, Target, LogOut, Sparkles, CandlestickChart, TrendingUp, Bot, Radar, Star, BarChart3, History, ShieldOff, Shield, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();

  const { data: aiSettings } = useQuery({
    queryKey: ["ai-settings"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/crypto/ai-settings`);
      return res.json() as Promise<{ mode: "stat" | "claude"; claudeCoins: string[] }>;
    },
    refetchInterval: 15_000,
  });
  const aiMode = aiSettings?.mode ?? "stat";

  async function setAiMode(mode: "stat" | "claude") {
    await fetch(`${API_BASE}/crypto/ai-settings/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    void queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
  }

  const { data: aiKillData } = useQuery({
    queryKey: ["ai-kill"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/crypto/ai-kill`);
      return res.json() as Promise<{ kill: boolean }>;
    },
    refetchInterval: 10_000,
  });
  const aiKill = aiKillData?.kill ?? false;

  const aiKillMutation = useMutation({
    mutationFn: async (kill: boolean) => {
      const res = await fetch(`${API_BASE}/crypto/ai-kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kill }),
      });
      return res.json() as Promise<{ kill: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ai-kill"] });
    },
  });

  type AIIntensityTier = "eco" | "balanced" | "max";
  const { data: aiIntensityData } = useQuery({
    queryKey: ["ai-intensity"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/crypto/ai-intensity`);
      return res.json() as Promise<{ tier: AIIntensityTier; label: string; estDailyCost: string }>;
    },
    refetchInterval: 15_000,
  });
  const aiTier = aiIntensityData?.tier ?? "eco";

  const aiIntensityMutation = useMutation({
    mutationFn: async (tier: AIIntensityTier) => {
      const res = await fetch(`${API_BASE}/crypto/ai-intensity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      return res.json() as Promise<{ tier: AIIntensityTier }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ai-intensity"] });
    },
  });

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

        {/* Emergency global AI kill — stops ALL Claude calls across the entire app */}
        <div className="px-4 pb-2">
          <button
            onClick={() => aiKillMutation.mutate(!aiKill)}
            disabled={aiKillMutation.isPending}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-all font-semibold text-[12px] ${
              aiKill
                ? "bg-red-500/20 border-red-500/60 text-red-400 hover:bg-red-500/30"
                : "bg-muted/40 border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <span className="flex items-center gap-2">
              {aiKill ? <ShieldOff className="w-4 h-4 shrink-0" /> : <Shield className="w-4 h-4 shrink-0" />}
              {aiKill ? "AI Killed — All Claude Off" : "Kill All AI"}
            </span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${aiKill ? "bg-red-500/30 text-red-300" : "bg-muted text-muted-foreground"}`}>
              {aiKill ? "ON" : "OFF"}
            </span>
          </button>
          {aiKill && (
            <p className="text-[9px] text-red-400/70 text-center mt-1">
              Zero AI spend · all models paused
            </p>
          )}
        </div>

        {/* AI intensity tier selector */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1.5 mb-1.5 px-1">
            <Zap className="w-3 h-3 text-muted-foreground/60" />
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">AI Intensity</p>
          </div>
          <div className={`flex rounded-lg overflow-hidden border border-border transition-opacity ${aiKill ? "opacity-40 pointer-events-none" : ""}`}>
            {(["eco", "balanced", "max"] as AIIntensityTier[]).map((t, i) => (
              <button
                key={t}
                onClick={() => aiIntensityMutation.mutate(t)}
                disabled={aiIntensityMutation.isPending}
                className={`flex-1 py-1.5 text-[11px] font-semibold transition-colors ${i > 0 ? "border-l border-border" : ""} ${
                  aiTier === t
                    ? t === "eco"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : t === "balanced"
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-red-500/20 text-red-300"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {t === "eco" ? "Eco" : t === "balanced" ? "Balanced" : "Max"}
              </button>
            ))}
          </div>
          <p className="text-[9px] text-muted-foreground/50 text-center mt-1">
            {aiKill ? "Overridden by kill switch" : aiTier === "eco" ? "~$20/day · conservative" : aiTier === "balanced" ? "~$30/day · middle ground" : "~$45/day · original settings"}
          </p>
        </div>

        {/* Per-bot AI mode toggle — only relevant when kill switch is OFF */}
        <div className="px-4 pb-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold mb-1.5 px-1">AI Mode</p>
          <div className={`flex rounded-lg overflow-hidden border border-border transition-opacity ${aiKill ? "opacity-40 pointer-events-none" : ""}`}>
            <button
              onClick={() => void setAiMode("stat")}
              className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] font-semibold transition-colors ${
                aiMode === "stat"
                  ? "bg-sky-500/20 text-sky-300"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <TrendingUp className="w-3 h-3" />
              Statistical
            </button>
            <button
              onClick={() => void setAiMode("claude")}
              className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] font-semibold border-l border-border transition-colors ${
                aiMode === "claude"
                  ? "bg-violet-500/20 text-violet-300"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <Sparkles className="w-3 h-3" />
              Claude AI
            </button>
          </div>
          <p className="text-[9px] text-muted-foreground/50 text-center mt-1">
            {aiKill ? "Overridden by kill switch" : aiMode === "stat" ? "Free · no AI spend" : "Paid · Claude active"}
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
