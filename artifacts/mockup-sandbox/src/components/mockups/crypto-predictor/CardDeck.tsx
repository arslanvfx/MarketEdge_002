export function CardDeck() {
  const coins = [
    { sym: "BTC", name: "Bitcoin", price: 59905.62, chg: -0.38, pred: "BELOW", conf: 63, regime: "Spike", emoji: "₿", color: "#f59e0b", training: true },
    { sym: "ETH", name: "Ethereum", price: 1567.46, chg: -0.52, pred: "BELOW", conf: 52, regime: "Choppy", emoji: "Ξ", color: "#6366f1", training: true },
    { sym: "SOL", name: "Solana", price: 70.43, chg: -1.81, pred: "BELOW", conf: 77, regime: "Choppy", emoji: "◎", color: "#22d3ee", auto: true },
    { sym: "XRP", name: "XRP", price: 1.0465, chg: -0.79, pred: "ABOVE", conf: 63, regime: "Spike", emoji: "✕", color: "#38bdf8", training: true },
    { sym: "HYPE", name: "Hyperliquid", price: 61.88, chg: -2.74, pred: "BELOW", conf: 58, regime: "Spike", emoji: "H", color: "#a78bfa", training: true },
    { sym: "BNB", name: "BNB", price: 555.24, chg: -1.56, pred: "BELOW", conf: 68, regime: "Spike", emoji: "B", color: "#fbbf24", training: true },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-[#0f172a]" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-black text-sm">M</span>
          </div>
          <div>
            <span className="font-bold text-slate-800 text-base">MarketEdge</span>
            <span className="text-slate-400 text-xs ml-2">Crypto Predictor</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live · 02:15 EDT
          </div>
          <div className="flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-full">
            Auto-Pilot ON
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* Coin grid */}
        <div className="grid grid-cols-6 gap-3">
          {coins.map((c, i) => (
            <div
              key={c.sym}
              className="bg-white rounded-xl border shadow-sm p-3 cursor-pointer transition-all hover:shadow-md"
              style={{ borderColor: i === 0 ? c.color : "#e2e8f0", boxShadow: i === 0 ? `0 0 0 2px ${c.color}40` : undefined }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-lg font-bold" style={{ color: c.color }}>{c.emoji}</span>
                <div className="flex flex-col items-end gap-0.5">
                  {c.training && <span className="text-[8px] font-bold text-violet-500 bg-violet-50 px-1 rounded">Train</span>}
                  {c.auto && <span className="text-[8px] font-bold text-emerald-500 bg-emerald-50 px-1 rounded">Auto</span>}
                </div>
              </div>
              <div className="text-slate-800 font-bold text-xs">{c.sym}</div>
              <div className="text-slate-500 text-[10px] tabular-nums mt-0.5">${c.price < 10 ? c.price.toFixed(4) : c.price >= 1000 ? (c.price / 1000).toFixed(1) + "K" : c.price}</div>
              <div className={`text-[9px] font-bold mt-1.5 ${c.chg >= 0 ? "text-emerald-600" : "text-red-500"}`}>{c.chg >= 0 ? "+" : ""}{c.chg}%</div>
              <div className={`text-[9px] font-bold mt-0.5 ${c.pred === "ABOVE" ? "text-emerald-600" : "text-red-500"}`}>{c.pred} {c.conf}%</div>
            </div>
          ))}
        </div>

        {/* Main card — BTC detail */}
        <div className="grid grid-cols-3 gap-4">
          {/* Prediction card */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-slate-400 text-xs uppercase tracking-widest mb-0.5">Bitcoin</div>
                <div className="text-slate-800 text-2xl font-black tabular-nums">$59,905</div>
              </div>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl" style={{ background: "#fef3c7" }}>₿</div>
            </div>
            <div className="space-y-3">
              {/* Kalshi */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                <div className="text-amber-600 text-[10px] font-bold uppercase tracking-widest mb-1">Kalshi Strike</div>
                <div className="text-amber-700 text-xl font-black">$59,820</div>
                <div className="text-amber-500 text-xs mt-0.5">Closes 02:30 EDT</div>
              </div>
              {/* Verdict */}
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <div className="text-red-400 text-[10px] font-bold uppercase tracking-widest mb-1">Consensus</div>
                <div className="text-red-600 text-xl font-black flex items-center gap-1.5">
                  <span className="text-base">↓</span> BELOW
                </div>
                <div className="text-red-400 text-xs mt-1 font-bold">→ Bet NO on Kalshi</div>
              </div>
            </div>
          </div>

          {/* Model cards */}
          <div className="col-span-2 grid grid-cols-2 gap-3">
            {[
              { name: "Statistical Model", dir: "↓ BELOW", conf: 63, sub: "$59,720 predicted", color: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
              { name: "Claude AI", dir: "↓ BELOW", conf: 63, sub: "$59,720 predicted", color: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
              { name: "Auto-Pilot", dir: "↓ BELOW", conf: 63, sub: "Using Stat · 63% acc.", color: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
              { name: "ML Model", dir: "↓ BELOW", conf: 61, sub: "XGBoost classifier", color: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
            ].map(m => (
              <div key={m.name} className="rounded-xl border p-4 shadow-sm" style={{ background: m.bg, borderColor: m.border }}>
                <div className="text-slate-500 text-[10px] uppercase tracking-widest font-bold mb-2">{m.name}</div>
                <div className="font-black text-lg mb-0.5" style={{ color: m.color }}>{m.dir}</div>
                <div className="text-slate-500 text-xs">{m.sub}</div>
                <div className="mt-2 pt-2 border-t border-slate-200">
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${m.conf}%`, background: m.color }} />
                    </div>
                    <span className="text-[10px] font-bold" style={{ color: m.color }}>{m.conf}%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Price Action strip */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-center gap-6">
          <div>
            <div className="text-slate-400 text-[10px] uppercase tracking-widest mb-1">Price Action</div>
            <div className="text-orange-500 font-black text-sm">⚠ Spike Detected</div>
          </div>
          <div className="w-px h-8 bg-slate-200" />
          <div>
            <div className="text-slate-400 text-[10px] uppercase tracking-widest mb-1">Efficiency Ratio</div>
            <div className="text-slate-700 font-bold text-sm">0.17×</div>
          </div>
          <div className="w-px h-8 bg-slate-200" />
          <div>
            <div className="text-slate-400 text-[10px] uppercase tracking-widest mb-1">Reversals</div>
            <div className="text-slate-700 font-bold text-sm">3 detected</div>
          </div>
          <div className="ml-auto bg-red-600 text-white rounded-xl px-4 py-2 text-sm font-bold">
            Bet NO on Kalshi →
          </div>
        </div>
      </div>
    </div>
  );
}
