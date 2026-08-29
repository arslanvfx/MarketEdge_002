import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import {
  fetchKalshiAuthenticatedHistoryPages,
  fetchKalshiMarketResult,
} from "./kalshi-trader.ts";
import {
  parseRegularFixedPointCount,
  regularCountHundredths,
} from "./kalshi-regular-fixed-point.ts";
import { loadOpenPositionFromDB } from "./kalshi-bot-db.ts";
import { ensureRegularOrderIntentMigrations } from "./kalshi-regular-order-intent.ts";
import {
  mergeRegularHistoryRows,
  regularHistoryHasDuplicateIds,
  regularOrderIdentityMatches,
  resolveRegularReconciliationEvidence,
  type RegularExchangeReconciliation,
  type RegularOrderReconciliationInput,
} from "./kalshi-regular-order-reconcile-core.ts";
import {
  DEFAULT_BOT_CONFIG,
  evaluateConvictionFillZone,
  getEffectiveConvictionZone,
  type BotConfig,
} from "./kalshi-bot-engine-core.ts";
export {
  resolveRegularReconciliationEvidence,
} from "./kalshi-regular-order-reconcile-core.ts";
export type {
  RegularExchangeReconciliation,
  RegularOrderReconciliationInput,
} from "./kalshi-regular-order-reconcile-core.ts";

type Direction = "yes" | "no";
type IntentStatus = "reserved" | "unknown";

interface LegacyRegularOrderReconciliationInput {
  clientOrderId: string;
  ticker: string;
  side: Direction;
  requestedCount: number;
  submittedYesLimitPrice: number;
  createdAt: Date;
}

type LegacyRegularExchangeReconciliation =
  | {
      outcome: "confirmed_fill";
      orderId: string;
      filledCount: number;
      avgYesPrice: number;
      budgetSpent: number;
      orderStatus: string;
      fillCount: number;
    }
  | {
      outcome: "zero_fill";
      orderId: string;
      orderStatus: string;
      fillCount: 0;
    }
  | {
      outcome: "ambiguous";
      reason: string;
      orderMatches?: number;
      fillMatches?: number;
    };

export interface RegularUnresolvedIntent {
  clientOrderId: string;
  status: IntentStatus;
  symbol: string;
  windowKey: string;
  ticker: string;
  side: Direction;
  requestedCount: number;
  limitPrice: number | null;
  reason: string | null;
  reconciliationReason: string | null;
  createdAt: string;
  lastReconciledAt: string | null;
}

export type RegularIntentReconciliationResult =
  | {
      outcome: "confirmed_fill";
      clientOrderId: string;
      localBetId: string;
      filledCount: number;
      avgYesPrice: number;
      budgetSpent: number;
      orderId: string;
      settledOutcome: "win" | "loss" | null;
      pnl: number | null;
    }
  | {
      outcome: "zero_fill";
      clientOrderId: string;
      orderId: string;
    }
  | {
      outcome: "ambiguous";
      clientOrderId: string;
      reason: string;
      orderMatches?: number;
      fillMatches?: number;
    };

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function countUnitsFromAliases(
  obj: Record<string, unknown>,
  fixedPointKey: string,
  legacyKey: string,
): bigint | null {
  const fixed = obj[fixedPointKey];
  const legacy = obj[legacyKey];
  const fixedUnits = fixed != null ? regularCountHundredths(fixed) : null;
  const legacyUnits = legacy != null ? regularCountHundredths(legacy) : null;
  if (fixed != null && fixedUnits == null) return null;
  if (legacy != null && legacyUnits == null) return null;
  if (fixedUnits != null && legacyUnits != null && fixedUnits !== legacyUnits) return null;
  return fixedUnits ?? legacyUnits;
}

function priceMicros(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    const scaled = value * 1_000_000;
    const units = Math.round(scaled);
    return Number.isSafeInteger(units) && Math.abs(scaled - units) <= 1e-6
      ? BigInt(units)
      : null;
  }
  if (typeof value !== "string") return null;
  const match = /^(0|1)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  const micros = whole * 1_000_000n + fraction;
  return micros <= 1_000_000n ? micros : null;
}

function centPriceMicros(value: unknown): bigint | null {
  const parsed = parseRegularFixedPointCount(value);
  if (parsed == null || parsed < 0 || parsed > 100) return null;
  const cents = regularCountHundredths(parsed);
  return cents == null ? null : cents * 100n;
}

function yesPriceMicros(obj: Record<string, unknown>): bigint | null {
  const dollars = priceMicros(obj["yes_price_dollars"]);
  const cents = centPriceMicros(obj["yes_price"]);
  if (dollars != null && cents != null && dollars !== cents) return null;
  return dollars ?? cents;
}

function noPriceMicros(obj: Record<string, unknown>): bigint | null {
  const dollars = priceMicros(obj["no_price_dollars"]);
  const cents = centPriceMicros(obj["no_price"]);
  if (dollars != null && cents != null && dollars !== cents) return null;
  return dollars ?? cents;
}

function economicYesPriceMicros(obj: Record<string, unknown>, side: Direction): bigint | null {
  const yes = yesPriceMicros(obj);
  const no = noPriceMicros(obj);
  const fromNo = no == null ? null : 1_000_000n - no;
  if (yes != null && fromNo != null && yes !== fromNo) return null;
  if (yes != null) return yes;
  if (fromNo != null) return fromNo;
  // Some history rows only carry the side-specific price.
  return side === "yes" ? yes : fromNo;
}

function averageYesPriceMicros(obj: Record<string, unknown>): bigint | null {
  const dollars = priceMicros(obj["average_fill_price_dollars"]);
  const legacy = priceMicros(obj["average_fill_price"]);
  if (dollars != null && legacy != null && dollars !== legacy) return null;
  return dollars ?? legacy;
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function terminalStatus(status: string): boolean {
  return status === "executed"
    || status === "filled"
    || status === "canceled"
    || status === "cancelled";
}

function recordIdentityMatches(
  order: Record<string, unknown>,
  input: RegularOrderReconciliationInput,
): boolean {
  if (text(order["client_order_id"]) !== input.clientOrderId) return false;
  if (text(order["ticker"]) !== input.ticker) return false;
  const side = text(order["side"]);
  if (side !== input.side) return false;
  const action = text(order["action"]);
  if (action != null && action !== "buy") return false;

  const requestedUnits = regularCountHundredths(input.requestedCount);
  const initialUnits = countUnitsFromAliases(order, "initial_count_fp", "initial_count");
  if (requestedUnits == null || initialUnits == null || requestedUnits !== initialUnits) return false;

  const submittedMicros = priceMicros(input.submittedYesLimitPrice);
  const orderPrice = economicYesPriceMicros(order, input.side);
  return submittedMicros != null && orderPrice != null && submittedMicros === orderPrice;
}

/**
 * Strictly classify authenticated order + fill history. This function is pure
 * so malformed, mismatched, duplicate, overfilled, or internally inconsistent
 * evidence can be exhaustively tested without a live Kalshi account.
 */
function resolveRegularReconciliationEvidenceLegacy(args: {
  input: LegacyRegularOrderReconciliationInput;
  orders: unknown[];
  fills: unknown[];
}): LegacyRegularExchangeReconciliation {
  const inputUnits = regularCountHundredths(args.input.requestedCount);
  const submittedLimit = priceMicros(args.input.submittedYesLimitPrice);
  if (inputUnits == null || inputUnits <= 0n || submittedLimit == null) {
    return { outcome: "ambiguous", reason: "invalid_durable_intent" };
  }

  const matchingOrders = new Map<string, Record<string, unknown>>();
  for (const raw of args.orders) {
    const order = asObject(raw);
    if (!order || !recordIdentityMatches(order, args.input)) continue;
    const orderId = text(order["order_id"]);
    if (!orderId) return { outcome: "ambiguous", reason: "matching_order_missing_id" };
    matchingOrders.set(orderId, order);
  }
  if (matchingOrders.size !== 1) {
    return {
      outcome: "ambiguous",
      reason: matchingOrders.size === 0 ? "exact_order_not_found" : "multiple_exact_orders",
      orderMatches: matchingOrders.size,
    };
  }

  const [orderId, order] = matchingOrders.entries().next().value as [string, Record<string, unknown>];
  const status = normalizeStatus(order["status"]);
  if (!terminalStatus(status)) {
    return { outcome: "ambiguous", reason: "order_not_terminal", orderMatches: 1 };
  }
  const filledUnits = countUnitsFromAliases(order, "fill_count_fp", "fill_count");
  const remainingUnits = countUnitsFromAliases(order, "remaining_count_fp", "remaining_count");
  if (filledUnits == null || remainingUnits == null) {
    return { outcome: "ambiguous", reason: "malformed_terminal_counts", orderMatches: 1 };
  }
  if (filledUnits > inputUnits || remainingUnits !== 0n) {
    return { outcome: "ambiguous", reason: "inconsistent_terminal_counts", orderMatches: 1 };
  }

  const matchingFills: Array<{ units: bigint; yesMicros: bigint }> = [];
  for (const raw of args.fills) {
    const fill = asObject(raw);
    if (!fill || text(fill["order_id"]) !== orderId) continue;
    if (text(fill["ticker"]) !== args.input.ticker) {
      return { outcome: "ambiguous", reason: "fill_ticker_mismatch", orderMatches: 1 };
    }
    const side = text(fill["side"]);
    if (side != null && side !== args.input.side) {
      return { outcome: "ambiguous", reason: "fill_side_mismatch", orderMatches: 1 };
    }
    const action = text(fill["action"]);
    if (action != null && action !== "buy") {
      return { outcome: "ambiguous", reason: "fill_action_mismatch", orderMatches: 1 };
    }
    const units = countUnitsFromAliases(fill, "count_fp", "count");
    const price = economicYesPriceMicros(fill, args.input.side);
    if (units == null || units <= 0n || price == null) {
      return { outcome: "ambiguous", reason: "malformed_fill_record", orderMatches: 1 };
    }
    const crossesLimit = args.input.side === "yes"
      ? price <= submittedLimit
      : price >= submittedLimit;
    if (!crossesLimit) {
      return { outcome: "ambiguous", reason: "fill_outside_submitted_limit", orderMatches: 1 };
    }
    matchingFills.push({ units, yesMicros: price });
  }

  if (filledUnits === 0n) {
    if (matchingFills.length !== 0) {
      return { outcome: "ambiguous", reason: "zero_fill_order_has_fills", orderMatches: 1 };
    }
    return { outcome: "zero_fill", orderId, orderStatus: status, fillCount: 0 };
  }

  if (matchingFills.length === 0) {
    return { outcome: "ambiguous", reason: "positive_order_missing_fills", orderMatches: 1, fillMatches: 0 };
  }
  const summedUnits = matchingFills.reduce((sum, fill) => sum + fill.units, 0n);
  if (summedUnits !== filledUnits) {
    return {
      outcome: "ambiguous",
      reason: "fill_total_mismatch",
      orderMatches: 1,
      fillMatches: matchingFills.length,
    };
  }
  const weightedMicros = matchingFills.reduce(
    (sum, fill) => sum + fill.yesMicros * fill.units,
    0n,
  );
  // Kalshi publishes average fill price at micro-dollar precision. Round the
  // exact weighted fill evidence half-up to that same precision.
  const avgYesMicros = (weightedMicros + filledUnits / 2n) / filledUnits;
  const orderAvg = averageYesPriceMicros(order);
  if (orderAvg == null || orderAvg !== avgYesMicros) {
    return { outcome: "ambiguous", reason: "order_vwap_mismatch", orderMatches: 1, fillMatches: matchingFills.length };
  }
  const filledCount = Number(filledUnits) / 100;
  return {
    outcome: "confirmed_fill",
    orderId,
    filledCount,
    avgYesPrice: Number(avgYesMicros) / 1_000_000,
    budgetSpent: Number(
      args.input.side === "yes" ? weightedMicros : 1_000_000n * filledUnits - weightedMicros,
    ) / 100_000_000,
    orderStatus: status,
    fillCount: matchingFills.length,
  };
}

export async function reconcileRegularOrderStrict(
  input: RegularOrderReconciliationInput,
): Promise<RegularExchangeReconciliation> {
  // Search every paginated order for this exact market. The durable client ID
  // plus full economic identity provides uniqueness; omitting a time cutoff
  // keeps recovery possible days or months after an outage.
  const orderParams = { ticker: input.ticker };
  const [portfolioOrders, historicalOrders] = await Promise.all([
    fetchKalshiAuthenticatedHistoryPages("/portfolio/orders", orderParams, "orders"),
    fetchKalshiAuthenticatedHistoryPages("/historical/orders", orderParams, "orders"),
  ]);
  const portfolioCandidates = portfolioOrders.filter((order) => regularOrderIdentityMatches(order, input));
  const historicalCandidates = historicalOrders.filter((order) => regularOrderIdentityMatches(order, input));
  if (
    regularHistoryHasDuplicateIds(portfolioCandidates, "order_id")
    || regularHistoryHasDuplicateIds(historicalCandidates, "order_id")
  ) {
    return { outcome: "ambiguous", reason: "duplicate_order_id_within_history_source" };
  }
  const candidateOrders = [...portfolioCandidates, ...historicalCandidates];
  const mergedOrders = mergeRegularHistoryRows(
    candidateOrders,
    "order_id",
  );
  if (!mergedOrders.ok) {
    return { outcome: "ambiguous", reason: "conflicting_duplicate_order_evidence" };
  }
  const orders = mergedOrders.rows;
  const exactOrderIds = new Set(
    orders
      .filter((order) => regularOrderIdentityMatches(order, input))
      .map((order) => text(order["order_id"]))
      .filter((id): id is string => id != null),
  );
  if (exactOrderIds.size !== 1) {
    return resolveRegularReconciliationEvidence({ input, orders, fills: [] });
  }
  const fillParams = { order_id: [...exactOrderIds][0] };
  const [portfolioFills, historicalFills] = await Promise.all([
    fetchKalshiAuthenticatedHistoryPages("/portfolio/fills", fillParams, "fills"),
    fetchKalshiAuthenticatedHistoryPages("/historical/fills", fillParams, "fills"),
  ]);
  if (
    regularHistoryHasDuplicateIds(portfolioFills, "fill_id", "trade_id")
    || regularHistoryHasDuplicateIds(historicalFills, "fill_id", "trade_id")
  ) {
    return {
      outcome: "ambiguous",
      reason: "duplicate_fill_id_within_history_source",
      orderMatches: 1,
    };
  }
  const mergedFills = mergeRegularHistoryRows(
    [...portfolioFills, ...historicalFills],
    "fill_id",
    "trade_id",
  );
  if (!mergedFills.ok) {
    return {
      outcome: "ambiguous",
      reason: "conflicting_duplicate_fill_evidence",
      orderMatches: 1,
    };
  }
  return resolveRegularReconciliationEvidence({
    input,
    orders,
    fills: mergedFills.rows,
  });
}

export async function listUnresolvedRegularIntents(limit = 50): Promise<RegularUnresolvedIntent[]> {
  await ensureRegularOrderIntentMigrations();
  const result = await pool.query<{
    client_order_id: string;
    status: IntentStatus;
    symbol: string;
    window_key: string;
    ticker: string;
    side: Direction;
    requested_count: string;
    limit_price: string | null;
    reason: string | null;
    reconciliation_reason: string | null;
    created_at: Date;
    last_reconciled_at: Date | null;
  }>(
    `SELECT client_order_id, status, symbol, window_key, ticker, side,
            requested_count, limit_price, reason, reconciliation_reason,
            created_at, last_reconciled_at
       FROM kalshi_regular_order_intents
      WHERE mode = 'live' AND status IN ('reserved','unknown')
      ORDER BY created_at ASC
      LIMIT $1`,
    [Math.max(1, Math.min(200, Math.floor(limit)))],
  );
  return result.rows.map((row) => ({
    clientOrderId: row.client_order_id,
    status: row.status,
    symbol: row.symbol,
    windowKey: row.window_key,
    ticker: row.ticker,
    side: row.side,
    requestedCount: Number(row.requested_count),
    limitPrice: row.limit_price == null ? null : Number(row.limit_price),
    reason: row.reason,
    reconciliationReason: row.reconciliation_reason,
    createdAt: row.created_at.toISOString(),
    lastReconciledAt: row.last_reconciled_at?.toISOString() ?? null,
  }));
}

async function readIntent(clientOrderId: string): Promise<(RegularOrderReconciliationInput & {
  status: IntentStatus;
  symbol: string;
  windowKey: string;
  reason: string | null;
  authorizationDecisionMode: string | null;
  authorizationConvictionFloor: number | null;
  authorizationConvictionCap: number | null;
}) | null> {
  await ensureRegularOrderIntentMigrations();
  const result = await pool.query<{
    client_order_id: string;
    status: IntentStatus;
    symbol: string;
    window_key: string;
    ticker: string;
    side: Direction;
    requested_count: string;
    limit_price: string | null;
    reason: string | null;
    authorization_decision_mode: string | null;
    authorization_conviction_floor: string | null;
    authorization_conviction_cap: string | null;
    created_at: Date;
  }>(
    `SELECT client_order_id, status, symbol, window_key, ticker, side,
             requested_count, limit_price, reason,
             authorization_decision_mode, authorization_conviction_floor,
             authorization_conviction_cap, created_at
       FROM kalshi_regular_order_intents
      WHERE client_order_id = $1
        AND mode = 'live'
        AND status IN ('reserved','unknown')`,
    [clientOrderId],
  );
  const row = result.rows[0];
  if (!row || row.limit_price == null) return null;
  return {
    clientOrderId: row.client_order_id,
    status: row.status,
    symbol: row.symbol,
    windowKey: row.window_key,
    ticker: row.ticker,
    side: row.side,
    requestedCount: Number(row.requested_count),
    submittedYesLimitPrice: Number(row.limit_price),
    reason: row.reason,
    authorizationDecisionMode: row.authorization_decision_mode,
    authorizationConvictionFloor: row.authorization_conviction_floor == null
      ? null : Number(row.authorization_conviction_floor),
    authorizationConvictionCap: row.authorization_conviction_cap == null
      ? null : Number(row.authorization_conviction_cap),
    createdAt: row.created_at,
  };
}

async function persistAmbiguity(clientOrderId: string, evidence: RegularExchangeReconciliation): Promise<void> {
  const reason = evidence.outcome === "ambiguous" ? evidence.reason : "unexpected_reconciliation_state";
  await pool.query(
    `UPDATE kalshi_regular_order_intents
        SET reconciliation_reason = $2,
            reconciliation_evidence = $3::jsonb,
            last_reconciled_at = NOW()
      WHERE client_order_id = $1
        AND status IN ('reserved','unknown')`,
    [clientOrderId, reason, JSON.stringify(evidence)],
  );
}

function deterministicRecoveredBetId(clientOrderId: string): string {
  return `regular-recovered:${clientOrderId}`;
}

function windowHasClosed(windowKey: string, now = Date.now()): boolean {
  const openMs = Date.parse(`${windowKey}:00Z`);
  return Number.isFinite(openMs) && openMs + 15 * 60_000 <= now;
}

export async function reconcileRegularIntent(
  clientOrderId: string,
): Promise<RegularIntentReconciliationResult> {
  const intent = await readIntent(clientOrderId);
  if (!intent) {
    return { outcome: "ambiguous", clientOrderId, reason: "unresolved_intent_not_found_or_missing_limit" };
  }

  let evidence: RegularExchangeReconciliation;
  try {
    evidence = await reconcileRegularOrderStrict(intent);
  } catch (error) {
    evidence = {
      outcome: "ambiguous",
      reason: `exchange_lookup_failed:${String((error as Error)?.message ?? error).slice(0, 240)}`,
    };
  }
  if (evidence.outcome === "ambiguous") {
    await persistAmbiguity(clientOrderId, evidence);
    return { ...evidence, clientOrderId };
  }

  if (evidence.outcome === "zero_fill") {
    await pool.query(
      `UPDATE kalshi_regular_order_intents
          SET status = 'zero_fill', filled_count = 0, order_id = $2,
              reconciliation_reason = 'authoritative_zero_fill',
              reconciliation_evidence = $3::jsonb,
              last_reconciled_at = NOW(), resolved_at = NOW()
        WHERE client_order_id = $1
          AND status IN ('reserved','unknown')`,
      [clientOrderId, evidence.orderId, JSON.stringify(evidence)],
    );
    return { outcome: "zero_fill", clientOrderId, orderId: evidence.orderId };
  }

  const market = await fetchKalshiMarketResult(intent.ticker).catch(() => null);
  const closed = windowHasClosed(intent.windowKey);
  const target = market?.floorStrike ?? null;
  if (!closed && target == null) {
    const ambiguous: RegularExchangeReconciliation = {
      outcome: "ambiguous",
      reason: "active_fill_target_unavailable",
    };
    await persistAmbiguity(clientOrderId, ambiguous);
    return { outcome: "ambiguous", clientOrderId, reason: ambiguous.reason };
  }

  const settledResult = market?.result === "yes" || market?.result === "no" ? market.result : null;
  const won = settledResult == null ? null : intent.side === settledResult;
  const settledOutcome = won == null ? null : won ? "win" : "loss";
  const pnl = won == null
    ? null
    : won
      ? (intent.side === "yes" ? (1 - evidence.avgYesPrice) : evidence.avgYesPrice) * evidence.filledCount
      : -(intent.side === "yes" ? evidence.avgYesPrice : (1 - evidence.avgYesPrice)) * evidence.filledCount;
  const localBetId = deterministicRecoveredBetId(clientOrderId);
  const entryPrice = evidence.avgYesPrice.toFixed(8);
  const count = evidence.filledCount.toFixed(2);
  const betAmount = evidence.budgetSpent.toFixed(8);
  const pnlText = pnl == null ? null : pnl.toFixed(8);
  let recoveredOutOfBandFill: Record<string, unknown> | null = null;
  try {
    let decisionMode = intent.authorizationDecisionMode;
    let convictionFloor = intent.authorizationConvictionFloor;
    let convictionCap = intent.authorizationConvictionCap;
    // Legacy unresolved intents created before immutable authorization metadata
    // was introduced have no snapshot. Only those rows use current config as a
    // conservative migration fallback.
    if (decisionMode == null) {
      const configResult = await pool.query<{ config: Record<string, unknown> }>(
        `SELECT config FROM bot_config WHERE id = 'default' LIMIT 1`,
      );
      const config = {
        ...DEFAULT_BOT_CONFIG,
        ...(configResult.rows[0]?.config ?? {}),
      } as BotConfig;
      decisionMode = config.decisionMode;
      if (decisionMode === "conviction") {
        const effectiveZone = getEffectiveConvictionZone(intent.symbol, config);
        convictionFloor = effectiveZone.lockPrice;
        convictionCap = effectiveZone.lockPriceCap;
      }
    }
    if (
      decisionMode === "conviction"
      && convictionFloor != null
      && convictionCap != null
    ) {
      const fillZone = evaluateConvictionFillZone(
        intent.side,
        evidence.avgYesPrice,
        convictionFloor,
        convictionCap,
      );
      if (!fillZone.allowed && fillZone.sideCost != null && fillZone.reason !== "invalid") {
        recoveredOutOfBandFill = {
          sideCost: fillZone.sideCost,
          reason: fillZone.reason,
          lockPrice: convictionFloor,
          lockPriceCap: convictionCap,
        };
      }
    }
  } catch (error) {
    logger.error(
      { error, clientOrderId, symbol: intent.symbol },
      "[regular-reconcile] fill-zone recovery check failed — retaining ambiguity",
    );
    await persistAmbiguity(clientOrderId, {
      outcome: "ambiguous",
      reason: "fill_zone_recovery_check_failed",
    });
    return { outcome: "ambiguous", clientOrderId, reason: "fill_zone_recovery_check_failed" };
  }
  const signals = JSON.stringify({
    recoveredFromExchange: true,
    clientOrderId,
    orderId: evidence.orderId,
    fillRecords: evidence.fillCount,
    convictionOutOfBandFill: recoveredOutOfBandFill != null,
    convictionOutOfBandFillDetails: recoveredOutOfBandFill,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM kalshi_regular_order_intents
        WHERE client_order_id = $1 FOR UPDATE`,
      [clientOrderId],
    );
    if (!locked.rows[0] || !["reserved", "unknown"].includes(locked.rows[0].status)) {
      await client.query("ROLLBACK");
      return { outcome: "ambiguous", clientOrderId, reason: "intent_changed_during_reconciliation" };
    }

    const exactLocal = await client.query<{ id: string }>(
      `SELECT id
         FROM kalshi_bot_bets
        WHERE mode = 'live'
          AND source = 'bot'
          AND symbol = $1
          AND window_key = $2
          AND ticker = $3
          AND direction = $4
          AND contract_count = $5::numeric
          AND entry_price = $6::numeric
          AND created_at BETWEEN $7::timestamptz - INTERVAL '10 seconds'
                             AND $7::timestamptz + INTERVAL '2 minutes'
        ORDER BY created_at ASC`,
      [intent.symbol, intent.windowKey, intent.ticker, intent.side, count, entryPrice, intent.createdAt],
    );
    if (exactLocal.rows.length > 1) {
      await client.query(
        `UPDATE kalshi_regular_order_intents
            SET reconciliation_reason = 'multiple_exact_local_bets',
                reconciliation_evidence = $2::jsonb,
                last_reconciled_at = NOW()
          WHERE client_order_id = $1`,
        [clientOrderId, JSON.stringify(evidence)],
      );
      await client.query("COMMIT");
      return { outcome: "ambiguous", clientOrderId, reason: "multiple_exact_local_bets" };
    }
    const persistedBetId = exactLocal.rows[0]?.id ?? localBetId;
    if (exactLocal.rows.length === 1 && recoveredOutOfBandFill != null) {
      await client.query(
        `UPDATE kalshi_bot_bets
            SET signals = COALESCE(signals, '{}'::jsonb) ||
              jsonb_build_object(
                'convictionOutOfBandFill', true,
                'convictionOutOfBandFillDetails', $2::jsonb
              ),
                entry_yes_price = entry_price,
                decision_mode = COALESCE(decision_mode, 'conviction')
          WHERE id = $1`,
        [persistedBetId, JSON.stringify(recoveredOutOfBandFill)],
      );
    }
    if (exactLocal.rows.length === 0) {
      await client.query(
        `INSERT INTO kalshi_bot_bets
          (id, symbol, window_key, ticker, direction, action, mode, source,
           signals, entry_price, contract_count, bet_amount, pnl, outcome,
           evaluated_at, exited_at, kalshi_target, entry_yes_price,
           decision_mode, created_at)
         VALUES
          ($1,$2,$3,$4,$5,$6,'live','bot',$7::jsonb,$8::numeric,$9::numeric,
            $10::numeric,$11::numeric,$12,$13,$14,$15::numeric,$8::numeric,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [
          persistedBetId,
          intent.symbol,
          intent.windowKey,
          intent.ticker,
          intent.side,
          closed ? "expired" : "bet",
          signals,
          entryPrice,
          count,
          betAmount,
          pnlText,
          settledOutcome,
          settledOutcome == null ? null : new Date(),
          closed ? new Date() : null,
          target == null ? null : String(target),
          recoveredOutOfBandFill == null ? null : "conviction",
          intent.createdAt,
        ],
      );
    }
    await client.query(
      `UPDATE kalshi_regular_order_intents
          SET status = 'filled',
              filled_count = $2::numeric,
              avg_fill_price = $3::numeric,
              order_id = $4,
              reconciliation_reason = 'authoritative_confirmed_fill',
              reconciliation_evidence = $5::jsonb,
              last_reconciled_at = NOW(),
              resolved_at = NOW()
        WHERE client_order_id = $1`,
      [clientOrderId, count, entryPrice, evidence.orderId, JSON.stringify(evidence)],
    );
    await client.query("COMMIT");

    if (!closed) {
      await loadOpenPositionFromDB().catch((error) => {
        logger.error({ error, clientOrderId }, "[regular-reconcile] failed to hydrate recovered active position");
      });
    }
    logger.warn(
      {
        clientOrderId,
        orderId: evidence.orderId,
        symbol: intent.symbol,
        windowKey: intent.windowKey,
        filledCount: evidence.filledCount,
        avgYesPrice: evidence.avgYesPrice,
        localBetId: persistedBetId,
      },
      "[regular-reconcile] recovered authoritative Kalshi fill",
    );
    return {
      outcome: "confirmed_fill",
      clientOrderId,
      localBetId: persistedBetId,
      filledCount: evidence.filledCount,
      avgYesPrice: evidence.avgYesPrice,
      budgetSpent: evidence.budgetSpent,
      orderId: evidence.orderId,
      settledOutcome,
      pnl,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let automaticPass: Promise<{
  checked: number;
  filled: number;
  zeroFill: number;
  ambiguous: number;
}> | null = null;

export async function runRegularIntentReconciliationPass(opts: {
  minAgeMs?: number;
  limit?: number;
} = {}): Promise<{ checked: number; filled: number; zeroFill: number; ambiguous: number }> {
  if (automaticPass) return automaticPass;
  automaticPass = (async () => {
    const minAgeMs = opts.minAgeMs ?? 30_000;
    const intents = (await listUnresolvedRegularIntents(opts.limit ?? 20))
      .filter((intent) => Date.now() - Date.parse(intent.createdAt) >= minAgeMs);
    const summary = { checked: 0, filled: 0, zeroFill: 0, ambiguous: 0 };
    for (const intent of intents) {
      summary.checked++;
      const result = await reconcileRegularIntent(intent.clientOrderId);
      if (result.outcome === "confirmed_fill") summary.filled++;
      else if (result.outcome === "zero_fill") summary.zeroFill++;
      else summary.ambiguous++;
    }
    return summary;
  })();
  try {
    return await automaticPass;
  } finally {
    automaticPass = null;
  }
}

export function isValidRegularClientOrderId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 100
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function makeRegularClientOrderId(): string {
  return crypto.randomUUID();
}