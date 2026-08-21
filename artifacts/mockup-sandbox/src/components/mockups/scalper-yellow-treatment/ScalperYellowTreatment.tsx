import { Activity, ArrowDown, ArrowUp, Clock, Zap } from "lucide-react";

const yellowShell =
  "border border-amber-400/65 bg-amber-300/[0.12] shadow-[inset_0_1px_0_rgba(253,230,138,0.14),0_10px_30px_rgba(217,119,6,0.08)]";

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-amber-200/10 bg-black/15 p-2.5 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-amber-100/55">{label}</div>
      <div className="font-mono text-xs font-semibold text-amber-50">{value}</div>
    </div>
  );
}

function ActiveScalperCard() {
  return (
    <section className={`rounded-xl p-5 text-amber-50 ${yellowShell}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-2xl font-black tracking-tight text-amber-50">NEAR</div>
          <span className="flex items-center gap-1 rounded-full bg-amber-200/20 px-3 py-1 text-sm font-bold text-amber-50">
            <ArrowDown className="h-3.5 w-3.5" /> NO
          </span>
          <span className="rounded-full border border-amber-200/30 bg-amber-100/15 px-2 py-0.5 text-xs font-bold tracking-wide text-amber-50">
            SCALPER
          </span>
          <span className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-bold text-red-200">LIVE</span>
          <span className="text-xs text-amber-100/60">Opened 02:28:15 AM</span>
        </div>
        <div className="text-right">
          <div className="text-xs text-amber-100/55">Settlement</div>
          <div className="text-sm font-bold text-amber-100">Pending</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <Metric label="NO Fill" value="98¢" />
        <Metric label="YES Fill" value="2¢" />
        <Metric label="NO Fill" value="98¢" />
        <Metric label="Contracts Filled" value="3" />
        <Metric label="Spend" value="$2.94" />
        <Metric label="Ticker" value="KXNEAR15M-26AUG21" wide />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Metric label="Window" value="2:15 AM EST" />
        <div className="flex items-end justify-end rounded-lg border border-dashed border-amber-200/15 p-2.5 text-right text-[11px] text-amber-100/55">
          <span className="flex items-center gap-1"><Activity className="h-3 w-3 text-amber-200/70" /> Waiting for settlement</span>
        </div>
      </div>
    </section>
  );
}

function HistoryScalperCard() {
  return (
    <section className={`rounded-xl p-4 text-amber-50 ${yellowShell}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-base font-black tracking-tight">NEAR</span>
        <span className="flex items-center gap-0.5 rounded-full bg-amber-200/20 px-2 py-0.5 text-xs font-bold text-amber-50">
          <ArrowDown className="h-3 w-3" /> BELOW
        </span>
        <span className="flex items-center gap-1 rounded-full border border-amber-200/30 bg-amber-100/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-50">
          <Zap className="h-2.5 w-2.5" /> SCALPER
        </span>
        <span className="rounded bg-amber-100/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-100">PAPER</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-amber-100/60">
          <Clock className="h-3 w-3" /> Aug 21, 2:28 AM
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Metric label="Order" value="KXNEAR15M-26AUG21" wide />
        <Metric label="Settlement" value="Won" />
        <Metric label="Entry" value="2¢ YES · 98¢ NO" wide />
        <Metric label="Result" value="YES won" />
        <Metric label="Size" value="3 @ 98¢" />
        <div className="rounded-lg bg-emerald-400/10 p-2.5">
          <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-amber-100/55">P&L</div>
          <div className="font-mono text-sm font-bold text-emerald-300">+$0.06</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-amber-100/60">
        <span className="font-mono">2:15 AM EST</span>
        <span className="font-semibold text-emerald-300">· confirmed fill</span>
        <span>· settled normally</span>
      </div>
    </section>
  );
}

export function ScalperYellowTreatment() {
  return (
    <main className="min-h-screen bg-[#08090d] p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-3">
        <div className="flex items-center gap-2 px-1">
          <span className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_12px_rgba(252,211,77,0.8)]" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-100/75">Scalper bets</span>
          <span className="text-xs text-amber-100/40">easy to spot at a glance</span>
        </div>
        <ActiveScalperCard />
        <HistoryScalperCard />
      </div>
    </main>
  );
}