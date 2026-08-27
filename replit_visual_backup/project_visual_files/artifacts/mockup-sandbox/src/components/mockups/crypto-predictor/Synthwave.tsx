export function Synthwave() {
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
        background: "linear-gradient(180deg, #0d001a 0%, #1a0030 40%, #0d0028 100%)",
        fontFamily: "'Courier New', monospace",
      }}
    >
      {/* Scanlines overlay */}
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,0,255,0.02) 2px, rgba(255,0,255,0.02) 4px)" }} />

      {/* Grid floor effect */}
      <div
        className="absolute bottom-0 left-0 right-0 h-48 pointer-events-none"
        style={{
          backgroundImage: "linear-gradient(rgba(255,0,255,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(255,0,255,0.15) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          transform: "perspective(300px) rotateX(60deg)",
          transformOrigin: "bottom center",
          opacity: 0.4,
        }}
      />

      {/* Glow effects */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-32 blur-3xl opacity-20 pointer-events-none" style={{ background: "radial-gradient(ellipse, #ff00ff, transparent)" }} />

      <div className="relative z-10 p-5 flex flex-col h-screen gap-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "rgba(255,0,255,0.3)" }}>
          <div>
            <h1 className="text-2xl font-black tracking-widest" style={{ color: "#ff00ff", textShadow: "0 0 20px #ff00ff, 0 0 40px #ff00ff" }}>
              MARKET<span style={{ color: "#00ffff", textShadow: "0 0 20px #00ffff" }}>EDGE</span>
            </h1>
            <p className="text-[10px] tracking-[0.3em] mt-0.5" style={{ color: "rgba(255,0,255,0.5)" }}>CRYPTO PREDICTION SYSTEM v2.4</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs tabular-nums" style={{ color: "#00ffff", textShadow: "0 0 10px #00ffff" }}>02:15:33 EDT</div>
            <div className="px-3 py-1 text-[10px] font-bold tracking-widest" style={{ border: "1px solid #ff00ff", color: "#ff00ff", boxShadow: "0 0 10px rgba(255,0,255,0.3)" }}>⬤ LIVE</div>
          </div>
        </div>

        {/* Coin strip */}
        <div className="grid grid-cols-6 gap-2">
          {coins.map((c, i) => (
            <div
              key={c.sym}
              className="p-2.5 cursor-pointer transition-all"
              style={{
                border: `1px solid ${i === 0 ? "#ff00ff" : "rgba(255,0,255,0.2)"}`,
                background: i === 0 ? "rgba(255,0,255,0.1)" : "rgba(255,0,255,0.03)",
                boxShadow: i === 0 ? "0 0 15px rgba(255,0,255,0.3), inset 0 0 15px rgba(255,0,255,0.05)" : "none",
              }}
            >
              <div className="flex justify-between items-start mb-1.5">
                <span className="font-black text-sm" style={{ color: "#ff00ff" }}>{c.emoji}</span>
                <span className={`text-[9px] font-bold ${c.chg >= 0 ? "" : ""}`} style={{ color: c.chg >= 0 ? "#00ffff" : "#ff4444" }}>{c.chg}%</span>
              </div>
              <div className="text-[11px] font-bold" style={{ color: "rgba(255,255,255,0.8)" }}>{c.sym}</div>
              <div className="text-[10px] tabular-nums mt-0.5" style={{ color: "rgba(255,0,255,0.6)" }}>${c.price < 10 ? c.price.toFixed(4) : c.price >= 1000 ? (c.price / 1000).toFixed(1) + "K" : c.price}</div>
              <div className="mt-1.5 text-[9px] font-bold" style={{ color: c.pred === "ABOVE" ? "#00ffff" : "#ff4444" }}>{c.pred} {c.conf}%</div>
            </div>
          ))}
        </div>

        {/* Main display */}
        <div className="flex-1 flex gap-4">
          {/* Left — big price */}
          <div className="w-56 flex flex-col gap-3">
            <div className="p-4" style={{ border: "1px solid rgba(255,0,255,0.3)", background: "rgba(255,0,255,0.05)" }}>
              <div className="text-[10px] tracking-[0.2em] mb-2" style={{ color: "rgba(255,0,255,0.5)" }}>SELECTED ASSET</div>
              <div className="text-5xl font-black" style={{ color: "#ff00ff", textShadow: "0 0 30px #ff00ff" }}>₿</div>
              <div className="text-white font-bold text-lg mt-1">Bitcoin</div>
              <div className="text-3xl font-black tabular-nums mt-1" style={{ color: "#00ffff", textShadow: "0 0 15px #00ffff" }}>59,905</div>
              <div className="text-[#ff4444] text-sm font-bold mt-0.5">▼ -0.38%</div>
            </div>
            <div className="p-3" style={{ border: "1px solid rgba(255,165,0,0.4)", background: "rgba(255,165,0,0.05)" }}>
              <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: "rgba(255,165,0,0.5)" }}>KALSHI STRIKE</div>
              <div className="text-xl font-black tabular-nums" style={{ color: "#ffa500", textShadow: "0 0 15px rgba(255,165,0,0.5)" }}>$59,820</div>
              <div className="text-[10px] mt-0.5" style={{ color: "rgba(255,165,0,0.5)" }}>CLOSES 02:30 EDT</div>
              <div className="mt-2 pt-2" style={{ borderTop: "1px solid rgba(255,165,0,0.2)" }}>
                <span className="text-[#ff4444] font-black text-xs" style={{ textShadow: "0 0 10px rgba(255,68,68,0.5)" }}>↓ BELOW · BET NO</span>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="flex-1" style={{ border: "1px solid rgba(255,0,255,0.2)", background: "rgba(0,0,0,0.3)", position: "relative" }}>
            <div className="absolute top-2 left-3 text-[9px] tracking-widest" style={{ color: "rgba(255,0,255,0.4)" }}>BTC-USD · 15MIN · LIVE FEED</div>
            <svg className="w-full h-full" viewBox="0 0 500 260" preserveAspectRatio="none">
              <defs>
                <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ff00ff" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#ff00ff" stopOpacity="0" />
                </linearGradient>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                  <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              {/* Grid */}
              {[0,1,2,3,4].map(i => <line key={i} x1="0" y1={52 * i} x2="500" y2={52 * i} stroke="rgba(255,0,255,0.08)" strokeWidth="1" />)}
              {/* Kalshi */}
              <line x1="0" y1="135" x2="500" y2="135" stroke="rgba(255,165,0,0.5)" strokeWidth="1" strokeDasharray="6,4" />
              {/* Price path */}
              <path d="M0,155 L70,140 L140,165 L210,115 L280,135 L350,100 L420,118 L500,110" stroke="#ff00ff" strokeWidth="2" fill="none" filter="url(#glow)" />
              <path d="M0,155 L70,140 L140,165 L210,115 L280,135 L350,100 L420,118 L500,110 L500,260 L0,260Z" fill="url(#sg)" />
              {/* Forecast */}
              <path d="M500,110 L560,120 L620,115" stroke="rgba(0,255,255,0.6)" strokeWidth="1.5" strokeDasharray="5,4" fill="none" filter="url(#glow)" />
            </svg>
          </div>

          {/* Right — model grid */}
          <div className="w-44 flex flex-col gap-2">
            {[
              { name: "STAT MDL", dir: "BELOW", col: "#ff4444", glow: "rgba(255,68,68,0.3)" },
              { name: "CLAUDE AI", dir: "BELOW", col: "#ff4444", glow: "rgba(255,68,68,0.3)" },
              { name: "AUTO-PILOT", dir: "BELOW", col: "#ff4444", glow: "rgba(255,68,68,0.3)" },
              { name: "ML MODEL", dir: "BELOW", col: "#ff4444", glow: "rgba(255,68,68,0.3)" },
            ].map(m => (
              <div key={m.name} className="flex-1 p-3 flex flex-col justify-between" style={{ border: "1px solid rgba(255,0,255,0.2)", background: "rgba(255,0,255,0.03)" }}>
                <div className="text-[9px] tracking-widest" style={{ color: "rgba(255,0,255,0.4)" }}>{m.name}</div>
                <div className="font-black text-sm" style={{ color: m.col, textShadow: `0 0 10px ${m.glow}` }}>↓ {m.dir}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
