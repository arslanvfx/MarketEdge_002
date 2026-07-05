// Unit tests for the manual position open + close flow.
//
// Architecture:
//   placeManualOrder and closeManualPosition in kalshi-bot.ts share the
//   module-level openPositions map with the automated bot.  A regression here
//   (close not removing from the map, bot tick trying to exit an already-closed
//   manual position) could strand funds or corrupt daily P&L.
//
//   kalshi-bot.ts cannot be imported directly in node:test because its
//   transitive deps include @workspace/db, which uses extensionless barrel
//   exports that trigger ERR_UNSUPPORTED_DIR_IMPORT in the native-ESM runner.
//   The established pattern for this project is:
//     (a) Extract pure validation logic to kalshi-bot-guards.ts (zero-dep).
//     (b) Test those pure functions directly for behavioral coverage.
//     (c) Use source-text wiring checks to verify kalshi-bot.ts delegates to
//         the guards AND performs the map mutations at the right places.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDuplicatePositionGuard,
  checkManualPositionExistsGuard,
  checkManualSourceGuard,
} from "./kalshi-bot-guards.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readSrc(file: string): string {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

// ===========================================================================
// Guard: checkDuplicatePositionGuard
//
//   Fires when: openPositions.has(sym) === true
//   Effect:     placeManualOrder throws before touching Kalshi or the DB
// ===========================================================================

test("duplicatePosition: no position open → not blocked", () => {
  assert.equal(checkDuplicatePositionGuard(false), false);
});

test("duplicatePosition: position already open → blocked", () => {
  assert.equal(checkDuplicatePositionGuard(true), true);
});

// Wiring: placeManualOrder must call checkDuplicatePositionGuard
test("duplicatePosition/wiring: placeManualOrder delegates to checkDuplicatePositionGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkDuplicatePositionGuard(openPositions.has(sym))"),
    "placeManualOrder must call checkDuplicatePositionGuard(openPositions.has(sym))",
  );
});

// ===========================================================================
// Guard: checkManualPositionExistsGuard
//
//   Fires when: openPositions.get(sym) is undefined (no open position)
//   Effect:     closeManualPosition throws with a clear error message
// ===========================================================================

test("positionExists: pos present → no throw", () => {
  assert.doesNotThrow(() => checkManualPositionExistsGuard({ source: "manual" }, "BTC"));
});

test("positionExists: pos is undefined → throws 'No open position'", () => {
  assert.throws(
    () => checkManualPositionExistsGuard(undefined, "BTC"),
    (err: Error) => {
      assert.ok(err.message.includes("No open position for BTC"));
      return true;
    },
  );
});

test("positionExists: pos is null → throws 'No open position'", () => {
  assert.throws(
    () => checkManualPositionExistsGuard(null, "ETH"),
    (err: Error) => {
      assert.ok(err.message.includes("No open position for ETH"));
      return true;
    },
  );
});

test("positionExists: error message contains the symbol exactly", () => {
  assert.throws(
    () => checkManualPositionExistsGuard(undefined, "DOGE"),
    (err: Error) => {
      assert.ok(err.message.includes("DOGE"), "error message must contain the symbol");
      return true;
    },
  );
});

// Wiring: closeManualPosition must call checkManualPositionExistsGuard
test("positionExists/wiring: closeManualPosition delegates to checkManualPositionExistsGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkManualPositionExistsGuard(pos, sym)"),
    "closeManualPosition must call checkManualPositionExistsGuard(pos, sym)",
  );
});

// ===========================================================================
// Guard: checkManualSourceGuard
//
//   Fires when: pos.source !== "manual"
//   Effect:     closeManualPosition throws — bot-opened positions must go
//               through bot controls, not the manual-close endpoint
// ===========================================================================

test("manualSource: source is 'manual' → no throw", () => {
  assert.doesNotThrow(() => checkManualSourceGuard("manual", "BTC"));
});

test("manualSource: source is 'bot' → throws 'opened by the bot'", () => {
  assert.throws(
    () => checkManualSourceGuard("bot", "BTC"),
    (err: Error) => {
      assert.ok(err.message.includes("opened by the bot"), "error must mention bot ownership");
      return true;
    },
  );
});

test("manualSource: source is empty string → throws", () => {
  assert.throws(() => checkManualSourceGuard("", "ETH"));
});

test("manualSource: source is 'auto' (any non-manual) → throws", () => {
  assert.throws(() => checkManualSourceGuard("auto", "BTC"));
});

test("manualSource: error message contains the symbol", () => {
  assert.throws(
    () => checkManualSourceGuard("bot", "SOL"),
    (err: Error) => {
      assert.ok(err.message.includes("SOL"), "error message must contain the symbol");
      return true;
    },
  );
});

// Wiring: closeManualPosition must call checkManualSourceGuard
test("manualSource/wiring: closeManualPosition delegates to checkManualSourceGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkManualSourceGuard(pos!.source, sym)"),
    "closeManualPosition must call checkManualSourceGuard(pos!.source, sym)",
  );
});

// ===========================================================================
// Wiring: placeManualOrder → openPositions.set with source: "manual"
//
//   After a successful fill, placeManualOrder must record the new position in
//   the shared map so the bot tick can observe it (preventing double-entry)
//   and so closeManualPosition can look it up.
// ===========================================================================

test("placeManualOrder/wiring: sets openPositions after fill", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("openPositions.set(sym, newPosition)"),
    "placeManualOrder must write the new position into openPositions via openPositions.set(sym, newPosition)",
  );
});

test("placeManualOrder/wiring: newPosition carries source = 'manual'", () => {
  const src = readSrc("kalshi-bot.ts");
  // The position object literal in placeManualOrder must include source: "manual"
  assert.ok(
    src.includes('source: "manual"'),
    "placeManualOrder must tag the position with source: \"manual\"",
  );
});

test("placeManualOrder/wiring: persists bet record to DB after fill", () => {
  const src = readSrc("kalshi-bot.ts");
  // persistBetRecord must be called inside placeManualOrder
  assert.ok(
    src.includes("persistBetRecord("),
    "placeManualOrder must call persistBetRecord to write the open leg to the DB",
  );
});

// ===========================================================================
// Wiring: closeManualPosition → openPositions.delete + DB write
//
//   After closing, the position must be removed from the shared map so the bot
//   tick cannot attempt to exit it a second time (which would corrupt P&L and
//   potentially trigger a duplicate Kalshi order).
// ===========================================================================

test("closeManualPosition/wiring: deletes from openPositions after close", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("openPositions.delete(sym)"),
    "closeManualPosition must call openPositions.delete(sym) after the position is closed",
  );
});

test("closeManualPosition/wiring: writes exit row via closePosition helper", () => {
  const src = readSrc("kalshi-bot.ts");
  // closeManualPosition calls the shared closePosition helper which writes to DB
  assert.ok(
    src.includes("await closePosition(pos,"),
    "closeManualPosition must delegate to the closePosition helper (which persists the exit row)",
  );
});

// ===========================================================================
// Interaction invariant: bot-opened position cannot be closed via manual path
//
//   This is the critical regression guard: if a bot tick opens a position and
//   the manual-close endpoint is then called for the same symbol, it must
//   throw rather than close the position and corrupt the bot's state machine.
// ===========================================================================

test("bot-position/behavioral: checkManualSourceGuard throws for bot-opened position", () => {
  // Simulate what closeManualPosition does: look up pos, run guards
  const botOpenedPosition = { source: "bot" };

  // Step 1: position exists — should not throw
  assert.doesNotThrow(() =>
    checkManualPositionExistsGuard(botOpenedPosition, "BTC"),
  );

  // Step 2: source check — MUST throw because source !== "manual"
  assert.throws(
    () => checkManualSourceGuard(botOpenedPosition.source, "BTC"),
    (err: Error) => {
      assert.ok(
        err.message.includes("opened by the bot"),
        "error must explain the position belongs to the bot",
      );
      return true;
    },
  );
});

// ===========================================================================
// Interaction invariant: closing a non-existent position throws gracefully
//
//   Protects against stale UI state — the dashboard might call close after
//   the window expired and the bot already cleaned up the position.
// ===========================================================================

test("nonExistent/behavioral: checkManualPositionExistsGuard throws for missing position", () => {
  // Simulate the Map.get() returning undefined (position was already removed)
  const pos = undefined;
  assert.throws(
    () => checkManualPositionExistsGuard(pos, "BTC"),
    (err: Error) => {
      assert.ok(
        err.message.includes("No open position for BTC"),
        "error message must clearly state no position exists for the symbol",
      );
      return true;
    },
  );
});
