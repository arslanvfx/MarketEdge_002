export function Bloomberg() {
  const coins = [
    { sym: "BTC", price: 59905.62, chg: -0.38, prd: 59720 },
    { sym: "ETH", price: 1567.46, chg: -0.52, prd: 1551 },
    { sym: "SOL", price: 70.43, chg: -1.81, prd: 69.1 },
    { sym: "XRP", price: 1.0465, chg: -0.79, prd: 1.059 },
    { sym: "HYPE", price: 61.88, chg: -2.74, prd: 60.5 },
    { sym: "BNB", price: 555.24, chg: -1.56, prd: 548 },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e8e0cc] overflow-hidden" style={{ fontFamily: "Arial, sans-serif" }}>
      {/* Bloomberg-style top bar */}
      <div className="bg-[#ff6600] px-3 py-1 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-black font-black text-sm tracking-tight">MARKETEDGE</span>
          <span className="text-black/70 text-xs">|</span>
          <span className="text-black text-xs font-medium">CRYPTO PREDICTION TERMINAL</span>
        </div>
        <div className="flex items-center gap-3 text-black text-xs font-medium">
          <span>EDT 02:15:33</span>
          <span className="bg-black text-orange-400 px-1.5 py-0.5 text-[10px] font-bold">LIVE FEED</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-[#1a1a1a] border-b border-[#333] flex items-center gap-0 text-xs">
        {["PREDICTOR", "MARKETS", "SMART PICKS", "PORTFOLIO", "COMBO BUILDER"].map((tab, i) => (
          <button key={tab} className={`px-4 py-2 border-r border-[#333] ${i === 0 ? "bg-[#0a0a0a] text-[#ff6600] font-bold" : "text-[#888] hover:text-[#e8e0cc]"}`}>{tab}</button>
        ))}
      </div>

      <div className="flex h-[calc(100vh-66px)]">
        {/* Left ticker column */}
        <div className="w-52 border-r border-[#222] flex flex-col bg-[#0d0d0d]">
          <div className="px-2 py-1.5 border-b border-[#222] text-[10px] text-[#ff6600] font-bold tracking-widest uppercase">Watchlist</div>
          {coins.map((c, i) => (
            <div key={c.sym} className={`px-2 py-2 border-b border-[#1a1a1a] cursor-pointer ${i === 0 ? "bg-[#1a1600] border-l-2 border-l-[#ff6600]" : ""}`}>
              <div className="flex justify-between items-baseline mb-0.5">
                <span className={`text-xs font-bold ${i === 0 ? "text-[#ff6600]" : "text-[#e8e0cc]"}`}>{c.sym}</span>
                <span className={`text-[10px] font-bold ${c.chg >= 0 ? "text-[#00d084]" : "text-[#ff4444]"}`}>{c.chg >= 0 ? "+" : ""}{c.chg}%</span>
              </div>
              <div className="text-[11px] text-[#aaa] tabular-nums">${c.price < 10 ? c.price.toFixed(4) : c.price.toLocaleString()}</div>
              <div className="mt-1 h-0.5 bg-[#1a1a1a] rounded overflow-hidden">
                <div className={`h-full ${c.chg >= 0 ? "bg-[#00d084]" : "bg-[#ff4444]"}`} style={{ width: `${50 + c.chg * 5}%` }} />
              </div>
            </div>
          ))}
          {/* Auto-pilot status */}
          <div className="mt-auto border-t border-[#222] p-2">
            <div className="text-[9px] text-[#555] uppercase tracking-widest mb-1.5">Auto-Pilot</div>
            <div className="space-y-1">
              {[{ sym: "SOL", on: true }, { sym: "LINK", on: true }, { sym: "DOGE", on: true }].map(a => (
                <div key={a.sym} className="flex justify-between text-[10px]">
                  <span className="text-[#aaa]">{a.sym}</span>
                  <span className="text-[#00d084] font-bold">CLAUDE ON</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col">
          {/* BTC header row */}
          <div className="border-b border-[#222] px-4 py-2 flex items-center gap-6 bg-[#0d0d0d]">
            <div>
              <span className="text-[#ff6600] font-black text-lg">BTC</span>
              <span className="text-[#555] text-xs ml-1.5">Bitcoin / USD</span>
            </div>
            <div className="text-[#e8e0cc] text-2xl font-bold tabular-nums">59,905.62</div>
            <div className="text-[#ff4444] text-sm font-bold">▼ -0.38%</div>
            <div className="ml-auto flex items-center gap-3">
              <div className="text-center">
                <div className="text-[9px] text-[#555] uppercase">Kalshi Strike</div>
                <div className="text-[#ff6600] font-bold text-sm tabular-nums">$59,820</div>
              </div>
              <div className="w-px h-8 bg-[#222]" />
              <div className="text-center">
                <div className="text-[9px] text-[#555] uppercase">Consensus</div>
                <div className="text-[#ff4444] font-black text-sm">↓ BELOW</div>
              </div>
              <div className="w-px h-8 bg-[#222]" />
              <div className="text-center">
                <div className="text-[9px] text-[#555] uppercase">Closes</div>
                <div className="text-[#e8e0cc] font-medium text-sm">02:30 EDT</div>
              </div>
            </div>
          </div>

          {/* Chart + panels */}
          <div className="flex flex-1 overflow-hidden">
            {/* Chart */}
            <div className="flex-1 relative bg-[#080808] border-r border-[#222]">
              <svg className="w-full h-full" viewBox="0 0 600 300" preserveAspectRatio="none">
                {/* Grid */}
                {[0,1,2,3,4,5].map(i => <line key={i} x1="0" y1={i * 50} x2="600" y2={i * 50} stroke="#1a1a1a" strokeWidth="1" />)}
                {[0,1,2,3,4,5,6].map(i => <line key={i} x1={i * 100} y1="0" x2={i * 100} y2="300" stroke="#1a1a1a" strokeWidth="1" />)}
                {/* Kalshi line */}
                <line x1="0" y1="155" x2="600" y2="155" stroke="#ff6600" strokeWidth="1" strokeDasharray="5,3" opacity="0.5" />
                <text x="540" y="150" fill="#ff6600" fontSize="9" opacity="0.7">STRIKE</text>
                {/* Price */}
                <defs>
                  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff6600" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#ff6600" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,160 L60,150 L120,170 L180,130 L240,145 L300,120 L360,135 L420,110 L480,125 L540,115 L600,120" stroke="#e8e0cc" strokeWidth="1.5" fill="none" />
                <path d="M0,160 L60,150 L120,170 L180,130 L240,145 L300,120 L360,135 L420,110 L480,125 L540,115 L600,120 L600,300 L0,300Z" fill="url(#bg)" />
                {/* Forecast */}
                <path d="M600,120 L650,130 L700,125" stroke="#ff6600" strokeWidth="1.5" strokeDasharray="4,3" fill="none" />
                {/* Price labels */}
                <text x="5" y="20" fill="#555" fontSize="9">60,300</text>
                <text x="5" y="170" fill="#555" fontSize="9">59,820</text>
                <text x="5" y="290" fill="#555" fontSize="9">59,400</text>
              </svg>
            </div>

            {/* Right panels */}
            <div className="w-48 flex flex-col divide-y divide-[#222] text-xs">
              {[
                { label: "STAT MODEL", val: "↓ BELOW", conf: "63%", sub: "$59,720", col: "#ff4444" },
                { label: "CLAUDE AI", val: "↓ BELOW", conf: "63%", sub: "$59,720", col: "#ff4444" },
                { label: "AUTO-PILOT", val: "↓ BELOW", conf: "Stat 63%", sub: "stat leading", col: "#ff4444" },
                { label: "ML MODEL", val: "↓ BELOW", conf: "61%", sub: "XGBoost", col: "#ff4444" },
              ].map(p => (
                <div key={p.label} className="p-3 flex-1">
                  <div className="text-[9px] text-[#555] uppercase tracking-widest mb-1.5">{p.label}</div>
                  <div className="font-black text-sm" style={{ color: p.col }}>{p.val}</div>
                  <div className="text-[#888] text-[10px] mt-0.5">{p.sub} · {p.conf}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom strip */}
          <div className="border-t border-[#222] bg-[#0d0d0d] px-4 py-2 flex items-center gap-6">
            <div className="text-[10px] text-[#555] uppercase tracking-widest">Price Action:</div>
            <span className="text-orange-400 font-bold text-xs">⚠ SPIKE</span>
            <span className="text-[#555] text-[10px]">ER 0.17× · 3 reversals · ▼ -0.049%</span>
            <div className="ml-auto text-[10px] text-[#555]">
              <span className="text-[#ff6600] font-bold mr-2">→ BET NO ON KALSHI</span>
              <span>Combined conf. 63%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
