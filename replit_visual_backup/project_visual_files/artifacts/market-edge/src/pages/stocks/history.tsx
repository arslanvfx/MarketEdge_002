import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StocksShell } from "./stocks-shell";
import {
  stockGet, fmtUsd, fmtSignedUsd, fmtDateTime,
  type HistoryRow,
} from "@/lib/stocks-api";

const PAGE_SIZE = 20;

// Friendly labels for the bot's exit reason codes (persisted on the bet row at
// close time). Unknown codes fall back to de-snake-cased raw text.
const EXIT_REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop loss hit",
  target: "Target price hit",
  eod_close: "End-of-day close",
  max_hold: "Max hold time reached",
  swing_stop: "Swing stop (\u22124%)",
  swing_target: "Swing target (+8%)",
  trailing_stop: "Trailing stop (\u22126% from peak)",
  manual: "Closed manually",
};

function fmtExitReason(raw: string | null): string | null {
  if (!raw) return null;
  if (EXIT_REASON_LABELS[raw]) return EXIT_REASON_LABELS[raw];
  const downgrade = raw.match(/^research_downgrade \(conf (\d+)\)$/);
  if (downgrade) return `Research downgrade (conf ${downgrade[1]})`;
  return raw.replace(/_/g, " ");
}

export default function StockHistory() {
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery<{ history: HistoryRow[] }>({
    queryKey: ["stocks-bot-history"],
    queryFn: () => stockGet("/bot/history?limit=500"),
    refetchInterval: 15_000,
  });

  const rows = data?.history ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clamped = Math.min(page, totalPages - 1);
  const paged = useMemo(
    () => rows.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE),
    [rows, clamped],
  );

  return (
    <StocksShell>
      <div className="p-6 space-y-4">
        {isLoading ? (
          <div className="h-40 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading history…
          </div>
        ) : rows.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground text-sm">
            <p>No trade history yet.</p>
            <p className="text-xs mt-1">Trades appear here once the bot starts executing.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    {["Time", "Ticker", "Horizon", "Side", "Entry", "Exit", "P&L", "Return", "Reason"].map((h) => (
                      <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paged.map((r) => {
                    const pnl = r.pnl == null ? null : Number(r.pnl);
                    const entry = r.entry_price != null ? Number(r.entry_price) : null;
                    const notional = r.notional != null ? Number(r.notional) : (entry != null && r.qty != null ? entry * Number(r.qty) : null);
                    const retPct = pnl != null && notional ? (pnl / notional) * 100 : null;
                    return (
                      <tr key={r.id} className="border-t border-border" data-testid={`history-row-${r.id}`}>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                        <td className="px-3 py-2 font-bold text-foreground">{r.ticker}</td>
                        <td className="px-3 py-2 text-muted-foreground capitalize">{r.trading_mode ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground capitalize">{r.side === "short" ? "Short" : "Long"}</td>
                        <td className="px-3 py-2 text-foreground">{fmtUsd(r.entry_price)}</td>
                        <td className="px-3 py-2 text-foreground">{r.exited_at ? fmtUsd(r.exit_price) : <span className="text-xs text-sky-400">open</span>}</td>
                        <td className={`px-3 py-2 font-semibold ${pnl == null ? "text-muted-foreground" : pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pnl == null ? "—" : fmtSignedUsd(pnl)}
                        </td>
                        <td className={`px-3 py-2 ${retPct == null ? "text-muted-foreground" : retPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {retPct == null ? "—" : `${retPct >= 0 ? "+" : ""}${retPct.toFixed(2)}%`}
                        </td>
                        <td
                          className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap"
                          title={r.exit_reason ?? undefined}
                          data-testid={`exit-reason-${r.id}`}
                        >
                          {fmtExitReason(r.exit_reason) ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {rows.length} trades · page {clamped + 1} of {totalPages}
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-8 gap-1" disabled={clamped === 0} onClick={() => setPage(clamped - 1)}>
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1" disabled={clamped >= totalPages - 1} onClick={() => setPage(clamped + 1)}>
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </StocksShell>
  );
}
