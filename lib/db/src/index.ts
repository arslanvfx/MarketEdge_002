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
  // Keep pool small: Replit PostgreSQL kills idle connections at the protocol
  // level. A large pool means many stale connections all attempting to reconnect
  // simultaneously under load, overwhelming the auth handshake and causing a
  // cascade of timeouts. 5 connections are enough for all concurrent bot ticks.
  max: 5,
  min: 1,
  idleTimeoutMillis: 20000,
  // Short acquire timeout so failed attempts fail fast and retry logic kicks in
  // quickly instead of blocking the bot tick for 30 s.
  connectionTimeoutMillis: 8000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 1000,
  allowExitOnIdle: false,
});

pool.on("error", (err) => {
  console.error("[db-pool] idle client error (non-fatal)", err.message);
});

// Reserved lane for latency-critical, durable-before-submit trading intents.
// Analytics, settlement, and dashboard traffic use the shared pool above and
// therefore cannot consume these connections while an eligible order is being
// claimed. `min` does not eagerly connect, so startup explicitly warms this pool.
export const criticalIntentPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  min: 1,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 2000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 1000,
  allowExitOnIdle: false,
});

criticalIntentPool.on("error", (err) => {
  console.error("[critical-intent-pool] idle client error (non-fatal)", err.message);
});

let _pingerStarted = false;
export function startPoolPinger() {
  if (_pingerStarted) return;
  _pingerStarted = true;
  const run = async () => {
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
    } catch {
      // non-fatal — pool will self-heal on next real query
    }
    setTimeout(run, 10_000);
  };
  setTimeout(run, 5_000);
}

let _criticalIntentPingerStarted = false;
export async function startCriticalIntentPoolPinger(): Promise<void> {
  if (_criticalIntentPingerStarted) return;
  // Establish the reserved lane before live entry can be enabled.
  await criticalIntentPool.query("SELECT 1");
  _criticalIntentPingerStarted = true;
  const run = async () => {
    try {
      await criticalIntentPool.query("SELECT 1");
    } catch {
      // Non-fatal here. A claim still fails closed if the lane cannot recover.
    }
    setTimeout(run, 5_000);
  };
  setTimeout(run, 5_000);
}

export const db = drizzle(pool, { schema });

const RETRYABLE = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "connect ECONNREFUSED",
  "Connection refused",
  "Authentication timed out",
  "SASL",
  "SSL SYSCALL error",
  "Client was closed",
  "the database system is starting up",
  "Connection reset by peer",
];

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE.some((s) => msg.includes(s));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 5,
  baseDelayMs = 400,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      const jitter = Math.random() * 0.4 + 0.8;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) * jitter, 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export * from "./schema";
