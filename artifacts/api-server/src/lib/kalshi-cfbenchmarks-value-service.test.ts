import { test } from "node:test";
import assert from "node:assert/strict";

import { KalshiCfBenchmarksValueService } from "./kalshi-cfbenchmarks-value-service.ts";

function cfFrame(seq: number, time: number, value: string) {
  return Buffer.from(JSON.stringify({
    type: "cfbenchmarks_value",
    sid: 1,
    seq,
    msg: {
      index_id: "ZECUSD_RTI",
      received_at: time + 10,
      data: JSON.stringify({
        type: "value",
        time,
        id: "ZECUSD_RTI",
        value,
      }),
    },
  }));
}

test("a retired socket callback cannot publish into the current CF session", () => {
  const service = new KalshiCfBenchmarksValueService();
  const retiredSocket = {};
  const currentSocket = {};
  const internals = service as unknown as {
    socket: object;
    connectionGeneration: number;
    onMessage(data: Buffer, socket: object, generation: number): void;
    latest: Map<string, { price: number }>;
  };
  internals.socket = currentSocket;
  internals.connectionGeneration = 7;

  internals.onMessage(cfFrame(1, Date.now() - 100, "824.60"), retiredSocket, 6);
  assert.equal(internals.latest.size, 0);

  internals.onMessage(cfFrame(2, Date.now() - 50, "824.55"), currentSocket, 7);
  assert.equal(internals.latest.get("ZECUSD_RTI")?.price, 824.55);
});

test("same-publication websocket updates never replace a newer CF sequence", () => {
  const service = new KalshiCfBenchmarksValueService();
  const socket = {};
  const internals = service as unknown as {
    socket: object;
    connectionGeneration: number;
    onMessage(data: Buffer, socket: object, generation: number): void;
    latest: Map<string, { price: number; websocketSequence: number }>;
  };
  internals.socket = socket;
  internals.connectionGeneration = 3;
  const time = Date.now() - 100;

  internals.onMessage(cfFrame(12, time, "824.60"), socket, 3);
  internals.onMessage(cfFrame(11, time, "999.99"), socket, 3);

  assert.equal(internals.latest.get("ZECUSD_RTI")?.price, 824.6);
  assert.equal(internals.latest.get("ZECUSD_RTI")?.websocketSequence, 12);
});

test("public event warmup cannot satisfy an execution-critical evidence read", () => {
  const service = new KalshiCfBenchmarksValueService();
  const now = Date.now();
  const internals = service as unknown as {
    started: boolean;
    latest: Map<string, {
      indexId: string;
      price: number;
      sourceTsMs: number;
      receivedAtMs: number;
      websocketSequence: number;
      sourceSequence: string;
      average60s: number | null;
      provenance: "websocket" | "event_live_data";
    }>;
  };
  internals.started = true;
  internals.latest.set("BRTI", {
    indexId: "BRTI",
    price: 78_500,
    sourceTsMs: now - 100,
    receivedAtMs: now - 50,
    websocketSequence: 0,
    sourceSequence: "public-warmup",
    average60s: null,
    provenance: "event_live_data",
  });

  assert.throws(
    () => service.getFreshEvidence("BTC-USD", now, 5_000),
    /authenticated evidence unavailable.*awaiting websocket publication/,
  );

  internals.latest.set("BRTI", {
    ...internals.latest.get("BRTI")!,
    websocketSequence: 1,
    sourceSequence: "authenticated-websocket",
    provenance: "websocket",
  });
  assert.equal(service.getFreshEvidence("BTC-USD", now, 5_000).price, 78_500);
});