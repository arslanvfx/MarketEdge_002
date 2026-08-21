import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatApiError, readApiResponse } from "./api-response.ts";

describe("formatApiError", () => {
  it("preserves the server authorization reason", () => {
    assert.equal(
      formatApiError({ error: "Forbidden — not authorized to control the scalper" }, 403),
      "Forbidden — not authorized to control the scalper",
    );
  });

  it("includes structured validation details", () => {
    assert.equal(
      formatApiError(
        {
          error: "Invalid config",
          errors: [{ path: ["perMarketOverrides", 0, "minBand"], message: "must be a number" }],
        },
        400,
      ),
      "Invalid config: perMarketOverrides.0.minBand: must be a number",
    );
  });

  it("uses an HTTP fallback for an empty response", () => {
    assert.equal(formatApiError({}, 500), "Request failed (HTTP 500)");
  });
});

describe("readApiResponse", () => {
  it("returns a successful JSON payload", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(await readApiResponse(response), { ok: true });
  });

  it("throws the server-provided message for a failed response", async () => {
    const response = new Response(JSON.stringify({ error: "Operator access required" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(() => readApiResponse(response), /Operator access required/);
  });
});