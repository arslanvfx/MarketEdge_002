/**
 * Builds the only fields that may change when a confirmed scalp is folded into
 * an already-open position. Keeping this separate from exit updates prevents a
 * harmless add-on from assigning an exit timestamp or P&L.
 */
export function buildHighValueScalpEntryUpdate(input: {
  signals: Record<string, unknown>;
  entryPrice?: number | null;
  entryYesPrice?: number | null;
  contractCount?: number;
  betAmount?: number | null;
  source: "bot" | "manual" | "high_value_scalp";
}) {
  return {
    signals: input.signals,
    entryPrice: input.entryPrice != null ? String(input.entryPrice) : undefined,
    entryYesPrice: input.entryYesPrice != null ? String(input.entryYesPrice) : undefined,
    contractCount: input.contractCount,
    betAmount: input.betAmount != null ? String(input.betAmount) : undefined,
    source: input.source,
  };
}