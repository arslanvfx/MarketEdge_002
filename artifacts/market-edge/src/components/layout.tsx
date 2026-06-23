import { Link, useLocation } from "wouter";
import { useUser, useClerk, Show } from "@clerk/react";
import { Activity, LayoutDashboard, LineChart, Target, LogOut, Sparkles, CandlestickChart } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();

  const navigation = [
    { name: "Markets", href: "/markets", icon: LineChart },
    { name: "Smart Picks", href: "/picks", icon: Sparkles },
    { name: "Crypto Predictor", href: "/predictor", icon: CandlestickChart },
    { name: "Combo Builder", href: "/builder", icon: Target },
    { name: "Portfolio", href: "/portfolio", icon: LayoutDashboard },
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
        </nav>

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
