import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateExitReason,
  maxHoldMs,
  SWING_STOP_PCT,
  SWING_TARGET_PCT,
  LONG_TRAIL_STOP_PCT,
  LONG_MIN_RESEARCH_CONF,
} from "./bot-manage-core.ts";
import type { ExitBetInput, EvaluateExitParams } from "./bot-manage-core.ts";
import type { StockBotConfig } from "./types.ts";

// ── Shared test fixtures ──────────────────────────────────────────────────────

const BASE_CFG: StockBotConfig = {
  enabled: false,
  mode: "paper",
  tradingModes: ["day", "swing", "long"],
  positionSizePct: 5,
  maxConcurrentPositions: 5,
  maxDayPositions: 3,
  maxSwingPositions: 3,
  maxLongPositions: 3,
  dailyLossLimit: 500,
  minConfidence: 60,
  stopLossPct: 3,          // global fallback
  targetGainPct: 6,        // global fallback
  dayStopLossPct: null,
  dayTargetGainPct: null,
  swingStopLossPct: null,
  swingTargetGainPct: null,
  longStopLossPct: null,
  longTargetGainPct: null,
  swingMaxHoldDays: 5,
  longMaxHoldDays: 30,
  earningsBlackout: true,
  earningsBlackoutHours: 24,
  newsSensitivity: 3,
  autoStartStop: true,
  aiEnabled: true,
  atrStops: false, // tests exercise the fixed-percent path unless stated
  atrStopMult: 1.5,
  atrTargetMult: 3,
  riskPerTradePct: 0,
  sectorFocus: [],
  maxPositionDollars: null,
  dynamicSizing: false,
  minMarketCapBillion: 0,
  maxSectorPct: 0,
};

const NOW_MS = Date.now();

function swingBet(overrides: Partial<ExitBetInput> = {}): ExitBetInput {
  return {
    tradingMode: "swing",
    entryPrice: 100,
    stopLoss: null,
    targetPrice: null,
    peakPrice: null,
    createdAt: new Date(NOW_MS - 60_000), // held 1 min
    ...overrides,
  };
}

function dayBet(overrides: Partial<ExitBetInput> = {}): ExitBetInput {
  return {
    tradingMode: "day",
    entryPrice: 100,
    stopLoss: null,
    targetPrice: null,
    peakPrice: null,
    createdAt: new Date(NOW_MS - 60_000),
    ...overrides,
  };
}

function longBet(overrides: Partial<ExitBetInput> = {}): ExitBetInput {
  return {
    tradingMode: "long",
    entryPrice: 100,
    stopLoss: null,
    targetPrice: null,
    peakPrice: null,
    createdAt: new Date(NOW_MS - 60_000),
    ...overrides,
  };
}

function params(
  bet: ExitBetInput,
  price: number,
  cfgOverride: Partial<StockBotConfig> = {},
  extra: Partial<Omit<EvaluateExitParams, "bet" | "price" | "cfg">> = {},
): EvaluateExitParams {
  return {
    bet,
    price,
    cfg: { ...BASE_CFG, ...cfgOverride },
    marketOpen: true,
    nearClose: false,
    nowMs: NOW_MS,
    research: null,
    ...extra,
  };
}

// ── Swing: per-mode stop/loss ─────────────────────────────────────────────────

test("swing: exits at swingStopLossPct when configured", () => {
  const cfg = { swingStopLossPct: 2 };  // tighter than global 3%
  // price dropped exactly 2% from entry 100
  const { reason } = evaluateExitReason(params(swingBet(), 98, cfg));
  assert.equal(reason, "swing_stop");
});

test("swing: does NOT exit if loss is within swingStopLossPct threshold", () => {
  const cfg = { swingStopLossPct: 2 };
  // price dropped only 1% — should not trigger
  const { reason } = evaluateExitReason(params(swingBet(), 99, cfg));
  assert.equal(reason, null);
});

test("swing: falls back to global stopLossPct when swingStopLossPct is not set", () => {
  // BASE_CFG.stopLossPct = 3, swingStopLossPct = undefined
  // price dropped exactly 3% from entry 100
  const { reason } = evaluateExitReason(params(swingBet(), 97, {}));
  assert.equal(reason, "swing_stop");
});

test("swing: does NOT exit when loss is within global fallback threshold", () => {
  // 2% loss — less than global 3% fallback
  const { reason } = evaluateExitReason(params(swingBet(), 98, {}));
  assert.equal(reason, null);
});

test("swing: per-mode stop overrides global (wider global, tighter per-mode)", () => {
  // global = 3%, per-mode = 1.5%; price at -2% should hit per-mode but not global alone
  const cfg = { swingStopLossPct: 1.5 };
  const { reason } = evaluateExitReason(params(swingBet(), 98, cfg));
  assert.equal(reason, "swing_stop");
});

// ── Swing: per-mode target ────────────────────────────────────────────────────

test("swing: exits at swingTargetGainPct when configured", () => {
  const cfg = { swingTargetGainPct: 5 };  // tighter than global 6%
  // price rose exactly 5% from entry 100
  const { reason } = evaluateExitReason(params(swingBet(), 105, cfg));
  assert.equal(reason, "swing_target");
});

test("swing: falls back to global targetGainPct for swing target when not set", () => {
  // BASE_CFG.targetGainPct = 6%, swingTargetGainPct = undefined
  const { reason } = evaluateExitReason(params(swingBet(), 106, {}));
  assert.equal(reason, "swing_target");
});

test("swing: does NOT exit if gain is below global target fallback", () => {
  const { reason } = evaluateExitReason(params(swingBet(), 105, {}));
  assert.equal(reason, null);
});

// ── Long: trailing stop ───────────────────────────────────────────────────────

test("long: exits via trailing stop at longStopLossPct when configured", () => {
  // per-mode = 4%; peak = 100, price drops to 94 → 6% drawdown, clearly above threshold
  const cfg = { longStopLossPct: 4 };
  const bet = longBet({ peakPrice: 100 });
  const { reason } = evaluateExitReason(params(bet, 94, cfg));
  assert.equal(reason, "trailing_stop");
});

test("long: does NOT exit if drawdown is within longStopLossPct threshold", () => {
  const cfg = { longStopLossPct: 4 };
  // peak = 120, price = 116 → drawdown ≈ 3.3%, within threshold
  const bet = longBet({ peakPrice: 120 });
  const { reason } = evaluateExitReason(params(bet, 116, cfg));
  assert.equal(reason, null);
});

test("long: falls back to global stopLossPct for trailing stop when longStopLossPct is not set", () => {
  // BASE_CFG.stopLossPct = 3%, longStopLossPct = undefined
  // peak = entry 100, price drops 3% → drawdown = 3%
  const bet = longBet({ peakPrice: 100 });
  const { reason } = evaluateExitReason(params(bet, 97, {}));
  assert.equal(reason, "trailing_stop");
});

test("long: does NOT exit when drawdown is within global fallback threshold", () => {
  const bet = longBet({ peakPrice: 100 });
  // 2% drawdown — within global 3% fallback
  const { reason } = evaluateExitReason(params(bet, 98, {}));
  assert.equal(reason, null);
});

test("long: newPeak is set when price rises above recorded peak", () => {
  const bet = longBet({ peakPrice: 105 });
  // current price 110 > peakPrice 105
  const { newPeak } = evaluateExitReason(params(bet, 110, {}));
  assert.equal(newPeak, 110);
});

test("long: newPeak is null when price does not exceed recorded peak", () => {
  const bet = longBet({ peakPrice: 105 });
  const { newPeak } = evaluateExitReason(params(bet, 103, {}));
  assert.equal(newPeak, null);
});

test("long: uses entryPrice as baseline peak when peakPrice is null", () => {
  // peakPrice=null, entryPrice=100, price=110 → peak should become 110
  const bet = longBet({ peakPrice: null });
  const { newPeak } = evaluateExitReason(params(bet, 110, {}));
  assert.equal(newPeak, 110);
});

// ── Long: target gain ─────────────────────────────────────────────────────────

test("long: exits at longTargetGainPct when configured", () => {
  const cfg = { longTargetGainPct: 20 };
  const bet = longBet({ peakPrice: 120 });
  // entry 100, price 120 → +20%
  const { reason } = evaluateExitReason(params(bet, 120, cfg));
  assert.equal(reason, "long_target");
});

test("long: no target exit when longTargetGainPct is not set", () => {
  // longTargetGainPct = undefined in BASE_CFG; price at peak → no trailing stop either
  const bet = longBet({ peakPrice: 130 });
  // entry 100, price 130 → +30%; peakPrice == price so drawdown = 0%
  const { reason } = evaluateExitReason(params(bet, 130, {}));
  assert.equal(reason, null);
});

// ── Long: research downgrade ──────────────────────────────────────────────────

test("long: exits on research_downgrade when confidence drops below threshold", () => {
  const bet = longBet();
  const { reason } = evaluateExitReason(
    params(bet, 101, {}, { research: { stance: "watch", confidence: LONG_MIN_RESEARCH_CONF - 1 } }),
  );
  assert.match(reason!, /research_downgrade/);
});

test("long: does NOT downgrade-exit when confidence meets threshold exactly", () => {
  const bet = longBet();
  const { reason } = evaluateExitReason(
    params(bet, 101, {}, { research: { stance: "watch", confidence: LONG_MIN_RESEARCH_CONF } }),
  );
  assert.equal(reason, null);
});

// ── Day trade: EOD close ──────────────────────────────────────────────────────

test("day: exits with eod_close when nearClose is true", () => {
  const { reason } = evaluateExitReason(params(dayBet(), 101, {}, { nearClose: true }));
  assert.equal(reason, "eod_close");
});

test("day: exits with eod_close when market is closed", () => {
  const { reason } = evaluateExitReason(
    params(dayBet(), 101, {}, { marketOpen: false, nearClose: false }),
  );
  assert.equal(reason, "eod_close");
});

test("day: does NOT exit in the middle of the session", () => {
  const { reason } = evaluateExitReason(
    params(dayBet(), 101, {}, { marketOpen: true, nearClose: false }),
  );
  assert.equal(reason, null);
});

// ── Day trade: stop loss & target ────────────────────────────────────────────

test("day: exits on stop_loss when price hits the stop", () => {
  const bet = dayBet({ stopLoss: 95 });
  const { reason } = evaluateExitReason(params(bet, 95, {}));
  assert.equal(reason, "stop_loss");
});

test("day: exits on target when price hits the target", () => {
  const bet = dayBet({ targetPrice: 110 });
  const { reason } = evaluateExitReason(params(bet, 110, {}));
  assert.equal(reason, "target");
});

// ── Research avoid override ───────────────────────────────────────────────────

test("swing: exits on research_avoid when stance is avoid", () => {
  const { reason } = evaluateExitReason(
    params(swingBet(), 101, {}, { research: { stance: "avoid", confidence: 70 } }),
  );
  assert.equal(reason, "research_avoid (Claude: stay away/sell)");
});

test("long: exits on research_avoid when stance is avoid", () => {
  const { reason } = evaluateExitReason(
    params(longBet(), 101, {}, { research: { stance: "avoid", confidence: 70 } }),
  );
  assert.equal(reason, "research_avoid (Claude: stay away/sell)");
});

test("day: research_avoid does NOT trigger for day trades", () => {
  // Day positions ignore research — they close intraday
  const { reason } = evaluateExitReason(
    params(dayBet(), 101, {}, {
      marketOpen: true,
      nearClose: false,
      research: { stance: "avoid", confidence: 70 },
    }),
  );
  assert.equal(reason, null);
});

// ── Max hold ──────────────────────────────────────────────────────────────────

test("swing: exits on max_hold when held longer than swingMaxHoldDays", () => {
  const cfg = { swingMaxHoldDays: 1 };
  const bet = swingBet({
    createdAt: new Date(NOW_MS - maxHoldMs("swing", { ...BASE_CFG, ...cfg }) - 1),
  });
  const { reason } = evaluateExitReason(params(bet, 101, cfg));
  assert.equal(reason, "max_hold");
});

test("long: exits on max_hold when held longer than longMaxHoldDays", () => {
  const cfg = { longMaxHoldDays: 1 };
  const bet = longBet({
    peakPrice: 101,
    createdAt: new Date(NOW_MS - maxHoldMs("long", { ...BASE_CFG, ...cfg }) - 1),
  });
  const { reason } = evaluateExitReason(params(bet, 101, cfg));
  assert.equal(reason, "max_hold");
});

// ── No exit when position is healthy ─────────────────────────────────────────

test("swing: no exit reason when position is within all thresholds", () => {
  // +1% gain, well inside any stop or target
  const { reason } = evaluateExitReason(params(swingBet(), 101, {}));
  assert.equal(reason, null);
});

test("long: no exit reason when position is healthy and trending up", () => {
  const bet = longBet({ peakPrice: 102 });
  // price at peak — no drawdown
  const { reason } = evaluateExitReason(params(bet, 102, {}));
  assert.equal(reason, null);
});

// ── ATR risk-engine regression tests ─────────────────────────────────────────
// Stored hard levels (ATR-derived at entry) must be authoritative for
// long-horizon exits; config longTargetGainPct only applies as legacy fallback.

test("long: stored ATR target price triggers long_target exit", () => {
  const cfg = { ...BASE_CFG, longTargetGainPct: null as any };
  const bet = longBet({ targetPrice: 108 }); // ATR-derived hard target
  const { reason } = evaluateExitReason(params(bet, 108.5, cfg));
  assert.equal(reason, "long_target");
});

test("long: below stored target stays open (no config fallback when levels exist)", () => {
  const cfg = { ...BASE_CFG, longTargetGainPct: 5 };
  const bet = longBet({ targetPrice: 112 }); // stored level authoritative
  // +6% gain would hit the config 5% fallback, but the stored 12% target rules
  const { reason } = evaluateExitReason(params(bet, 106, cfg));
  assert.equal(reason, null);
});

test("long: legacy row without stored target falls back to config longTargetGainPct", () => {
  const cfg = { ...BASE_CFG, longTargetGainPct: 5 };
  const bet = longBet({ targetPrice: null });
  const { reason } = evaluateExitReason(params(bet, 106, cfg));
  assert.equal(reason, "long_target");
});

test("long short-side: stored target below entry triggers long_target on the way down", () => {
  const cfg = { ...BASE_CFG, longTargetGainPct: null as any };
  const bet = longBet({ side: "short", targetPrice: 92 });
  const { reason } = evaluateExitReason(params(bet, 91.5, cfg));
  assert.equal(reason, "long_target");
});

test("long: stored ATR stop still fires via hard stop check", () => {
  // peak close to price so the trailing check doesn't fire first
  const bet = longBet({ stopLoss: 95, peakPrice: 96 });
  const { reason } = evaluateExitReason(params(bet, 94.8, {}));
  assert.equal(reason, "stop_loss");
});

test("swing: stored hard target authoritative over config swing target", () => {
  const cfg = { ...BASE_CFG, swingTargetGainPct: 4 };
  const bet = swingBet({ stopLoss: 97, targetPrice: 110 });
  // +5% would hit config 4% target, but stored levels exist → stay open
  const { reason } = evaluateExitReason(params(bet, 105, cfg));
  assert.equal(reason, null);
});

test("swing: 1R-then-full-retrace triggers swing_trail", () => {
  // stop dist = 3% (stopLoss 97 on entry 100). Peak 107 (>1R in the money),
  // price retraces >3% from peak while still above entry.
  const bet = swingBet({ stopLoss: 97, targetPrice: 120, peakPrice: 107 });
  const { reason } = evaluateExitReason(params(bet, 103.5, {}));
  assert.equal(reason, "swing_trail");
});
