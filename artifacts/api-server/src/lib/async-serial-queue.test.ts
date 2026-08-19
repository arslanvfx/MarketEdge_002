import { test } from "node:test";
import assert from "node:assert/strict";

import { AsyncSerialQueue } from "./async-serial-queue.ts";

test("AsyncSerialQueue preserves write ordering even when the first write is slow", async () => {
  const queue = new AsyncSerialQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    events.push("first-start");
    await firstBlocked;
    events.push("first-end");
    return 1;
  });
  const second = queue.run(async () => {
    events.push("second-start");
    events.push("second-end");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  releaseFirst?.();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(events, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
  ]);
});

test("AsyncSerialQueue continues after a rejected write", async () => {
  const queue = new AsyncSerialQueue();
  await assert.rejects(queue.run(async () => {
    throw new Error("expected");
  }));
  assert.equal(await queue.run(async () => "recovered"), "recovered");
});