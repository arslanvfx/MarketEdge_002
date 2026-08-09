import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEntryMode, heldKey } from "./bot-entry-core.ts";
import type { TradingMode } from "./types.ts";

const ALL: TradingMode[] = ["day", "swing", "long"];
const caps = { day: 3, swing: 3, long: 3 };
const zero = { day: 0, swing: 0, long: 0 };

function base(overrides: Partial<Parameters<typeof selectEntryMode>[0]> = {}) {
  return {
    ticker: "AAPL",
    horizon: null as TradingMode | null,
    held: new Set<string>(),
    modeCounts: { ...zero },
    caps,
    activeModes: ALL,
    pdtBlocked: false,
    ...overrides,
  };
}

test("same ticker can enter a second horizon while the first is held", () => {
  const held = new Set([heldKey("AAPL", "day")]);
  const r = selectEntryMode(base({ horizon: "swing", held }));
  assert.equal(r.mode, "swing");
  assert.equal(r.allHeld, false);
});

test("same ticker can hold all three horizons concurrently", () => {
  const held = new Set<string>();
  for (const h of ALL) {
    const r = selectEntryMode(base({ horizon: h, held }));
    assert.equal(r.mode, h);
    held.add(heldKey("AAPL", r.mode!));
  }
  assert.equal(held.size, 3);
});

test("duplicate entry in the same (ticker, horizon) is blocked", () => {
  const held = new Set([heldKey("AAPL", "swing")]);
  const r = selectEntryMode(base({ horizon: "swing", held }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, true);
});

test("flexible candidate skips a held horizon and takes the next preference", () => {
  const held = new Set([heldKey("AAPL", "day")]);
  const r = selectEntryMode(base({ held }));
  assert.equal(r.mode, "swing");
});

test("flexible candidate with all horizons held returns null with allHeld=true", () => {
  const held = new Set(ALL.map((m) => heldKey("AAPL", m)));
  const r = selectEntryMode(base({ held }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, true);
});

test("held guard is per-ticker: another ticker's position does not block", () => {
  const held = new Set([heldKey("MSFT", "day")]);
  const r = selectEntryMode(base({ horizon: "day", held }));
  assert.equal(r.mode, "day");
});

test("horizon capacity full returns null but allHeld=false (real capacity skip)", () => {
  const r = selectEntryMode(base({ horizon: "day", modeCounts: { ...zero, day: 3 } }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, false);
});

test("inactive mode is not selectable", () => {
  const r = selectEntryMode(base({ horizon: "day", activeModes: ["swing", "long"] }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, false);
});

test("PDT block prevents day entries but not other horizons", () => {
  const day = selectEntryMode(base({ horizon: "day", pdtBlocked: true }));
  assert.equal(day.mode, null);
  const flex = selectEntryMode(base({ pdtBlocked: true }));
  assert.equal(flex.mode, "swing");
});

test("research-driven candidate never falls back to another horizon", () => {
  const held = new Set([heldKey("AAPL", "long")]);
  const r = selectEntryMode(base({ horizon: "long", held }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, true);
});

// ── computeRiskControls (ATR risk engine + sizing) ───────────────────────────
import { computeRiskControls } from "./bot-entry-core.ts";
import type { StockBotConfig } from "./types.ts";

const RISK_CFG: StockBotConfig = {
  enabled: true, mode: "paper", tradingModes: ALL,
  positionSizePct: 5, maxConcurrentPositions: 5,
  maxDayPositions: 3, maxSwingPositions: 3, maxLongPositions: 3,
  dailyLossLimit: 500, minConfidence: 60,
  stopLossPct: 3, targetGainPct: 6,
  dayStopLossPct: null, dayTargetGainPct: null,
  swingStopLossPct: null, swingTargetGainPct: null,
  longStopLossPct: null, longTargetGainPct: null,
  swingMaxHoldDays: 5, longMaxHoldDays: 30,
  earningsBlackout: true, earningsBlackoutHours: 24,
  newsSensitivity: 3, autoStartStop: true,
  aiEnabled: true, atrStops: true, atrStopMult: 1.5, atrTargetMult: 3,
  riskPerTradePct: 0, sectorFocus: [], maxPositionDollars: null,
  dynamicSizing: false, minMarketCapBillion: 0, maxSectorPct: 0,
} as StockBotConfig;

test("risk: ATR mode scales stop/target with volatility and horizon", () => {
  const day = computeRiskControls({ mode: "day", cfg: RISK_CFG, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(day.useAtr, true);
  assert.equal(day.stopPct, 3);    // 2 × 1.5 × 1
  assert.equal(day.targetPct, 6);  // 2 × 3 × 1
  const swing = computeRiskControls({ mode: "swing", cfg: RISK_CFG, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(swing.stopPct, 4.5); // ×1.5 horizon scale
  const long = computeRiskControls({ mode: "long", cfg: RISK_CFG, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(long.stopPct, 7.5);  // ×2.5 horizon scale
});

test("risk: missing ATR falls back to fixed percentages (fail-safe)", () => {
  const r = computeRiskControls({ mode: "day", cfg: RISK_CFG, atrPct: null, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(r.useAtr, false);
  assert.equal(r.stopPct, 3);
  assert.equal(r.targetPct, 6);
});

test("risk: clamps stop within [0.75, 12] %", () => {
  const tiny = computeRiskControls({ mode: "day", cfg: RISK_CFG, atrPct: 0.1, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(tiny.stopPct, 0.75);
  const huge = computeRiskControls({ mode: "long", cfg: RISK_CFG, atrPct: 20, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(huge.stopPct, 12);
});

test("risk: riskPerTradePct caps notional so stop-out loses ≤ risk budget", () => {
  const cfg = { ...RISK_CFG, positionSizePct: 50, riskPerTradePct: 1 };
  // equity 10000, risk$ = 100; ATR 2 → day stop 3% → notional cap 100/0.03 = 3333 (< 50% base of 5000)
  const r = computeRiskControls({ mode: "day", cfg, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.ok(Math.abs(r.notional - 3333.33) < 1);
  assert.equal(r.qty, 33);
  // Loss at full stop-out ≈ notional × stopPct ≤ risk budget
  assert.ok(r.notional * (r.stopPct / 100) <= 100 + 1e-6);
});

test("risk: riskPerTradePct=0 leaves base sizing untouched", () => {
  const r = computeRiskControls({ mode: "day", cfg: RISK_CFG, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100 });
  assert.equal(r.notional, 500); // 5% of equity
  assert.equal(r.qty, 5);
});

// ── computeExitLevels: exit levels must anchor to the confirmed fill ────────
import { computeExitLevels } from "./bot-entry-core.ts";

test("exit levels: long adverse fill above signal price keeps configured distances", () => {
  // Signal price was 100, but the GTC limit filled at 103.
  const { stopLoss, targetPrice } = computeExitLevels(103, 3, 6, "long");
  assert.ok(Math.abs(stopLoss - 103 * 0.97) < 1e-9);
  assert.ok(Math.abs(targetPrice - 103 * 1.06) < 1e-9);
  // The fill is never already beyond its own stop/target.
  assert.ok(stopLoss < 103 && targetPrice > 103);
});

test("exit levels: short adverse fill below signal price keeps configured distances", () => {
  // Short signal at 100, filled at 97.5.
  const { stopLoss, targetPrice } = computeExitLevels(97.5, 3, 6, "short");
  assert.ok(Math.abs(stopLoss - 97.5 * 1.03) < 1e-9);
  assert.ok(Math.abs(targetPrice - 97.5 * 0.94) < 1e-9);
  assert.ok(stopLoss > 97.5 && targetPrice < 97.5);
});

// ── Short-side conservative sizing ──────────────────────────────────────────
import { SHORT_FILL_BUFFER_PCT } from "./bot-entry-core.ts";

test("risk: shorts sized against padded price so improved fills stay within budget", () => {
  const cfg = { ...RISK_CFG, positionSizePct: 50, riskPerTradePct: 1 };
  const longR = computeRiskControls({ mode: "day", cfg, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100, side: "long" });
  const shortR = computeRiskControls({ mode: "day", cfg, atrPct: 2, effectiveConfidence: 65, equity: 10000, price: 100, side: "short" });
  assert.ok(shortR.qty < longR.qty, "short qty must be smaller than long qty at same price");
  // Even if the sell limit fills SHORT_FILL_BUFFER_PCT above the limit, the
  // dollar stop-out stays within the 1% risk budget (= $100).
  const improvedFill = 100 * (1 + SHORT_FILL_BUFFER_PCT / 100);
  const worstLoss = shortR.qty * improvedFill * (shortR.stopPct / 100);
  assert.ok(worstLoss <= 100 + 1e-6, `worst-case short loss ${worstLoss} exceeds budget`);
});
