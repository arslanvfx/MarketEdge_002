import {
  parseRegularFixedPointCount,
  regularCountHundredths,
} from "./kalshi-regular-fixed-point.ts";

export type RegularDirection = "yes" | "no";

export interface RegularOrderReconciliationInput {
  clientOrderId: string;
  ticker: string;
  side: RegularDirection;
  requestedCount: number;
  submittedYesLimitPrice: number;
  createdAt: Date;
}

export type RegularExchangeReconciliation =
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

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type RegularHistoryMerge =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; reason: "duplicate_id_conflicting_evidence" };

export function regularHistoryHasDuplicateIds(
  rows: Array<Record<string, unknown>>,
  ...idKeys: string[]
): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const ids = idKeys.map((key) => text(row[key])).filter((id): id is string => id != null);
    if (ids.some((id) => seen.has(id))) return true;
    for (const id of ids) seen.add(id);
  }
  return false;
}

function sameExchangeValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function mergeRegularHistoryRows(
  rows: Array<Record<string, unknown>>,
  ...idKeys: string[]
): RegularHistoryMerge {
  const out: Array<Record<string, unknown>> = [];
  const indexById = new Map<string, number>();
  for (const row of rows) {
    const ids = idKeys.map((key) => text(row[key])).filter((id): id is string => id != null);
    if (ids.length === 0) {
      out.push(row);
      continue;
    }
    const existingIndexes = new Set(
      ids.map((id) => indexById.get(id)).filter((index): index is number => index != null),
    );
    if (existingIndexes.size > 1) {
      return { ok: false, reason: "duplicate_id_conflicting_evidence" };
    }
    const existingIndex = existingIndexes.values().next().value as number | undefined;
    if (existingIndex == null) {
      const nextIndex = out.length;
      out.push({ ...row });
      for (const id of ids) indexById.set(id, nextIndex);
      continue;
    }
    const existing = out[existingIndex]!;
    for (const [key, value] of Object.entries(row)) {
      const prior = existing[key];
      if (prior != null && value != null && !sameExchangeValue(prior, value)) {
        return { ok: false, reason: "duplicate_id_conflicting_evidence" };
      }
    }
    out[existingIndex] = { ...existing, ...row };
    for (const id of ids) indexById.set(id, existingIndex);
  }
  return { ok: true, rows: out };
}

function countAliases(
  row: Record<string, unknown>,
  fixedPointKey: string,
  legacyKey: string,
): bigint | null {
  const fixedRaw = row[fixedPointKey];
  const legacyRaw = row[legacyKey];
  const fixed = fixedRaw == null ? null : regularCountHundredths(fixedRaw);
  const legacy = legacyRaw == null ? null : regularCountHundredths(legacyRaw);
  if (fixedRaw != null && fixed == null) return null;
  if (legacyRaw != null && legacy == null) return null;
  if (fixed != null && legacy != null && fixed !== legacy) return null;
  return fixed ?? legacy;
}

function dollarMicros(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    const scaled = value * 1_000_000;
    const rounded = Math.round(scaled);
    return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= 1e-6
      ? BigInt(rounded)
      : null;
  }
  if (typeof value !== "string") return null;
  const match = /^(0|1)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const micros = BigInt(match[1]!) * 1_000_000n
    + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return micros <= 1_000_000n ? micros : null;
}

function centMicros(value: unknown): bigint | null {
  const cents = parseRegularFixedPointCount(value);
  if (cents == null || cents < 0 || cents > 100) return null;
  const centiCents = regularCountHundredths(cents);
  return centiCents == null ? null : centiCents * 100n;
}

function priceAlias(
  row: Record<string, unknown>,
  dollarsKey: string,
  centsKey: string,
): bigint | null {
  const dollarsRaw = row[dollarsKey];
  const centsRaw = row[centsKey];
  const dollars = dollarsRaw == null ? null : dollarMicros(dollarsRaw);
  const cents = centsRaw == null ? null : centMicros(centsRaw);
  if (dollarsRaw != null && dollars == null) return null;
  if (centsRaw != null && cents == null) return null;
  if (dollars != null && cents != null && dollars !== cents) return null;
  return dollars ?? cents;
}

function yesPrice(row: Record<string, unknown>): bigint | null {
  const yes = priceAlias(row, "yes_price_dollars", "yes_price");
  const no = priceAlias(row, "no_price_dollars", "no_price");
  const complement = no == null ? null : 1_000_000n - no;
  if (yes != null && complement != null && yes !== complement) return null;
  return yes ?? complement;
}

function averageYesPrice(row: Record<string, unknown>): bigint | null {
  const modernRaw = row["average_fill_price_dollars"];
  const legacyRaw = row["average_fill_price"];
  const modern = modernRaw == null ? null : dollarMicros(modernRaw);
  const legacy = legacyRaw == null ? null : dollarMicros(legacyRaw);
  if (modernRaw != null && modern == null) return null;
  if (legacyRaw != null && legacy == null) return null;
  if (modern != null && legacy != null && modern !== legacy) return null;
  return modern ?? legacy;
}

export function regularOrderIdentityMatches(
  order: Record<string, unknown>,
  input: RegularOrderReconciliationInput,
): boolean {
  if (text(order["client_order_id"]) !== input.clientOrderId) return false;
  if (text(order["ticker"]) !== input.ticker) return false;
  const directSide = text(order["side"]);
  const outcomeSide = text(order["outcome_side"]);
  const bookSide = text(order["book_side"]);
  const expectedBookSide = input.side === "yes" ? "bid" : "ask";
  if (directSide != null && directSide !== input.side) return false;
  if (outcomeSide != null && outcomeSide !== input.side) return false;
  if (bookSide != null && bookSide !== expectedBookSide) return false;
  if (directSide == null && outcomeSide == null && bookSide == null) return false;
  const action = text(order["action"]);
  if (action != null && action !== "buy") return false;
  const requested = regularCountHundredths(input.requestedCount);
  const initial = countAliases(order, "initial_count_fp", "initial_count");
  if (requested == null || initial == null || requested !== initial) return false;
  const submitted = dollarMicros(input.submittedYesLimitPrice);
  const orderLimit = yesPrice(order);
  return submitted != null && orderLimit != null && submitted === orderLimit;
}

function terminal(status: string): boolean {
  return ["executed", "filled", "canceled", "cancelled"].includes(status);
}

export function resolveRegularReconciliationEvidence(args: {
  input: RegularOrderReconciliationInput;
  orders: unknown[];
  fills: unknown[];
}): RegularExchangeReconciliation {
  const requested = regularCountHundredths(args.input.requestedCount);
  const submitted = dollarMicros(args.input.submittedYesLimitPrice);
  if (requested == null || requested <= 0n || submitted == null) {
    return { outcome: "ambiguous", reason: "invalid_durable_intent" };
  }

  const rawMatches: Record<string, unknown>[] = [];
  for (const raw of args.orders) {
    const order = object(raw);
    if (!order || !regularOrderIdentityMatches(order, args.input)) continue;
    const id = text(order["order_id"]);
    if (!id) return { outcome: "ambiguous", reason: "matching_order_missing_id" };
    rawMatches.push(order);
  }
  if (regularHistoryHasDuplicateIds(rawMatches, "order_id")) {
    return { outcome: "ambiguous", reason: "duplicate_order_id_evidence" };
  }
  const mergedMatches = mergeRegularHistoryRows(rawMatches, "order_id");
  if (!mergedMatches.ok) {
    return { outcome: "ambiguous", reason: "conflicting_duplicate_order_evidence" };
  }
  const matches = new Map(
    mergedMatches.rows.map((order) => [text(order["order_id"])!, order] as const),
  );
  if (matches.size !== 1) {
    return {
      outcome: "ambiguous",
      reason: matches.size === 0 ? "exact_order_not_found" : "multiple_exact_orders",
      orderMatches: matches.size,
    };
  }

  const [orderId, order] = matches.entries().next().value as [string, Record<string, unknown>];
  const status = String(order["status"] ?? "").trim().toLowerCase();
  if (!terminal(status)) {
    return { outcome: "ambiguous", reason: "order_not_terminal", orderMatches: 1 };
  }
  const filled = countAliases(order, "fill_count_fp", "fill_count");
  const remaining = countAliases(order, "remaining_count_fp", "remaining_count");
  if (filled == null || remaining == null) {
    return { outcome: "ambiguous", reason: "malformed_terminal_counts", orderMatches: 1 };
  }
  const isFilledStatus = status === "executed" || status === "filled";
  const terminalAccountingIsValid = isFilledStatus
    ? filled === requested && remaining === 0n
    : filled <= requested && (
        // Some Kalshi historical rows preserve the canceled IOC remainder.
        filled + remaining === requested
        // Other authenticated rows clear remaining_count after cancellation.
        || remaining === 0n
      );
  if (!terminalAccountingIsValid) {
    return { outcome: "ambiguous", reason: "inconsistent_terminal_counts", orderMatches: 1 };
  }

  const fillEvidence: Array<{ count: bigint; price: bigint }> = [];
  const fillIds = new Set<string>();
  for (const raw of args.fills) {
    const fill = object(raw);
    if (!fill || text(fill["order_id"]) !== orderId) continue;
    if (text(fill["ticker"]) !== args.input.ticker) {
      return { outcome: "ambiguous", reason: "fill_ticker_mismatch", orderMatches: 1 };
    }
    const fillId = text(fill["fill_id"]) ?? text(fill["trade_id"]);
    if (!fillId || fillIds.has(fillId)) {
      return { outcome: "ambiguous", reason: "invalid_or_duplicate_fill_id", orderMatches: 1 };
    }
    fillIds.add(fillId);
    const side = text(fill["side"]) ?? text(fill["outcome_side"]);
    const bookSide = text(fill["book_side"]);
    const expectedBookSide = args.input.side === "yes" ? "bid" : "ask";
    if ((side != null && side !== args.input.side) || (bookSide != null && bookSide !== expectedBookSide)) {
      return { outcome: "ambiguous", reason: "fill_side_mismatch", orderMatches: 1 };
    }
    if (side == null && bookSide == null) {
      return { outcome: "ambiguous", reason: "fill_side_missing", orderMatches: 1 };
    }
    const action = text(fill["action"]);
    if (action != null && action !== "buy") {
      return { outcome: "ambiguous", reason: "fill_action_mismatch", orderMatches: 1 };
    }
    const count = countAliases(fill, "count_fp", "count");
    const price = yesPrice(fill);
    if (count == null || count <= 0n || price == null) {
      return { outcome: "ambiguous", reason: "malformed_fill_record", orderMatches: 1 };
    }
    const crossesLimit = args.input.side === "yes" ? price <= submitted : price >= submitted;
    if (!crossesLimit) {
      return { outcome: "ambiguous", reason: "fill_outside_submitted_limit", orderMatches: 1 };
    }
    fillEvidence.push({ count, price });
  }

  if (filled === 0n) {
    return fillEvidence.length === 0
      ? { outcome: "zero_fill", orderId, orderStatus: status, fillCount: 0 }
      : { outcome: "ambiguous", reason: "zero_fill_order_has_fills", orderMatches: 1 };
  }
  if (fillEvidence.length === 0) {
    return { outcome: "ambiguous", reason: "positive_order_missing_fills", orderMatches: 1, fillMatches: 0 };
  }
  const total = fillEvidence.reduce((sum, item) => sum + item.count, 0n);
  if (total !== filled) {
    return { outcome: "ambiguous", reason: "fill_total_mismatch", orderMatches: 1, fillMatches: fillEvidence.length };
  }
  const weighted = fillEvidence.reduce((sum, item) => sum + item.count * item.price, 0n);
  const average = (weighted + filled / 2n) / filled;
  const reportedAverage = averageYesPrice(order);
  if (reportedAverage == null) {
    return {
      outcome: "ambiguous",
      reason: "missing_or_malformed_order_vwap",
      orderMatches: 1,
      fillMatches: fillEvidence.length,
    };
  }
  if (reportedAverage !== average) {
    return {
      outcome: "ambiguous",
      reason: "order_vwap_mismatch",
      orderMatches: 1,
      fillMatches: fillEvidence.length,
    };
  }
  return {
    outcome: "confirmed_fill",
    orderId,
    filledCount: Number(filled) / 100,
    avgYesPrice: Number(average) / 1_000_000,
    budgetSpent: Number(
      args.input.side === "yes" ? weighted : 1_000_000n * filled - weighted,
    ) / 100_000_000,
    orderStatus: status,
    fillCount: fillEvidence.length,
  };
}