import type { LucideIcon } from "lucide-react";
import { Activity, ArrowDown, BarChart3, CheckCircle2, Clock, DollarSign, FileText, Layers, ShoppingCart, Trophy, Zap } from "lucide-react";

const yellowShell =
  "border border-amber-400/40 bg-[linear-gradient(135deg,#0c0f12_0%,#171716_52%,#634515_100%)] text-amber-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_22px_rgba(245,158,11,0.16),0_14px_38px_rgba(0,0,0,0.35)]";

function Metric({ label, value, icon: Icon, wide = false }: { label: string; value: string; icon?: LucideIcon; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-amber-400/30 bg-black/45 p-2.5 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="flex items-start gap-1.5">
        {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />}
        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-amber-300/90">{label}</div>
          <div className="font-mono text-xs font-semibold text-amber-50">{value}</div>
        </div>
      </div>
    </div>
  );
}

function ActiveScalperCard() {
  return (
    <section className={`rounded-xl p-5 text-amber-50 ${yellowShell}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
      <div className="text-2xl font-black tracking-tight text-amber-50">NEAR</div>
          <span className="flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/20 px-3 py-1 text-sm font-bold text-amber-100">
            <ArrowDown className="h-3.5 w-3.5" /> NO
          </span>
          <span className="rounded-full border border-amber-300/35 bg-black/30 px-2 py-0.5 text-xs font-bold tracking-wide text-amber-100">
            SCALPER
          </span>
          <span className="rounded bg-gradient-to-br from-yellow-200 to-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-[#2b1b0d] shadow-[0_0_12px_rgba(245,158,11,0.35)]">LIVE</span>
          <span className="text-xs text-amber-100/70">Opened 02:28:15 AM</span>
        </div>
        <div className="text-right">
          <div className="text-xs text-amber-100/70">Settlement</div>
          <div className="text-sm font-bold text-amber-200">Pending</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <Metric icon={FileText} label="NO Fill" value="98¢" />
        <Metric icon={CheckCircle2} label="YES Fill" value="2¢" />
        <Metric icon={FileText} label="NO Fill" value="98¢" />
        <Metric icon={Layers} label="Contracts Filled" value="3" />
        <Metric icon={DollarSign} label="Spend" value="$2.94" />
        <Metric icon={BarChart3} label="Ticker" value="KXNEAR15M-26AUG21" wide />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Metric icon={Clock} label="Window" value="2:15 AM EST" />
        <div className="flex items-end justify-end rounded-lg border border-dashed border-amber-100/20 p-2.5 text-right text-[11px] text-amber-100/70">
          <span className="flex items-center gap-1"><Activity className="h-3 w-3 text-amber-200/80" /> Waiting for settlement</span>
        </div>
      </div>
    </section>
  );
}

function HistoryScalperCard() {
  return (
    <section className={`rounded-xl p-4 text-amber-50 ${yellowShell}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-base font-black tracking-tight text-amber-50">NEAR</span>
        <span className="flex items-center gap-0.5 rounded-full border border-amber-400/35 bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-100">
          <ArrowDown className="h-3 w-3" /> BELOW
        </span>
        <span className="flex items-center gap-1 rounded-full border border-amber-300/35 bg-black/30 px-1.5 py-0.5 text-[10px] font-bold text-amber-100">
          <Zap className="h-2.5 w-2.5" /> SCALPER
        </span>
        <span className="rounded border border-amber-300/20 bg-black/25 px-1.5 py-0.5 text-[10px] font-bold text-amber-200/75">PAPER</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-amber-100/70">
          <Clock className="h-3 w-3" /> Aug 21, 2:28 AM
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Metric icon={ShoppingCart} label="Order" value="KXNEAR15M-26AUG21" wide />
        <Metric icon={CheckCircle2} label="Settlement" value="Won" />
        <Metric icon={Zap} label="Entry" value="2¢ YES · 98¢ NO" wide />
        <Metric icon={Trophy} label="Result" value="YES won" />
        <Metric icon={BarChart3} label="Size" value="3 @ 98¢" />
        <div className="rounded-lg border border-amber-300/40 bg-gradient-to-br from-amber-600/15 via-amber-400/30 to-yellow-300/65 p-2.5 shadow-[0_0_18px_rgba(245,158,11,0.18)]">
          <div className="mb-0.5 flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-amber-100">
            <BarChart3 className="h-3.5 w-3.5 text-amber-300" /> P&L
          </div>
          <div className="font-mono text-sm font-bold text-emerald-300">+$0.06</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-amber-100/70">
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
          <Layers className="h-4 w-4 text-amber-300" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-100">Scalper sets</span>
          <span className="text-xs text-amber-200/55">every 3M scalp, all day.</span>
        </div>
        <ActiveScalperCard />
        <HistoryScalperCard />
      </div>
    </main>
  );
}