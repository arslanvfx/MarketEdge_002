// ---------------------------------------------------------------------------
// Pure overlay: merge tick-time abort reasons into window evaluation rows
// ---------------------------------------------------------------------------
// The Phase-3 loop writes one WindowCoinEvaluation row per coin per loop tick
// (e.g. "price in zone — monitoring").  When the coin is then dispatched into
// _runBotTick, a second set of gates runs at order time; each abort there is
// recorded in the tickAbortReasons map keyed by `sym:windowKey`.  This overlay
// prefers the tick-time abort reason because it is both newer and more
// specific than the loop-level reason.
//
// Rules:
//   • A row where a bet actually went through this window is never overridden —
//     a successful fill supersedes any earlier abort.
//   • The overlay only applies when the abort entry's window matches the row's
//     window (guaranteed by the composite key).
//
// Pure function — no imports from db-touching modules so it is unit-testable.

export interface EvalRowLike {
  symbol: string;
  windowKey: string;
  reason: string;
  action: string;
  selected: boolean;
  betPlacedThisWindow?: boolean;
}

export function overlayTickAbortReasons<T extends EvalRowLike>(
  rows: T[],
  abortReasons: ReadonlyMap<string, { reason: string; at: number }>,
): T[] {
  return rows.map((row) => {
    if (row.betPlacedThisWindow) return row;
    const abort = abortReasons.get(`${row.symbol}:${row.windowKey}`);
    if (!abort) return row;
    return { ...row, reason: abort.reason, action: "SKIP", selected: false };
  });
}

// ---------------------------------------------------------------------------
// Abort-reason lifecycle (pure — these exact functions are used by the tick)
// ---------------------------------------------------------------------------
// Lifecycle contract:
//   1. Every dispatch into the entry path calls clearTickAbort FIRST, so a
//      reason left over from an earlier tick can never mask this tick's state.
//   2. Each abort path calls recordTickAbort with its own current reason
//      immediately before returning.
//   3. A successful fill calls clearTickAbort so the placed bet shows through.
// Result: the map always holds the LATEST tick's exact abort (or nothing).

export type TickAbortMap = Map<string, { reason: string; at: number }>;

export function recordTickAbort(
  map: TickAbortMap,
  sym: string,
  windowKey: string,
  reason: string,
  at: number = Date.now(),
): void {
  map.set(`${sym}:${windowKey}`, { reason, at });
}

export function clearTickAbort(map: TickAbortMap, sym: string, windowKey: string): void {
  map.delete(`${sym}:${windowKey}`);
}
