import assert from "node:assert/strict";
import { test } from "node:test";
import { isDashboard2ExecutionOwner } from "./dashboard2-ownership-contract.ts";

test("execution owner validation accepts only the contract values", () => {
  for (const owner of ["current_bot", "dashboard2_bot", "paused"]) {
    assert.equal(isDashboard2ExecutionOwner(owner), true);
  }
  for (const owner of ["live", "paper", "", null, 1]) {
    assert.equal(isDashboard2ExecutionOwner(owner), false);
  }
});