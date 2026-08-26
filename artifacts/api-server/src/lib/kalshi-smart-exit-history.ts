import type { SmartExitLifecycleRecord } from "./kalshi-smart-exit-types.ts";

/**
 * Adds lifecycle data only through the durable regular owner + position ID.
 * Ticker, timestamps, and free-form exit text are intentionally not match keys.
 */
export function projectRegularSmartExitHistory<T extends { id: string }>(
  rows: readonly T[],
  lifecycles: readonly SmartExitLifecycleRecord[],
): Array<T & { smartExit?: SmartExitLifecycleRecord }> {
  const regularByPositionId = new Map(
    lifecycles
      .filter((lifecycle) => lifecycle.owner === "regular")
      .map((lifecycle) => [lifecycle.positionId, lifecycle]),
  );
  return rows.map((row) => {
    const smartExit = regularByPositionId.get(row.id);
    return smartExit ? { ...row, smartExit } : { ...row };
  });
}