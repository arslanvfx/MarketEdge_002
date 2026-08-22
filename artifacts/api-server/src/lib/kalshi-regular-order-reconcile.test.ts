import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeRegularHistoryRows,
  regularHistoryHasDuplicateIds,
  resolveRegularReconciliationEvidence,
  type RegularOrderReconciliationInput,
} from "./kalshi-regular-order-reconcile-core.ts";

const INPUT: RegularOrderReconciliationInput = {
  clientOrderId: "dc6b3fd0-f26c-42ca-91ba-dca7496d9c8f",
  ticker: "KXSOL15M-26AUG211830-30",
  side: "no",
  requestedCount: 4,
  submittedYesLimitPrice: 0.15,
  createdAt: new Date("2026-08-21T22:27:00.000Z"),
};

const ORDER = {
  order_id: "kalshi-order-1",
  client_order_id: INPUT.clientOrderId,
  ticker: INPUT.ticker,
  side: "no",
  action: "buy",
  status: "canceled",
  initial_count_fp: "4.00",
  fill_count_fp: "3.60",
  remaining_count_fp: "0.40",
  no_price_dollars: "0.850000",
  average_fill_price_dollars: "0.150000",
};

const FILL = {
  trade_id: "trade-1",
  order_id: "kalshi-order-1",
  ticker: INPUT.ticker,
  side: "no",
  action: "buy",
  count_fp: "3.60",
  yes_price_dollars: "0.150000",
};

test("strict reconciliation confirms an exact fractional terminal fill", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [ORDER],
    fills: [FILL],
  });
  assert.deepEqual(result, {
    outcome: "confirmed_fill",
    orderId: "kalshi-order-1",
    filledCount: 3.6,
    avgYesPrice: 0.15,
    budgetSpent: 3.06,
    orderStatus: "canceled",
    fillCount: 1,
  });
});

test("strict reconciliation confirms terminal zero-fill with no fill records", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{
      ...ORDER,
      fill_count_fp: "0.00",
      remaining_count_fp: "4.00",
      average_fill_price_dollars: undefined,
    }],
    fills: [],
  });
  assert.equal(result.outcome, "zero_fill");
});

test("strict reconciliation also accepts Kalshi's canceled-remainder-cleared form", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{ ...ORDER, remaining_count_fp: "0.00" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "confirmed_fill");
});

test("strict reconciliation accepts a fully filled terminal order only with zero remainder", () => {
  const fullFill = { ...FILL, count_fp: "4.00" };
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{
      ...ORDER,
      status: "executed",
      fill_count_fp: "4.00",
      remaining_count_fp: "0.00",
    }],
    fills: [fullFill],
  });
  assert.equal(result.outcome, "confirmed_fill");
});

test("strict reconciliation rejects a nonconserving nonzero canceled remainder", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{ ...ORDER, remaining_count_fp: "0.25" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "inconsistent_terminal_counts");
});

test("strict reconciliation rejects a duplicate exact order", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [ORDER, { ...ORDER, order_id: "kalshi-order-2" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "multiple_exact_orders");
});

test("strict reconciliation rejects non-terminal exchange evidence", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{ ...ORDER, status: "resting" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "order_not_terminal");
});

test("strict reconciliation rejects fill totals that do not equal the order", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [ORDER],
    fills: [{ ...FILL, count_fp: "3.59" }],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "fill_total_mismatch");
});

test("strict reconciliation rejects a side-price outside the submitted limit", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [ORDER],
    fills: [{ ...FILL, yes_price_dollars: "0.140000" }],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "fill_outside_submitted_limit");
});

test("strict reconciliation rejects malformed over-precision counts", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{ ...ORDER, fill_count_fp: "3.600" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "malformed_terminal_counts");
});

test("overlapping portfolio and historical fills dedupe by trade_id", () => {
  const merged = mergeRegularHistoryRows(
    [FILL, { ...FILL }],
    "fill_id",
    "trade_id",
  );
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.rows.length, 1);
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [ORDER],
    fills: merged.rows,
  });
  assert.equal(result.outcome, "confirmed_fill");
});

test("conflicting same-ID fill evidence remains ambiguous", () => {
  const merged = mergeRegularHistoryRows(
    [FILL, { ...FILL, count_fp: "3.59" }],
    "fill_id",
    "trade_id",
  );
  assert.deepEqual(merged, { ok: false, reason: "duplicate_id_conflicting_evidence" });
});

test("conflicting same-ID order evidence remains ambiguous", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [ORDER, { ...ORDER, status: "executed" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "duplicate_order_id_evidence");
});

test("duplicate IDs inside one authenticated source are rejected", () => {
  assert.equal(
    regularHistoryHasDuplicateIds([FILL, { ...FILL }], "fill_id", "trade_id"),
    true,
  );
});

test("strict reconciliation rejects terminal-order VWAP mismatch", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{ ...ORDER, average_fill_price_dollars: "0.160000" }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "order_vwap_mismatch");
});

test("strict reconciliation rejects a missing terminal-order VWAP", () => {
  const result = resolveRegularReconciliationEvidence({
    input: INPUT,
    orders: [{ ...ORDER, average_fill_price_dollars: undefined }],
    fills: [FILL],
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.reason, "missing_or_malformed_order_vwap");
});