/**
 * Injectable persistence layer for coinStreakState.
 *
 * These functions hold the actual persist/load logic and accept a StreakDbStore
 * interface so they can be exercised in unit tests without a real database.
 *
 * kalshi-bot.ts wraps these with a concrete DrizzleStreakStore that talks to
 * the bot_config table; tests supply an in-memory stub.
 */
import { buildStreakSnapshot, restoreStreakState, type CoinStreakEntry } from "./kalshi-bot-engine-core.ts";

export interface StreakDbStore {
  /** Upsert the snapshot — equivalent to INSERT … ON CONFLICT DO UPDATE. */
  upsert(snapshot: Record<string, CoinStreakEntry>): Promise<void>;
  /** Fetch the stored snapshot, or null when nothing has been persisted yet. */
  fetch(): Promise<Record<string, CoinStreakEntry> | null>;
}

/**
 * Persist the current in-memory streak state to the store.
 * Only non-trivial entries (losses > 0 or active pause) are written.
 */
export async function persistCoinStreakState(
  state: Map<string, CoinStreakEntry>,
  store: StreakDbStore,
): Promise<void> {
  const snapshot = buildStreakSnapshot(state);
  await store.upsert(snapshot);
}

/**
 * Load streak state from the store and apply expiry logic.
 * Expired pauses (pauseUntilWindowKey <= nowWindowKey) are auto-cleared.
 * Returns the restored Map and the list of symbols whose pause was cleared.
 */
export async function loadCoinStreakState(
  store: StreakDbStore,
  nowWindowKey: string,
): Promise<{ state: Map<string, CoinStreakEntry>; clearedSyms: string[] }> {
  const saved = await store.fetch();
  if (!saved) return { state: new Map(), clearedSyms: [] };
  return restoreStreakState(saved, nowWindowKey);
}
