import { useGetMarketHistory } from "@workspace/api-client-react";
import { LineChart, Line, ResponsiveContainer, Tooltip, ReferenceLine } from "recharts";

interface MarketSparklineProps {
  platform: "kalshi" | "polymarket";
  marketId: string;
  currentOdds: number;
}

function TrendIndicator({ points }: { points: { yesOdds: number }[] }) {
  if (points.length < 2) return null;
  const first = points[0].yesOdds;
  const last = points[points.length - 1].yesOdds;
  const delta = last - first;
  const pct = (delta * 100).toFixed(1);
  if (Math.abs(delta) < 0.005) {
    return <span className="text-[10px] text-muted-foreground font-medium">→ stable</span>;
  }
  return delta > 0 ? (
    <span className="text-[10px] text-emerald-500 font-medium">↑ +{pct}%</span>
  ) : (
    <span className="text-[10px] text-rose-500 font-medium">↓ {pct}%</span>
  );
}

export function MarketSparkline({ platform, marketId, currentOdds }: MarketSparklineProps) {
  const { data, isLoading } = useGetMarketHistory(platform, marketId, {
    query: {
      staleTime: 60 * 60 * 1000,
      retry: false,
    },
  });

  const points = data?.points ?? [];

  if (isLoading) {
    return (
      <div className="h-10 w-full animate-pulse rounded bg-muted/40" />
    );
  }

  if (points.length < 3) {
    return (
      <div className="h-10 flex items-center">
        <span className="text-[10px] text-muted-foreground">No history</span>
      </div>
    );
  }

  const allOdds = points.map((p) => p.yesOdds);
  const minOdds = Math.min(...allOdds);
  const maxOdds = Math.max(...allOdds);
  const range = maxOdds - minOdds;
  const first = points[0].yesOdds;
  const last = points[points.length - 1].yesOdds;
  const trending = last > first ? "up" : last < first ? "down" : "flat";
  const lineColor =
    trending === "up" ? "#10b981" : trending === "down" ? "#f43f5e" : "#6366f1";

  const chartData = points.map((p) => ({ v: p.yesOdds }));

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">7d trend</span>
        <TrendIndicator points={points} />
      </div>
      <div className="h-10 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            {range > 0.02 && (
              <ReferenceLine
                y={currentOdds}
                stroke="currentColor"
                strokeDasharray="2 2"
                strokeOpacity={0.2}
                strokeWidth={1}
              />
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const val = payload[0].value as number;
                return (
                  <div className="rounded border border-border bg-popover px-2 py-1 text-[10px] shadow-md">
                    {(val * 100).toFixed(1)}%
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="v"
              stroke={lineColor}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
