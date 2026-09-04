import { test } from "node:test";
import assert from "node:assert/strict";

import { KalshiPythValueService } from "./kalshi-pyth-value-service.ts";

function pythFrame(time: number, value: string, seq: number) {
  return Buffer.from(JSON.stringify({
    type: "pyth_value",
    seq,
    msg: {
      underlying_ticker: "Metal.XAU/USD",
      value_usd: value,
      source_ts_ms: time,
      received_at: time + 10,
    },
  }));
}

test("a retired socket callback cannot repopulate current Pyth history", () => {
  const service = new KalshiPythValueService();
  const retiredSocket = {};
  const currentSocket = {};
  const internals = service as unknown as {
    socket: object;
    connectionGeneration: number;
    onMessage(data: Buffer, socket: object, generation: number): void;
    latest: Map<string, unknown>;
    history: Map<string, unknown[]>;
  };
  internals.socket = currentSocket;
  internals.connectionGeneration = 7;

  internals.onMessage(
    pythFrame(Date.now() - 100, "4400.10", 1),
    retiredSocket,
    6,
  );
  assert.equal(internals.latest.size, 0);
  assert.equal(internals.history.size, 0);

  internals.onMessage(
    pythFrame(Date.now() - 50, "4400.20", 2),
    currentSocket,
    7,
  );
  assert.equal(internals.latest.size, 1);
  assert.equal(internals.history.size, 1);
});

test("malformed publication invalidates previously fresh commodity evidence", () => {
  const service = new KalshiPythValueService();
  const nowMs = Date.now();
  const receive = (payload: unknown) => {
    (service as unknown as { onMessage(data: Buffer): void })
      .onMessage(Buffer.from(JSON.stringify(payload)));
  };

  receive({
    type: "pyth_value",
    seq: 1,
    msg: {
      underlying_ticker: "Metal.XAU/USD",
      value_usd: "4400.25",
      source_ts_ms: nowMs - 100,
      received_at: nowMs,
    },
  });
  assert.notEqual(service.getStatus(nowMs).underlyings["Metal.XAU/USD"], null);

  receive({
    type: "pyth_value",
    seq: 2,
    msg: {
      underlying_ticker: "Metal.XAU/USD",
      value_usd: "malformed",
      source_ts_ms: nowMs,
      received_at: nowMs,
    },
  });

  const status = service.getStatus(nowMs);
  assert.equal(status.underlyings["Metal.XAU/USD"], null);
  assert.match(status.lastFailureReason ?? "", /malformed pyth_value frame/);
  const internals = service as unknown as {
    history: Map<string, unknown[]>;
  };
  assert.equal(internals.history.size, 0);
});

test("Pyth history preserves distinct authenticated publications and replaces same-time corrections", () => {
  const service = new KalshiPythValueService();
  const nowMs = Date.now();
  const receive = (
    sourceTsMs: number,
    receivedAt: number,
    value: string,
    seq: number,
  ) => {
    (service as unknown as { onMessage(data: Buffer): void }).onMessage(
      Buffer.from(JSON.stringify({
        type: "pyth_value",
        seq,
        msg: {
          underlying_ticker: "Metal.XAU/USD",
          value_usd: value,
          source_ts_ms: sourceTsMs,
          received_at: receivedAt,
        },
      })),
    );
  };
  const internals = service as unknown as { started: boolean };
  internals.started = true;

  receive(nowMs - 4_000, nowMs - 3_990, "4400.10", 1);
  receive(nowMs - 2_000, nowMs - 1_990, "4400.20", 2);
  receive(nowMs - 100, nowMs - 90, "4400.30", 3);
  receive(nowMs - 100, nowMs - 80, "4400.31", 4);

  const history = service.getFreshEvidenceHistory(
    "PYTH:Metal.XAU/USD",
    nowMs,
    5_000,
  );
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((evidence) => evidence.price),
    [4400.1, 4400.2, 4400.31],
  );
  assert.deepEqual(
    history.map((evidence) => evidence.receivedAtMs),
    [nowMs - 3_990, nowMs - 1_990, nowMs - 80],
  );
});