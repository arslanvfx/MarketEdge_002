import { useState } from "react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import type { BotStats } from "./types";
import { fmt$ } from "./utils";

export function PerfByCoin({ stats, activeMode }: { stats: BotStats; activeMode: "paper" | "live" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 sm:px-5 py-3 border-b border-border flex flex-wrap items-center gap-2 hover:bg-muted/20 transition-colors text-left"
      >
        <Activity className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold text-sm">Performance by Coin</h2>
        <span className={`ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${activeMode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"}`}>{activeMode}</span>
        <span className="ml-auto">{open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}</span>
      </button>
      {open && (
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                {["Coin", "Bets", "Wins", "Losses", "Win Rate", "P&L"].map(h => (
                  <th key={h} className="px-5 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.bySymbol.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-muted-foreground">
                    No settled {activeMode} performance by coin yet.
                  </td>
                </tr>
              ) : stats.bySymbol.map(row => (
                <tr key={row.symbol} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-5 py-2.5 font-bold">{row.symbol}</td>
                  <td className="px-5 py-2.5">{row.bets}</td>
                  <td className="px-5 py-2.5 text-emerald-400">{row.wins}</td>
                  <td className="px-5 py-2.5 text-red-400">{row.losses}</td>
                  <td className="px-5 py-2.5">{row.bets > 0 ? `${Math.round(row.wins / row.bets * 100)}%` : "—"}</td>
                  <td className={`px-5 py-2.5 font-semibold ${row.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt$(row.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}