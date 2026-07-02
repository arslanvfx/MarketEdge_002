import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/**
 * Lazily construct the Anthropic client on first use.
 *
 * Priority:
 *  1. ANTHROPIC_API_KEY — direct Anthropic billing, no proxy markup.
 *  2. AI_INTEGRATIONS_ANTHROPIC_* — Replit proxy (fallback for legacy envs).
 *
 * Throwing here (rather than at module load) means a missing key only fails
 * the requests that actually need Anthropic — it does not crash the whole API
 * server at boot and take down unrelated endpoints.
 */
function getClient(): Anthropic {
  if (client) return client;

  if (process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
  }

  if (
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
  ) {
    client = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
    return client;
  }

  throw new Error(
    "No Anthropic credentials found. Set ANTHROPIC_API_KEY for direct billing, " +
    "or provision the Replit Anthropic AI integration.",
  );
}

/**
 * Proxy that defers client construction until a property is accessed, preserving
 * the original `anthropic.messages.create(...)` usage while making missing-env a
 * request-time error instead of a boot-time crash.
 */
export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    const real = getClient();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
