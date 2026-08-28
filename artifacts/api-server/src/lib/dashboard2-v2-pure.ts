import type { ExecutableBook, ExecutableSellBook } from "./kalshi-orderbook-store.ts";

export type Dashboard2Mode = "paper" | "live";
export type Dashboard2Config = Readonly<{
  enabled: boolean;
  version: 2;
  minEntryMinute: number;
  sideCostFloor: number;
  sideCostCeiling: number;
  maxContracts: number;
  maxDollarBudget: number;
  paperStartingBalance: number;
  minAccountBalance: number;
  maxTotalExposure: number;
  maxConcurrentPositions: number;
  enabledSymbols: readonly string[];
  quietHours: Readonly<{ enabled: boolean; startUtc: number; endUtc: number }>;
  proximityGuard: Readonly<{ enabled: boolean; minPct: number }>;
  directionGuard: Readonly<{ enabled: boolean }>;
  stopLoss: Readonly<{ enabled: boolean; floor: number; activationMinute: number }>;
  circuitBreaker: Readonly<{ enabled: boolean; maxDailyLoss: number; maxConsecutiveLosses: number }>;
  liveActivation: false;
}>;

const MODES = new Set<Dashboard2Mode>(["paper", "live"]);
export const DEFAULT_DASHBOARD2_CONFIG: Dashboard2Config = Object.freeze({
  enabled: false,
  version: 2,
  minEntryMinute: 8,
  sideCostFloor: 0.79,
  sideCostCeiling: 0.87,
  maxContracts: 2,
  maxDollarBudget: 10,
  paperStartingBalance: 5_000,
  minAccountBalance: 0,
  maxTotalExposure: 10,
  maxConcurrentPositions: 2,
  enabledSymbols: Object.freeze(["BTC", "ETH", "SOL"]),
  quietHours: Object.freeze({ enabled: false, startUtc: 0, endUtc: 0 }),
  proximityGuard: Object.freeze({ enabled: true, minPct: 0 }),
  directionGuard: Object.freeze({ enabled: true }),
  stopLoss: Object.freeze({ enabled: false, floor: 0.5, activationMinute: 10 }),
  circuitBreaker: Object.freeze({ enabled: true, maxDailyLoss: 10, maxConsecutiveLosses: 3 }),
  liveActivation: false,
});

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: "VALIDATION" });
}

export function isDashboard2Mode(value: unknown): value is Dashboard2Mode {
  return typeof value === "string" && MODES.has(value as Dashboard2Mode);
}

export type Dashboard2SettledTrade = Readonly<{ settledAt: Date | string; pnl: number }>;

export function dashboard2LifecyclePnl(input: {
  entryCost: number; filledContracts: number;
  exits: readonly Readonly<{ filledContracts: number; proceeds: number }>[];
  settlementValue?: number | null;
}): { exitedContracts: number; remainingContracts: number; pnl: number; finalized: boolean } {
  const exitedContracts = input.exits.reduce((sum, exit) => sum + exit.filledContracts, 0);
  const remainingContracts = Math.max(0, input.filledContracts - exitedContracts);
  const realized = input.exits.reduce(
    (sum, exit) => sum + (exit.proceeds - input.entryCost) * exit.filledContracts, 0);
  const settled = input.settlementValue == null
    ? 0
    : (input.settlementValue - input.entryCost) * remainingContracts;
  return {
    exitedContracts, remainingContracts, pnl: Number((realized + settled).toFixed(8)),
    finalized: remainingContracts === 0 || input.settlementValue != null,
  };
}

export const DASHBOARD2_PERFORMANCE_TIME_ZONE = "America/New_York";

export type Dashboard2PerformancePosition = Readonly<{
  entryCost: number; filledContracts: number; settlementValue: number | null;
  settledAt: Date | string | null;
  exits: readonly Readonly<{ filledContracts: number; proceeds: number; at: Date | string }>[];
}>;

/** Returns New York calendar-day bounds without relying on the server timezone. */
export function dashboard2EtDayBounds(now = new Date()): { dayStartAt: Date; nextResetAt: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DASHBOARD2_PERFORMANCE_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now);
  const get = (name: string) => Number(parts.find(part => part.type === name)?.value);
  const y = get("year"), m = get("month"), d = get("day");
  const atLocalMidnight = (year: number, month: number, day: number) => {
    const nominal = Date.UTC(year, month - 1, day);
    const zone = new Intl.DateTimeFormat("en-US", {
      timeZone: DASHBOARD2_PERFORMANCE_TIME_ZONE, timeZoneName: "longOffset",
    }).formatToParts(new Date(nominal)).find(part => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone);
    const offset = match ? (Number(match[2]) * 60 + Number(match[3])) * 60_000 * (match[1] === "+" ? 1 : -1) : 0;
    return new Date(nominal - offset);
  };
  const dayStartAt = atLocalMidnight(y, m, d);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { dayStartAt, nextResetAt: atLocalMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) };
}

export function dashboard2EtHour(at: Date | string): number {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: DASHBOARD2_PERFORMANCE_TIME_ZONE, hour: "numeric", hourCycle: "h23",
  }).format(new Date(at)));
  return hour % 24;
}

export function dashboard2FinalizedPosition(position: Dashboard2PerformancePosition): {
  pnl: number; finalized: boolean; finalAt: Date | null; filledContracts: number;
} {
  const lifecycle = dashboard2LifecyclePnl({
    entryCost: position.entryCost, filledContracts: position.filledContracts,
    exits: position.exits.map(exit => ({ filledContracts: exit.filledContracts, proceeds: exit.proceeds })),
    settlementValue: position.settlementValue,
  });
  // A fully exited stop-loss lifecycle belongs to its final confirmed exit,
  // even though the ledger also stamps settled_at when it closes the lifecycle.
  const finalAt = lifecycle.remainingContracts === 0 && position.exits.length
    ? new Date(position.exits.reduce((last, exit) => new Date(exit.at).getTime() > last.getTime() ? new Date(exit.at) : last, new Date(position.exits[0]!.at)))
    : position.settledAt != null ? new Date(position.settledAt) : null;
  return { pnl: lifecycle.pnl, finalized: lifecycle.finalized && finalAt != null, finalAt, filledContracts: position.filledContracts };
}

export function dashboard2WhatIfPosition(entryCost: number, filledContracts: number, pnl: number, stake: number) {
  const contracts = Number.isFinite(entryCost) && entryCost > 0 ? Math.floor(stake / entryCost) : 0;
  const actualStake = entryCost * filledContracts;
  const perContractPnl = filledContracts > 0 ? pnl / filledContracts : 0;
  return {
    contracts, actualStake, actualPnl: pnl,
    hypotheticalStake: contracts * entryCost, hypotheticalPnl: contracts * perContractPnl,
  };
}

/** Returns a percentage (12.5 means 12.5%), not a decimal ratio. */
export function dashboard2RoiPct(pnl: number, stake: number): number | null {
  return stake === 0 ? null : pnl / stake * 100;
}

/** Metrics are deliberately computed from settlement order: a win resets the
 * loss streak, and "daily" means the America/New_York calendar day. */
export function dashboard2CircuitMetrics(rows: readonly Dashboard2SettledTrade[], now = new Date()): {
  dailyPnl: number; consecutiveLosses: number;
} {
  const etDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const dateKey = (value: Date | string) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
  let dailyPnl = 0;
  for (const row of rows) if (dateKey(row.settledAt) === etDay) dailyPnl += row.pnl;
  let consecutiveLosses = 0;
  for (const row of rows) {
    if (row.pnl >= 0) break;
    consecutiveLosses++;
  }
  return { dailyPnl, consecutiveLosses };
}

export function dashboard2ReservationAllowed(input: {
  duplicate: boolean; openPositions: number; exposure: number; requestedContracts: number;
  sideCostCeiling: number; maxConcurrentPositions: number; maxTotalExposure: number;
}): boolean {
  return !input.duplicate &&
    input.openPositions < input.maxConcurrentPositions &&
    input.exposure + input.requestedContracts * input.sideCostCeiling <= input.maxTotalExposure;
}

export function parseDashboard2Config(
  value: unknown,
  base: Dashboard2Config = DEFAULT_DASHBOARD2_CONFIG,
): Dashboard2Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("config must be an object");
  const patch = value as Record<string, unknown>;
  const allowed = new Set([
    "enabled", "version", "minEntryMinute", "sideCostFloor", "sideCostCeiling",
    "maxContracts", "maxDollarBudget", "paperStartingBalance", "minAccountBalance", "maxTotalExposure",
    "maxConcurrentPositions", "enabledSymbols", "quietHours", "proximityGuard",
    "directionGuard", "stopLoss", "circuitBreaker", "liveActivation",
  ]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) bad(`unknown config field: ${key}`);
  const result = {
    ...base,
    ...patch,
    quietHours: { ...base.quietHours, ...(patch.quietHours as object ?? {}) },
    proximityGuard: { ...base.proximityGuard, ...(patch.proximityGuard as object ?? {}) },
    directionGuard: { ...base.directionGuard, ...(patch.directionGuard as object ?? {}) },
    stopLoss: { ...base.stopLoss, ...(patch.stopLoss as object ?? {}) },
    circuitBreaker: { ...base.circuitBreaker, ...(patch.circuitBreaker as object ?? {}) },
  } as Record<string, unknown>;
  if (typeof result.enabled !== "boolean") bad("enabled must be boolean");
  if (!Number.isInteger(result.minEntryMinute) || (result.minEntryMinute as number) < 0 || (result.minEntryMinute as number) > 14) bad("minEntryMinute must be an integer from 0 to 14");
  for (const key of ["sideCostFloor", "sideCostCeiling"] as const) {
    if (typeof result[key] !== "number" || !Number.isFinite(result[key]) || result[key] < 0.01 || result[key] > 0.99) bad(`${key} must be a price from 0.01 to 0.99`);
  }
  if ((result.sideCostFloor as number) > (result.sideCostCeiling as number)) bad("sideCostFloor must not exceed sideCostCeiling");
  if (result.version !== 2) bad("version must be 2");
  if (!Number.isInteger(result.maxContracts) || (result.maxContracts as number) < 1 || (result.maxContracts as number) > 100) bad("maxContracts must be an integer from 1 to 100");
  for (const key of ["maxDollarBudget", "minAccountBalance", "maxTotalExposure"] as const) {
    if (typeof result[key] !== "number" || !Number.isFinite(result[key]) || result[key] < 0) bad(`${key} must be a non-negative finite number`);
  }
  if (typeof result.paperStartingBalance !== "number" || !Number.isFinite(result.paperStartingBalance) ||
      result.paperStartingBalance < 0 || result.paperStartingBalance > 1_000_000) {
    bad("paperStartingBalance must be a finite number from 0 to 1000000");
  }
  if (!Number.isInteger(result.maxConcurrentPositions) || (result.maxConcurrentPositions as number) < 1 || (result.maxConcurrentPositions as number) > 100) bad("maxConcurrentPositions must be an integer from 1 to 100");
  if (!Array.isArray(result.enabledSymbols) || result.enabledSymbols.length === 0 || result.enabledSymbols.some(symbol => typeof symbol !== "string" || !/^[A-Z0-9]{2,12}$/.test(symbol))) bad("enabledSymbols must be a non-empty array of uppercase symbols");
  const nested = (key: "quietHours" | "proximityGuard" | "directionGuard" | "stopLoss" | "circuitBreaker", fields: string[]) => {
    const val = result[key];
    if (!val || typeof val !== "object" || Array.isArray(val) || Object.keys(val as object).some(k => !fields.includes(k))) bad(`${key} is invalid`);
  };
  nested("quietHours", ["enabled", "startUtc", "endUtc"]);
  nested("proximityGuard", ["enabled", "minPct"]);
  nested("directionGuard", ["enabled"]);
  nested("stopLoss", ["enabled", "floor", "activationMinute"]);
  nested("circuitBreaker", ["enabled", "maxDailyLoss", "maxConsecutiveLosses"]);
  const bool = (v: unknown) => typeof v === "boolean";
  const q = result.quietHours as Record<string, unknown>;
  const p = result.proximityGuard as Record<string, unknown>;
  const d = result.directionGuard as Record<string, unknown>;
  const s = result.stopLoss as Record<string, unknown>;
  const c = result.circuitBreaker as Record<string, unknown>;
  if (!bool(q.enabled) || !Number.isInteger(q.startUtc) || !Number.isInteger(q.endUtc) || (q.startUtc as number) < 0 || (q.startUtc as number) > 23 || (q.endUtc as number) < 0 || (q.endUtc as number) > 23) bad("quietHours fields are invalid");
  if (!bool(p.enabled) || typeof p.minPct !== "number" || !Number.isFinite(p.minPct) || (p.minPct as number) < 0 || !bool(d.enabled)) bad("guard fields are invalid");
  if (!bool(s.enabled) || typeof s.floor !== "number" || !Number.isFinite(s.floor) || (s.floor as number) <= 0 || (s.floor as number) >= 1 || !Number.isInteger(s.activationMinute) || (s.activationMinute as number) < 0 || (s.activationMinute as number) > 14) bad("stopLoss fields are invalid");
  if (!bool(c.enabled) || typeof c.maxDailyLoss !== "number" || !Number.isFinite(c.maxDailyLoss) || (c.maxDailyLoss as number) < 0 || !Number.isInteger(c.maxConsecutiveLosses) || (c.maxConsecutiveLosses as number) < 1) bad("circuitBreaker fields are invalid");
  if (result.liveActivation !== false) bad("liveActivation cannot be enabled by configuration");
  return Object.freeze(result as Dashboard2Config);
}

/** Parsed configs have a canonical field order, so semantic equality survives
 * independent database reads without relying on object identity. */
export function dashboard2ConfigsEquivalent(
  left: Dashboard2Config | undefined,
  right: Dashboard2Config,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** Exact CreateOrder v2 mapping: the exchange limit field is always YES price. */
export function dashboard2IocOrderFromQuote(
  quote: ExecutableBook,
  count: number,
  clientOrderId: string,
) {
  if (!Number.isInteger(count) || count < 1) throw new Error("IOC count must be a positive integer");
  // The weighted expected cost is accounting evidence only. A live IOC must
  // reach every quoted level, so cap its side cost at the most expensive level
  // consumed, conservatively rounded up to cents.
  const sideCeilingCents = Math.ceil((quote.marginalLimitCost - Number.EPSILON) * 100);
  return Object.freeze({
    ticker: quote.ticker,
    side: quote.side,
    action: "buy" as const,
    count,
    type: "limit" as const,
    timeInForce: "immediate_or_cancel" as const,
    limitPrice: quote.side === "yes"
      ? sideCeilingCents / 100
      : (100 - sideCeilingCents) / 100,
    clientOrderId,
  });
}

export function dashboard2IocSellOrderFromQuote(
  quote: ExecutableSellBook,
  count: number,
  clientOrderId: string,
) {
  if (!Number.isInteger(count) || count < 1 || count > quote.visibleContracts) {
    throw new Error("IOC sell count must be covered by exact executable depth");
  }
  const sideFloorCents = Math.floor((quote.marginalLimitProceeds + Number.EPSILON) * 100);
  return Object.freeze({
    ticker: quote.ticker,
    side: quote.side,
    action: "sell" as const,
    count,
    type: "limit" as const,
    timeInForce: "immediate_or_cancel" as const,
    // Never use weighted expected proceeds as a limit. Every quoted level is
    // marketable at the lowest consumed direct bid. Floor side proceeds to a
    // cent; for NO convert that floored proceeds value into the YES-price field.
    limitPrice: quote.side === "yes"
      ? sideFloorCents / 100
      : (100 - sideFloorCents) / 100,
    clientOrderId,
  });
}