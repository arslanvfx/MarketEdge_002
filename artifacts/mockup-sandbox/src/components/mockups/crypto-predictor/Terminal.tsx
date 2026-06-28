export function Terminal() {
  const coins = [
    { sym: "BTC", price: 59905.62, chg: -0.38, dir: "↓", pred: 59720, conf: 63, regime: "Spike" },
    { sym: "ETH", price: 1567.46, chg: -0.52, dir: "↓", pred: 1551, conf: 52, regime: "Choppy" },
    { sym: "SOL", price: 70.43, chg: -1.81, dir: "↓", pred: 69.1, conf: 77, regime: "Choppy" },
    { sym: "XRP", price: 1.0465, chg: -0.79, dir: "↑", pred: 1.059, conf: 63, regime: "Spike" },
    { sym: "HYPE", price: 61.88, chg: -2.74, dir: "↓", pred: 60.5, conf: 58, regime: "Spike" },
    { sym: "BNB", price: 555.24, chg: -1.56, dir: "↓", pred: 548, conf: 68, regime: "Spike" },
  ];

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono p-0 overflow-hidden" style={{ fontFamily: "'Courier New', monospace" }}>
      {/* Top bar */}
      <div className="border-b border-green-900 px-4 py-2 flex items-center justify-between bg-black">
        <div className="flex items-center gap-3">
          <span className="text-green-500 text-xs tracking-widest">MARKETEDGE_PREDICTOR_v2.4.1</span>
          <span className="animate-pulse text-green-600 text-xs">█</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-green-600">
          <span>SYS: ONLINE</span>
          <span className="text-green-400">02:15:33 EDT</span>
          <span className="bg-green-900 text-green-300 px-1.5 py-0.5 rounded text-[10px]">LIVE</span>
        </div>
      </div>

      <div className="grid grid-cols-12 h-[calc(100vh-40px)]">
        {/* Left panel — coin list */}
        <div className="col-span-3 border-r border-green-900 flex flex-col">
          <div className="px-3 py-2 border-b border-green-900 text-[10px] text-green-700 tracking-widest">
            ▸ ASSET_FEED [8 ACTIVE]
          </div>
          <div className="flex-1 overflow-hidden">
            {coins.map((c, i) => (
              <div key={c.sym} className={`px-3 py-2.5 border-b border-green-950 flex items-center justify-between cursor-pointer transition-colors ${i === 0 ? "bg-green-950" : "hover:bg-green-950/30"}`}>
                <div>
                  <div className="text-green-300 text-xs font-bold">{c.sym}</div>
                  <div className={`text-[10px] ${c.chg >= 0 ? "text-green-500" : "text-red-500"}`}>{c.chg >= 0 ? "+" : ""}{c.chg}%</div>
                </div>
                <div className="text-right">
                  <div className="text-green-400 text-xs tabular-nums">${c.price < 10 ? c.price.toFixed(4) : c.price.toLocaleString()}</div>
                  <div className={`text-[10px] ${c.dir === "↑" ? "text-green-500" : "text-red-500"}`}>{c.dir} {c.conf}%</div>
                </div>
              </div>
            ))}
          </div>
          {/* Accuracy stats */}
          <div className="border-t border-green-900 px-3 py-3">
            <div className="text-[10px] text-green-700 mb-2 tracking-widest">MODEL ACCURACY</div>
            {[{ label: "STAT_MDL", acc: 63, bar: 63 }, { label: "CLAUDE_AI", acc: 77, bar: 77 }, { label: "ENSEMBLE", acc: 69, bar: 69 }].map(m => (
              <div key={m.label} className="mb-1.5">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-green-700">{m.label}</span>
                  <span className="text-green-400">{m.acc}%</span>
                </div>
                <div className="h-1 bg-green-950 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${m.bar}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main panel */}
        <div className="col-span-9 flex flex-col">
          {/* BTC header */}
          <div className="border-b border-green-900 px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-green-200 text-lg font-bold">BITCOIN</span>
                <span className="text-green-700 text-xs ml-2">BTC-USD</span>
              </div>
              <div className="text-2xl font-bold text-green-300 tabular-nums">$59,905.62</div>
              <span className="text-red-500 text-sm">▼ -0.38%</span>
            </div>
            <div className="flex gap-2">
              {["STAT", "AI", "COMBO"].map(m => (
                <button key={m} className={`text-[10px] px-2 py-1 border ${m === "COMBO" ? "border-green-500 text-green-400 bg-green-950" : "border-green-900 text-green-700 hover:border-green-700"}`}>{m}</button>
              ))}
            </div>
          </div>

          {/* Chart area (simulated) */}
          <div className="flex-1 relative p-4">
            <div className="absolute inset-4 rounded border border-green-900/50">
              {/* Grid lines */}
              {[...Array(6)].map((_, i) => (
                <div key={i} className="absolute w-full border-t border-green-950" style={{ top: `${(i / 5) * 100}%` }} />
              ))}
              {[...Array(8)].map((_, i) => (
                <div key={i} className="absolute h-full border-l border-green-950" style={{ left: `${(i / 7) * 100}%` }} />
              ))}
              {/* Price line (SVG) */}
              <svg className="w-full h-full absolute inset-0" viewBox="0 0 400 200" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,120 L50,110 L100,130 L150,90 L200,105 L250,80 L300,95 L350,70 L400,85" stroke="#22c55e" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
                <path d="M0,120 L50,110 L100,130 L150,90 L200,105 L250,80 L300,95 L350,70 L400,85 L400,200 L0,200Z" fill="url(#tg)" />
                {/* Forecast */}
                <path d="M400,85 L440,95 L480,88 L520,100" stroke="#22c55e" strokeWidth="1.5" fill="none" strokeDasharray="4,3" vectorEffect="non-scaling-stroke" />
              </svg>
              {/* Kalshi target line */}
              <div className="absolute w-full border-t border-dashed border-amber-500/60" style={{ top: "52%" }}>
                <span className="absolute right-2 -top-3.5 text-[10px] text-amber-500">STRIKE $59,820</span>
              </div>
              {/* Labels */}
              <div className="absolute left-2 top-1 text-[9px] text-green-700">60,300</div>
              <div className="absolute left-2 bottom-1 text-[9px] text-green-700">59,500</div>
            </div>

            {/* Right side info */}
            <div className="absolute right-6 top-6 w-52 space-y-2">
              <div className="border border-green-900 bg-black/80 p-2.5 rounded">
                <div className="text-[9px] text-green-700 tracking-widest mb-1.5">KALSHI 15-MIN TARGET</div>
                <div className="text-amber-400 text-lg font-bold tabular-nums">$59,820.00</div>
                <div className="text-[10px] text-green-700 mt-0.5">WINDOW CLOSES 02:30 EDT</div>
              </div>
              <div className="border border-green-900 bg-black/80 p-2.5 rounded">
                <div className="text-[9px] text-green-700 tracking-widest mb-1">MODEL CONSENSUS</div>
                <div className="flex items-center gap-1.5 mb-1">
                  <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-red-400 font-bold text-sm">↓ BELOW</span>
                </div>
                <div className="text-[10px] text-green-600">$59,720 · 63% conf</div>
                <div className="mt-2 pt-2 border-t border-green-900">
                  <div className="text-[9px] text-red-500 font-bold">→ BET NO ON KALSHI</div>
                </div>
              </div>
              <div className="border border-green-900 bg-black/80 p-2.5 rounded">
                <div className="text-[9px] text-green-700 tracking-widest mb-1.5">PRICE ACTION</div>
                <div className="text-orange-400 font-bold text-sm">⚠ SPIKE</div>
                <div className="text-[10px] text-green-700 mt-0.5">ER: 0.17× · 3 reversals</div>
              </div>
            </div>
          </div>

          {/* Bottom bar — model breakdown */}
          <div className="border-t border-green-900 grid grid-cols-4 divide-x divide-green-900">
            {[
              { label: "STAT MODEL", val: "↓ BELOW", sub: "-0.308%", col: "text-red-400" },
              { label: "CLAUDE AI", val: "↓ BELOW", sub: "-0.309%", col: "text-red-400" },
              { label: "AUTO-PILOT", val: "↓ BELOW", sub: "Claude · 63%", col: "text-red-400" },
              { label: "ML MODEL", val: "↓ BELOW", sub: "XGBoost · 61%", col: "text-red-400" },
            ].map(m => (
              <div key={m.label} className="px-4 py-2.5 text-center">
                <div className="text-[9px] text-green-700 tracking-widest mb-1">{m.label}</div>
                <div className={`text-sm font-bold ${m.col}`}>{m.val}</div>
                <div className="text-[10px] text-green-700 mt-0.5">{m.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
