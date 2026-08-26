import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SMART_EXIT_CONFIG } from "./kalshi-smart-exit-policy.ts";
import {
  authorizeSmartExitExecution,
  smartExitIdentityMatches,
} from "./kalshi-smart-exit-execution.ts";
import type {
  SmartExitAppliedVersion,
  SmartExitConfig,
  SmartExitPosition,
} from "./kalshi-smart-exit-types.ts";

const position: SmartExitPosition = {
  positionId: "p1",
  owner: { kind: "regular", tradingMode: "live" },
  symbol: "BTC",
  windowKey: "2026-08-26T12:00",
  ticker: "KXBTC15M-26AUG261200-00",
  side: "yes",
  underlyingKind: "crypto",
  remainingQuantity: 4,
  exchangeIndex: 0,
  strikePrice: 64_000,
  expirySeconds: 1_800_000_900,
  openedAtSeconds: 1_800_000_000,
  modelAtEntry: { winProbability: 0.8, observedAtSeconds: 1_800_000_000 },
  marketAtEntry: { winProbability: 0.75, observedAtSeconds: 1_800_000_000 },
};
const version: SmartExitAppliedVersion = {
  owner: "regular",
  symbol: "BTC",
  version: "validated-v1",
  liveEligible: true,
  appliedAt: "2026-08-26T12:00:00.000Z",
};

function configured(mode: SmartExitConfig["mode"]): SmartExitConfig {
  return { ...DEFAULT_SMART_EXIT_CONFIG, enabled: mode !== "off", mode };
}

test("disabled and shadow modes cannot cross the owner boundary", () => {
  for (const config of [
    { ...DEFAULT_SMART_EXIT_CONFIG, enabled: false, mode: "shadow" as const },
    configured("off"),
    configured("shadow"),
  ]) {
    assert.equal(authorizeSmartExitExecution({
      config, position, recommendation: "exit", appliedVersion: version,
    }).authorized, false);
  }
});

test("live execution requires exact scope and live-eligible applied version", () => {
  assert.equal(authorizeSmartExitExecution({
    config: configured("live-exit"), position, recommendation: "exit", appliedVersion: version,
  }).authorized, true);
  assert.equal(authorizeSmartExitExecution({
    config: configured("live-exit"), position, recommendation: "exit",
    appliedVersion: { ...version, symbol: "ETH" },
  }).authorized, false);
  assert.equal(authorizeSmartExitExecution({
    config: configured("live-exit"), position, recommendation: "exit",
    appliedVersion: { ...version, liveEligible: false },
  }).authorized, false);
});

test("paper and live owner routes never cross", () => {
  assert.equal(authorizeSmartExitExecution({
    config: configured("paper-exit"), position, recommendation: "exit", appliedVersion: version,
  }).authorized, false);
  assert.equal(authorizeSmartExitExecution({
    config: configured("live-exit"),
    position: { ...position, owner: { kind: "regular", tradingMode: "paper" } },
    recommendation: "exit",
    appliedVersion: version,
  }).authorized, false);
});

test("Scalper exits stay blocked until that owner supplies a durable close lifecycle", () => {
  assert.equal(authorizeSmartExitExecution({
    config: configured("live-exit"),
    position: { ...position, owner: { kind: "scalper", tradingMode: "live" } },
    recommendation: "exit",
    appliedVersion: { ...version, owner: "scalper" },
  }).authorized, false);
});

test("identity matching detects every stale/race-sensitive field", () => {
  const identity = {
    positionId: position.positionId,
    symbol: position.symbol,
    windowKey: position.windowKey,
    ticker: position.ticker,
    side: position.side,
    tradingMode: position.owner.tradingMode,
    remainingQuantity: position.remainingQuantity,
  };
  assert.equal(smartExitIdentityMatches(identity, position), true);
  for (const stale of [
    { ...identity, positionId: "new-position" },
    { ...identity, windowKey: "2026-08-26T12:15" },
    { ...identity, ticker: "other" },
    { ...identity, side: "no" as const },
    { ...identity, tradingMode: "paper" as const },
    { ...identity, remainingQuantity: 3 },
  ]) assert.equal(smartExitIdentityMatches(stale, position), false);
});