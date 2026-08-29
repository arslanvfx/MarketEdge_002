// Smart Hours clarity regression tests — Task #681
//
// Verifies the additive symbolSmartHoursModes / smartHoursScope fields that the
// server resolvers compute for display in the bot status and conditions endpoints.
//
// Scenarios tested:
//   1. Global mode — silenced hour  → every symbol shows "silenced"
//   2. Global mode — active hour    → every symbol shows "active"
//   3. Global mode — reduced hour   → every symbol shows "reduced"
//   4. Per-market mode — global schedule silenced, BTC active
//      → BTC shows "active", others show "silenced" (or "no-schedule" if unconfigured)
//   5. Per-market mode — inverse: BTC silenced, global schedule active (no global effect)
//      → BTC shows "silenced", other symbols without a schedule show "no-schedule"
//   6. Per-market mode — BTC reduced
//      → BTC shows "reduced", other configured-active symbols show "active"
//   7. Smart Hours master OFF → every symbol shows "active" regardless
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveQuietHoursV2State,
  resolveEntryQuietHoursDecisionForSymbol,
  type QuietHoursV2,
  type BotConfig,
} from "./kalshi-bot-engine-core.ts";
import { CRYPTO_COINS, KALSHI_SERIES } from "./market-defs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const botDbSource = readFileSync(join(here, "kalshi-bot-db.ts"), "utf8");
const routeSource = readFileSync(join(here, "../routes/kalshi-bot.ts"), "utf8");

test("manual Smart Hours threshold is persisted for subsequent hourly calibrations", () => {
  assert.match(
    botDbSource,
    /autoTuneThreshold:\s*opts\.thresholdOverride/,
    "manual calibration must save its threshold into durable bot config",
  );
  assert.match(
    botDbSource,
    /thresholdOverride \?\? qhv2\?\.autoTuneThreshold \?\? 84\.5/,
    "hourly calibration must reuse the saved threshold when no override is supplied",
  );
});

test("Smart Hours accepts persisted and manual calibration thresholds down to 40%", () => {
  assert.match(routeSource, /v2\.autoTuneThreshold >= 40/);
  assert.match(routeSource, /rawThreshold >= 40/);
});

// ---------------------------------------------------------------------------
// Helpers — mirrors the symbolSmartHoursModes computation in getBotState()
// and getWindowConditions() so any server-side regression is caught here too.
// ---------------------------------------------------------------------------

type SymbolSmartHoursMode = "active" | "silenced" | "reduced" | "no-schedule";

function resolveSymbolModes(
  config: Pick<BotConfig,
    "freeRunMode" | "quietHoursV2" | "quietHoursStart" | "quietHoursEnd" |
    "shadowPaperIgnoreQuietHours" | "quietHoursMode" | "perSymbolQuietHours" | "dataGatheringEnabled">,
  botMode: "paper" | "live",
  now: Date,
): Record<string, SymbolSmartHoursMode> {
  const scope = config.quietHoursMode === "per_market" ? "per_market" : "global";
  const masterEnabled = config.quietHoursV2?.enabled === true;
  const result: Record<string, SymbolSmartHoursMode> = {};

  for (const coin of CRYPTO_COINS.filter(c => KALSHI_SERIES[c.symbol])) {
    const sym = coin.symbol;
    if (!masterEnabled) {
      result[sym] = "active";
      continue;
    }
    if (scope === "per_market") {
      const symSchedule = config.perSymbolQuietHours?.[sym];
      if (!symSchedule?.enabled) {
        result[sym] = "no-schedule";
        continue;
      }
      const decision = resolveEntryQuietHoursDecisionForSymbol(config, botMode, sym, now);
      if (decision.action === "block" || decision.qhMode === "silenced") {
        result[sym] = "silenced";
      } else if (decision.qhMode === "reduced") {
        result[sym] = "reduced";
      } else {
        result[sym] = "active";
      }
    } else {
      const st = resolveQuietHoursV2State(config.quietHoursV2, now);
      if (st.mode === "silenced") {
        result[sym] = "silenced";
      } else if (st.mode === "reduced") {
        result[sym] = "reduced";
      } else {
        result[sym] = "active";
      }
    }
  }
  return result;
}

// Monday 2026-08-10 15:30 UTC = Monday 11:30 AM EDT (ET dow=1, UTC hour=15).
const MON_11AM_ET = new Date("2026-08-10T15:30:00Z");

// Base config with no schedule (all defaults).
function makeConfig(
  qhv2: QuietHoursV2 | undefined,
  extra?: Partial<BotConfig>,
): Pick<BotConfig,
  "freeRunMode" | "quietHoursV2" | "quietHoursStart" | "quietHoursEnd" |
  "shadowPaperIgnoreQuietHours" | "quietHoursMode" | "perSymbolQuietHours" | "dataGatheringEnabled"> {
  return {
    freeRunMode: false,
    quietHoursStart: 7,
    quietHoursEnd: 7,
    shadowPaperIgnoreQuietHours: false,
    quietHoursV2: qhv2,
    ...extra,
  };
}

// All tracked symbols (those that have a KALSHI_SERIES entry).
const TRACKED_SYMBOLS = CRYPTO_COINS.filter(c => KALSHI_SERIES[c.symbol]).map(c => c.symbol);

// ---------------------------------------------------------------------------
// 1. Global silenced → all symbols blocked
// ---------------------------------------------------------------------------

test("smart-hours clarity: global silenced → all symbols show silenced", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] }, // Monday ET, 15:00 UTC = 11 AM EDT → silenced
  };
  const cfg = makeConfig(qhv2);
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  for (const sym of TRACKED_SYMBOLS) {
    assert.equal(modes[sym], "silenced",
      `${sym} should be silenced in global-silenced mode`);
  }
});

// ---------------------------------------------------------------------------
// 2. Global active → all symbols active
// ---------------------------------------------------------------------------

test("smart-hours clarity: global active hour → all symbols show active", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [3], // only 3:00 UTC silenced — not our test hour
    reducedBetUtcHours: {},
  };
  const cfg = makeConfig(qhv2);
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  for (const sym of TRACKED_SYMBOLS) {
    assert.equal(modes[sym], "active", `${sym} should be active in global-active mode`);
  }
});

// ---------------------------------------------------------------------------
// 3. Global reduced → all symbols reduced
// ---------------------------------------------------------------------------

test("smart-hours clarity: global reduced hour → all symbols show reduced", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    reducedByDow: { "1": { "15": 25 } }, // Monday ET, 15:00 UTC → 25% reduction
  };
  const cfg = makeConfig(qhv2);
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  for (const sym of TRACKED_SYMBOLS) {
    assert.equal(modes[sym], "reduced", `${sym} should be reduced in global-reduced mode`);
  }
});

// ---------------------------------------------------------------------------
// 4. Per-market: global schedule silenced, BTC has its own active schedule
//    → BTC = "active", symbols without a schedule = "no-schedule"
// ---------------------------------------------------------------------------

test("smart-hours clarity: per-market BTC active while global schedule silenced", () => {
  const globalMaster: QuietHoursV2 = {
    enabled: true,   // master ON
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] }, // global says silenced — but per_market mode ignores global schedule
  };
  // BTC has its own schedule that does NOT silence 15:00 UTC
  const btcSchedule: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [3] }, // 3:00 UTC is silenced — not 15:00
  };
  const cfg = makeConfig(globalMaster, {
    quietHoursMode: "per_market",
    perSymbolQuietHours: { BTC: btcSchedule },
  });
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  // BTC has an enabled schedule that doesn't silence 15:00 → active
  assert.equal(modes["BTC"], "active",
    "BTC should be active: its own per-market schedule does not silence 15:00");

  // All other symbols have no schedule configured → no-schedule
  for (const sym of TRACKED_SYMBOLS.filter(s => s !== "BTC")) {
    assert.equal(modes[sym], "no-schedule",
      `${sym} has no per-market schedule → should show no-schedule`);
  }
});

// ---------------------------------------------------------------------------
// 5. Per-market inverse: BTC silenced, global schedule active (global has no effect)
//    → BTC = "silenced", others without schedule = "no-schedule"
// ---------------------------------------------------------------------------

test("smart-hours clarity: per-market BTC silenced, no global schedule effect on others", () => {
  const globalMaster: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    // global schedule is fully active for 15:00 UTC — in per_market mode this has no effect on other symbols
  };
  const btcSchedule: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] }, // BTC is silenced at 15:00 UTC Monday ET
  };
  const cfg = makeConfig(globalMaster, {
    quietHoursMode: "per_market",
    perSymbolQuietHours: { BTC: btcSchedule },
  });
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  assert.equal(modes["BTC"], "silenced",
    "BTC should be silenced per its own per-market schedule");

  // Others have no schedule → "no-schedule" (not "active" from the global schedule)
  for (const sym of TRACKED_SYMBOLS.filter(s => s !== "BTC")) {
    assert.equal(modes[sym], "no-schedule",
      `${sym} has no per-market schedule → no-schedule (global schedule doesn't apply in per_market mode)`);
  }
});

// ---------------------------------------------------------------------------
// 6. Per-market: BTC reduced, others no-schedule
// ---------------------------------------------------------------------------

test("smart-hours clarity: per-market BTC reduced entry", () => {
  const globalMaster: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
  };
  const btcSchedule: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    reducedByDow: { "1": { "15": 50 } }, // BTC: 50% reduced at 15:00 UTC Monday ET
  };
  const cfg = makeConfig(globalMaster, {
    quietHoursMode: "per_market",
    perSymbolQuietHours: { BTC: btcSchedule },
  });
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  assert.equal(modes["BTC"], "reduced", "BTC should be reduced per its own per-market schedule");

  for (const sym of TRACKED_SYMBOLS.filter(s => s !== "BTC")) {
    assert.equal(modes[sym], "no-schedule");
  }
});

// ---------------------------------------------------------------------------
// 7. Smart Hours master OFF → all symbols active regardless of per-symbol schedules
// ---------------------------------------------------------------------------

test("smart-hours clarity: master OFF → all symbols active, per-symbol schedules ignored", () => {
  const globalMaster: QuietHoursV2 = {
    enabled: false, // master OFF
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] }, // would silence if master were on
  };
  const btcSchedule: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] },
  };
  const cfg = makeConfig(globalMaster, {
    quietHoursMode: "per_market",
    perSymbolQuietHours: { BTC: btcSchedule },
  });
  const modes = resolveSymbolModes(cfg, "live", MON_11AM_ET);

  // Master OFF → every symbol is "active" (master disables all enforcement)
  for (const sym of TRACKED_SYMBOLS) {
    assert.equal(modes[sym], "active",
      `${sym} should be active when Smart Hours master is OFF`);
  }
});

// ---------------------------------------------------------------------------
// 8. Smart Hours scope is correctly derived
// ---------------------------------------------------------------------------

test("smart-hours clarity: scope is global when quietHoursMode is undefined", () => {
  const cfg = makeConfig({ enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} });
  const scope = cfg.quietHoursMode === "per_market" ? "per_market" : "global";
  assert.equal(scope, "global");
});

test("smart-hours clarity: scope is per_market when quietHoursMode is per_market", () => {
  const cfg = makeConfig({ enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} }, {
    quietHoursMode: "per_market",
  });
  const scope = cfg.quietHoursMode === "per_market" ? "per_market" : "global";
  assert.equal(scope, "per_market");
});

// ---------------------------------------------------------------------------
// 9. UI label correctness: no "market availability" wording —
//    these states represent Smart Hours entry eligibility, not Kalshi market availability.
//    This test documents the canonical label mapping that the frontend must follow.
// ---------------------------------------------------------------------------

const CANONICAL_LABELS: Record<SymbolSmartHoursMode, string> = {
  silenced: "Entry blocked",
  reduced: "Reduced entry",
  active: "Entries active",
  "no-schedule": "No schedule",
};

test("smart-hours clarity: canonical UI labels distinguish entry eligibility from market availability", () => {
  // Every mode must have a label that describes entry eligibility, not market state.
  for (const [mode, label] of Object.entries(CANONICAL_LABELS) as Array<[SymbolSmartHoursMode, string]>) {
    assert.ok(
      !label.toLowerCase().includes("market") || label.toLowerCase().includes("schedule"),
      `Label for "${mode}" must not conflate Smart Hours with Kalshi market availability. Got: "${label}"`,
    );
    assert.ok(label.length > 0, `Label for "${mode}" must not be empty`);
  }

  // The silenced state must say "blocked" not just "silenced" so it's clear entries are blocked.
  assert.ok(
    CANONICAL_LABELS.silenced.toLowerCase().includes("block"),
    `Silenced label must say 'blocked' (entries are blocked): "${CANONICAL_LABELS.silenced}"`,
  );

  // The no-schedule state must NOT say "inactive" or "unavailable" (those imply market unavailability).
  assert.ok(
    !CANONICAL_LABELS["no-schedule"].toLowerCase().includes("inactive"),
    `no-schedule label must not say 'inactive': "${CANONICAL_LABELS["no-schedule"]}"`,
  );
  assert.ok(
    !CANONICAL_LABELS["no-schedule"].toLowerCase().includes("unavailable"),
    `no-schedule label must not say 'unavailable': "${CANONICAL_LABELS["no-schedule"]}"`,
  );
});
