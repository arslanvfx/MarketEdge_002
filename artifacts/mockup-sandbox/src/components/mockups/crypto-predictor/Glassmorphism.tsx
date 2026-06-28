export function Glassmorphism() {
  const coins = [
    { sym: "BTC", price: 59905.62, chg: -0.38, pred: "BELOW", conf: 63, emoji: "₿" },
    { sym: "ETH", price: 1567.46, chg: -0.52, pred: "BELOW", conf: 52, emoji: "Ξ" },
    { sym: "SOL", price: 70.43, chg: -1.81, pred: "BELOW", conf: 77, emoji: "◎" },
    { sym: "XRP", price: 1.0465, chg: -0.79, pred: "ABOVE", conf: 63, emoji: "✕" },
    { sym: "HYPE", price: 61.88, chg: -2.74, pred: "BELOW", conf: 58, emoji: "H" },
    { sym: "BNB", price: 555.24, chg: -1.56, pred: "BELOW", conf: 68, emoji: "B" },
  ];

  return (
    <div
      className="min-h-screen overflow-hidden relative"
      style={{
        background: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Background orbs */}
      <div className="absolute w-80 h-80 rounded-full blur-3xl opacity-20" style={{ background: "radial-gradient(circle, #7c3aed, transparent)", top: -80, left: -80 }} />
      <div className="absolute w-96 h-96 rounded-full blur-3xl opacity-15" style={{ background: "radial-gradient(circle, #2563eb, transparent)", bottom: -100, right: -80 }} />
      <div className="absolute w-64 h-64 rounded-full blur-3xl opacity-20" style={{ background: "radial-gradient(circle, #059669, transparent)", top: "40%", left: "45%" }} />

      <div className="relative z-10 p-5 h-screen flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.15)", backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.2)" }}>
              <span className="text-white text-sm font-black">M</span>
            </div>
            <div>
              <h1 className="text-white font-bold text-lg leading-none">MarketEdge</h1>
              <p className="text-white/50 text-xs">Crypto Predictor · Live</p>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs" style={{ background: "rgba(255,255,255,0.1)", backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.15)" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-white/80">02:15 EDT</span>
          </div>
        </div>

        {/* Coin grid */}
        <div className="grid grid-cols-6 gap-2">
          {coins.map((c, i) => (
            <div
              key={c.sym}
              className="rounded-xl p-3 cursor-pointer transition-all"
              style={{
                background: i === 0 ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.07)",
                backdropFilter: "blur(12px)",
                border: i === 0 ? "1px solid rgba(139,92,246,0.5)" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: i === 0 ? "0 0 20px rgba(139,92,246,0.2)" : "none",
              }}
            >
              <div className="flex justify-between items-start mb-2">
                <span className="text-purple-300 text-sm font-bold">{c.emoji}</span>
                <span className={`text-[10px] font-bold ${c.chg >= 0 ? "text-emerald-400" : "text-red-400"}`}>{c.chg}%</span>
              </div>
              <div className="text-white font-bold text-xs mb-0.5">{c.sym}</div>
              <div className="text-white/60 text-[10px] tabular-nums">${c.price < 10 ? c.price.toFixed(4) : c.price >= 1000 ? (c.price / 1000).toFixed(1) + "K" : c.price}</div>
              <div className={`mt-1.5 text-[9px] font-bold ${c.pred === "ABOVE" ? "text-emerald-400" : "text-red-400"}`}>
                {c.pred} · {c.conf}%
              </div>
            </div>
          ))}
        </div>

        {/* Main glass card */}
        <div
          className="flex-1 rounded-2xl p-5 flex gap-5"
          style={{ background: "rgba(255,255,255,0.06)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          {/* Left info */}
          <div className="w-52 flex flex-col gap-3">
            <div>
              <p className="text-white/40 text-[10px] uppercase tracking-widest mb-1">Selected Coin</p>
              <div className="flex items-baseline gap-2">
                <span className="text-purple-300 text-2xl font-black">₿</span>
                <span className="text-white text-xl font-bold">Bitcoin</span>
              </div>
              <div className="text-3xl font-black text-white tabular-nums mt-1">$59,905</div>
              <div className="text-red-400 text-sm font-medium mt-0.5">▼ -0.38% 24h</div>
            </div>

            {/* Kalshi card */}
            <div className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,165,0,0.3)" }}>
              <p className="text-amber-400/60 text-[10px] uppercase tracking-widest mb-1.5">Kalshi 15-min</p>
              <div className="text-amber-300 text-lg font-black tabular-nums">$59,820</div>
              <div className="text-white/40 text-[10px] mt-0.5">Strike price · closes 02:30</div>
              <div className="mt-2 pt-2 border-t border-white/10">
                <span className="text-red-400 font-black text-xs">↓ BELOW · Bet NO</span>
              </div>
            </div>

            {/* Regime */}
            <div className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,100,0,0.3)" }}>
              <p className="text-white/40 text-[10px] uppercase tracking-widest mb-1.5">Price Action</p>
              <div className="text-orange-400 font-bold text-sm">⚠ Spike</div>
              <div className="text-white/40 text-[10px] mt-0.5">ER 0.17× · 3 reversals</div>
            </div>
          </div>

          {/* Chart */}
          <div className="flex-1 relative">
            <svg className="w-full h-full" viewBox="0 0 500 280" preserveAspectRatio="none">
              <defs>
                <linearGradient id="gg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* Grid */}
              {[0,1,2,3,4].map(i => <line key={i} x1="0" y1={56 * i} x2="500" y2={56 * i} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />)}
              {/* Kalshi */}
              <line x1="0" y1="145" x2="500" y2="145" stroke="rgba(251,191,36,0.4)" strokeWidth="1" strokeDasharray="6,4" />
              <text x="430" y="141" fill="rgba(251,191,36,0.7)" fontSize="9">$59,820</text>
              {/* Price */}
              <path d="M0,160 L70,145 L140,170 L210,120 L280,140 L350,105 L420,120 L500,115" stroke="#8b5cf6" strokeWidth="2" fill="none" />
              <path d="M0,160 L70,145 L140,170 L210,120 L280,140 L350,105 L420,120 L500,115 L500,280 L0,280Z" fill="url(#gg)" />
              {/* Forecast dashed */}
              <path d="M500,115 L560,125 L620,120" stroke="rgba(139,92,246,0.5)" strokeWidth="1.5" strokeDasharray="5,4" fill="none" />
            </svg>
          </div>

          {/* Model cards */}
          <div className="w-40 flex flex-col gap-2">
            {[
              { name: "Stat Model", dir: "BELOW", conf: "63%", col: "text-red-400", accent: "rgba(239,68,68,0.15)" },
              { name: "Claude AI", dir: "BELOW", conf: "63%", col: "text-red-400", accent: "rgba(139,92,246,0.15)" },
              { name: "Auto-Pilot", dir: "BELOW", conf: "Stat", col: "text-red-400", accent: "rgba(16,185,129,0.15)" },
              { name: "ML Model", dir: "BELOW", conf: "61%", col: "text-red-400", accent: "rgba(59,130,246,0.15)" },
            ].map(m => (
              <div key={m.name} className="flex-1 rounded-xl p-3 flex flex-col justify-between" style={{ background: m.accent, border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="text-white/40 text-[9px] uppercase tracking-widest">{m.name}</div>
                <div>
                  <div className={`font-black text-sm ${m.col}`}>↓ {m.dir}</div>
                  <div className="text-white/40 text-[10px]">{m.conf}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
