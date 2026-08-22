import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveScalpReconciliationEvidence,
  type ScalpReconciliationInput,
} from "./kalshi-scalper-exchange.ts";
import { classifyScalpFillAgainstBand } from "./kalshi-scalper-policy.ts";

const createdAt = new Date("2026-08-21T15:58:45.763Z");

function input(overrides: Partial<ScalpReconciliationInput> = {}): ScalpReconciliationInput {
  return {
    ticker: "KXGOLD15M-26AUG211200-00",
    side: "yes",
    count: 2,
    limitPrice: 0.94,
    clientOrderId: "client-gold-3",
    exchangeOrderId: null,
    createdAt,
    excludeExchangeOrderIds: [],
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: "order-gold-3",
    client_order_id: "client-gold-3",
    ticker: "KXGOLD15M-26AUG211200-00",
    outcome_side: "yes",
    book_side: "bid",
    yes_price_dollars: "0.940000",
    initial_count_fp: "2.00",
    fill_count_fp: "0.00",
    // Kalshi reports zero remaining after canceling an IOC remainder, even
    // when the order filled zero of the initial quantity.
    remaining_count_fp: "0.00",
    status: "canceled",
    created_time: "2026-08-21T15:58:45.900Z",
    ...overrides,
  };
}

describe("resolveScalpReconciliationEvidence", () => {
  it("resolves one terminal IOC order with authoritative zero fill", () => {
    const result = resolveScalpReconciliationEvidence(input(), [order()], []);
    assert.equal(result.outcome, "zero_fill");
    if (result.outcome !== "zero_fill") return;
    assert.equal(result.orderId, "order-gold-3");
    assert.equal(result.filledCount, 0);
  });

  it("reconstructs fractional fills and YES-side VWAP exactly", () => {
    const fills = [
      {
        fill_id: "fill-1",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "0.50",
        yes_price_dollars: "0.930000",
      },
      {
        fill_id: "fill-2",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "1.25",
        yes_price_dollars: "0.940000",
      },
    ];
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ status: "canceled", fill_count_fp: "1.75", remaining_count_fp: "0.00" })],
      fills,
    );
    assert.equal(result.outcome, "confirmed_fill");
    if (result.outcome !== "confirmed_fill") return;
    assert.equal(result.filledCount, 1.75);
    assert.equal(result.avgFillPrice, 0.9371428571428572);
    assert.equal(result.budgetSpent, 1.64);
  });

  it("keeps partial or incomplete fill evidence ambiguous", () => {
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ status: "canceled", fill_count_fp: "1.50", remaining_count_fp: "0.00" })],
      [{
        fill_id: "fill-1",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "0.50",
        yes_price_dollars: "0.940000",
      }],
    );
    assert.equal(result.outcome, "ambiguous");
    assert.equal(result.reason, "fill_total_does_not_match_order");
  });

  it("rejects non-terminal orders even when the count currently reads zero", () => {
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ status: "resting" })],
      [],
    );
    assert.equal(result.outcome, "ambiguous");
    assert.equal(result.reason, "exchange_order_not_terminal_or_unparseable");
  });

  it("accepts a fully executed order only when no quantity remains", () => {
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ status: "executed", fill_count_fp: "2.00", remaining_count_fp: "0.00" })],
      [{
        fill_id: "fill-full",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "2.00",
        yes_price_dollars: "0.940000",
      }],
    );
    assert.equal(result.outcome, "confirmed_fill");
  });

  it("recovers the exact production IOC payload shape with a fractional partial fill", () => {
    const result = resolveScalpReconciliationEvidence(
      input({
        count: 5,
        clientOrderId: null,
        createdAt: new Date("2026-08-21T15:58:45.763Z"),
      }),
      [order({
        client_order_id: "07dc57d5-c8dd-405c-aaa2-292606947758",
        order_id: "01a0250b-cb08-737e-a9d1-716416d0a109",
        initial_count_fp: "5.00",
        fill_count_fp: "1.17",
        remaining_count_fp: "0.00",
        yes_price_dollars: "0.9400",
        created_time: "2026-08-21T15:58:45.80624Z",
      })],
      [{
        fill_id: "0720b124-bc51-b8fc-081a-e8af9a573c72",
        order_id: "01a0250b-cb08-737e-a9d1-716416d0a109",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "1.17",
        yes_price_dollars: "0.9400",
      }],
    );
    assert.equal(result.outcome, "confirmed_fill");
    if (result.outcome !== "confirmed_fill") return;
    assert.equal(result.filledCount, 1.17);
    assert.equal(result.avgFillPrice, 0.94);
    assert.equal(result.budgetSpent, 1.0998);
  });

  it("rejects a canceled order that still reports a resting remainder", () => {
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ remaining_count_fp: "0.25" })],
      [],
    );
    assert.equal(result.outcome, "ambiguous");
    assert.equal(result.reason, "exchange_order_not_terminal_or_unparseable");
  });

  it("requires one unique exact legacy match and rejects stale-window candidates", () => {
    const legacy = input({ clientOrderId: null });
    const duplicate = order({ order_id: "order-gold-4", client_order_id: "other" });
    const duplicateResult = resolveScalpReconciliationEvidence(legacy, [order(), duplicate], []);
    assert.equal(duplicateResult.outcome, "ambiguous");
    assert.equal(duplicateResult.reason, "multiple_exchange_order_matches");

    const staleResult = resolveScalpReconciliationEvidence(
      legacy,
      [order({ created_time: "2026-08-21T15:59:20.000Z" })],
      [],
    );
    assert.equal(staleResult.outcome, "ambiguous");
    assert.equal(staleResult.reason, "no_unique_exchange_order_match");
  });

  it("excludes already-persisted retry order ids from a legacy match", () => {
    const result = resolveScalpReconciliationEvidence(
      input({
        clientOrderId: null,
        excludeExchangeOrderIds: ["order-gold-2"],
      }),
      [
        order({ order_id: "order-gold-2", client_order_id: "prior" }),
        order(),
      ],
      [],
    );
    assert.equal(result.outcome, "zero_fill");
  });

  it("classifies a reconciled YES fill below the band as favorable", () => {
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ fill_count_fp: "2.00" })],
      [{
        fill_id: "fill-improved-yes",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "2.00",
        yes_price_dollars: "0.890000",
      }],
    );
    assert.equal(result.outcome, "confirmed_fill");
    if (result.outcome !== "confirmed_fill") return;
    assert.equal(
      classifyScalpFillAgainstBand("yes", result.avgFillPrice, 0.91, 0.95)
        .classification,
      "favorable_price_improvement",
    );
  });

  it("classifies a reconciled NO fill below the band as favorable", () => {
    const result = resolveScalpReconciliationEvidence(
      input({ side: "no", limitPrice: 0.06 }),
      [order({
        outcome_side: "no",
        book_side: "ask",
        yes_price_dollars: "0.060000",
        fill_count_fp: "2.00",
      })],
      [{
        fill_id: "fill-improved-no",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "no",
        book_side: "ask",
        count_fp: "2.00",
        yes_price_dollars: "0.110000",
      }],
    );
    assert.equal(result.outcome, "confirmed_fill");
    if (result.outcome !== "confirmed_fill") return;
    assert.equal(
      classifyScalpFillAgainstBand("no", result.avgFillPrice, 0.91, 0.95)
        .classification,
      "favorable_price_improvement",
    );
  });

  it("classifies a reconciled above-ceiling fill as an adverse limit breach", () => {
    const result = resolveScalpReconciliationEvidence(
      input(),
      [order({ fill_count_fp: "2.00" })],
      [{
        fill_id: "fill-breach-yes",
        order_id: "order-gold-3",
        ticker: "KXGOLD15M-26AUG211200-00",
        outcome_side: "yes",
        book_side: "bid",
        count_fp: "2.00",
        yes_price_dollars: "0.960000",
      }],
    );
    assert.equal(result.outcome, "confirmed_fill");
    if (result.outcome !== "confirmed_fill") return;
    assert.equal(
      classifyScalpFillAgainstBand("yes", result.avgFillPrice, 0.91, 0.95)
        .classification,
      "adverse_limit_breach",
    );
  });
});