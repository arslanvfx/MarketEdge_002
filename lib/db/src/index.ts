import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[db-pool] idle client error (non-fatal)", err.message);
});

export const db = drizzle(pool, { schema });

const RETRYABLE = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "connect ECONNREFUSED",
  "Connection refused",
];

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE.some((s) => msg.includes(s));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

export * from "./schema";
