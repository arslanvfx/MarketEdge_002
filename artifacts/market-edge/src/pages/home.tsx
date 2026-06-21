import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Activity, Zap, Shield, LineChart } from "lucide-react";
import { useListMarkets } from "@workspace/api-client-react";

export default function Home() {
  const { data } = useListMarkets({ limit: 3 });

  return (
    <div className="min-h-screen bg-background flex flex-col items-center">
      {/* Hero Section */}
      <section className="w-full max-w-6xl px-6 py-24 md:py-32 flex flex-col items-center text-center space-y-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-4">
          <Activity className="w-4 h-4" />
          <span>Professional Prediction Market Analysis</span>
        </div>
        
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-foreground max-w-4xl">
          Find your edge in <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-blue-400">prediction markets</span>
        </h1>
        
        <p className="text-xl text-muted-foreground max-w-2xl">
          Analyze, combine, and optimize across Kalshi and Polymarket. Build perfectly hedged portfolios and uncover mispriced joint probabilities.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4 pt-8">
          <Link href="/sign-up">
            <Button size="lg" className="h-12 px-8 text-lg" data-testid="button-get-started">
              Get Started
            </Button>
          </Link>
          <Link href="/markets">
            <Button size="lg" variant="outline" className="h-12 px-8 text-lg" data-testid="button-browse-markets">
              Browse Markets
            </Button>
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="w-full max-w-6xl px-6 py-24 grid grid-cols-1 md:grid-cols-3 gap-12 border-t border-border/50">
        <div className="space-y-4">
          <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500">
            <LineChart className="w-6 h-6" />
          </div>
          <h3 className="text-xl font-semibold">Cross-Platform Data</h3>
          <p className="text-muted-foreground">Pull live odds from both Kalshi and Polymarket into a single, unified trading interface.</p>
        </div>
        <div className="space-y-4">
          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Zap className="w-6 h-6" />
          </div>
          <h3 className="text-xl font-semibold">Combo Optimizer</h3>
          <p className="text-muted-foreground">Select multiple markets and instantly discover the most profitable parlay combinations.</p>
        </div>
        <div className="space-y-4">
          <div className="w-12 h-12 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
            <Shield className="w-6 h-6" />
          </div>
          <h3 className="text-xl font-semibold">Risk Analysis</h3>
          <p className="text-muted-foreground">Automatically detect overlapping exposures and diversification warnings in your portfolio.</p>
        </div>
      </section>
    </div>
  );
}
