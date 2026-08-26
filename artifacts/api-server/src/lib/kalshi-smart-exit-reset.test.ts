import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbSource = readFileSync(join(here, "kalshi-smart-exit-db.ts"), "utf8");
const serviceSource = readFileSync(join(here, "kalshi-smart-exit-service.ts"), "utf8");
const routeSource = readFileSync(join(here, "../routes/kalshi-smart-exit.ts"), "utf8");

function exportedFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return source.slice(start, nextExport === -1 ? source.length : nextExport);
}

describe("Smart Exit destructive history reset", () => {
  it("atomically deletes exactly the five historical analysis tables", () => {
    const source = exportedFunctionSource(dbSource, "deleteSmartExitHistory");
    const deletedTables = [...source.matchAll(/DELETE FROM ([a-z_]+)/g)].map((match) => match[1]);
    assert.deepEqual(deletedTables, [
      "kalshi_smart_exit_lifecycles",
      "kalshi_smart_exit_evaluations",
      "kalshi_smart_exit_position_state",
      "kalshi_smart_exit_recovery_studies",
      "kalshi_smart_exit_replay_reports",
    ]);
    assert.match(source, /client\.query\("BEGIN"\)/);
    assert.match(source, /client\.query\("COMMIT"\)/);
    assert.match(source, /client\.query\("ROLLBACK"\)/);
    assert.doesNotMatch(source, /kalshi_smart_exit_(?:config|requests|evidence_samples)/);
    assert.doesNotMatch(source, /kalshi_(?:bot_bets|scalp_orders)/);
  });

  it("clears evaluation and position-state caches after durable deletion", () => {
    const source = exportedFunctionSource(serviceSource, "resetSmartExitHistory");
    assert.match(source, /await deleteSmartExitHistory\(\)/);
    for (const cache of [
      "states",
      "modelEntryBaselines",
      "latestEvaluations",
      "latestValidEvaluations",
      "lastEvidencePersistenceMs",
    ]) {
      assert.match(source, new RegExp(`${cache}\\.clear\\(\\)`));
    }
  });

  it("requires operator auth and an exact explicit confirmation phrase", () => {
    assert.match(
      routeSource,
      /"\/crypto\/smart-exit\/history\/reset",\s*requireSmartExitOperator/,
    );
    assert.match(routeSource, /SMART_EXIT_HISTORY_RESET_CONFIRMATION = "RESET SMART EXIT HISTORY"/);
    assert.match(
      routeSource,
      /req\.body\?\.confirmation !== SMART_EXIT_HISTORY_RESET_CONFIRMATION/,
    );
    assert.match(routeSource, /res\.status\(400\)/);
  });
});