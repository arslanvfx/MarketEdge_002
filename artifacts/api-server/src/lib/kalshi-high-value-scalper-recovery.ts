export type RecoverableScalpRow = {
  action: string;
  source: string | null;
  signals: unknown;
};

export function isRecoverableOpenPositionAction(action: string): boolean {
  return action === "bet" || action === "high_value_scalp" || action === "high_value_scalp_add";
}

/**
 * Restores scalp attribution from durable row metadata. Existing ordinary
 * positions that received a scalp add-on are intentionally attributed here too:
 * their combined open exposure must survive a restart.
 */
export function restoreHighValueScalpMetadata(row: RecoverableScalpRow): {
  source: "bot" | "manual" | "high_value_scalp";
  highValueScalpAmount?: number;
  highValueScalpAddCount?: number;
} {
  const signals = (row.signals && typeof row.signals === "object")
    ? row.signals as Record<string, unknown>
    : {};
  const isManual = (signals.manual === true);
  const isScalp = row.source === "high_value_scalp"
    || row.action === "high_value_scalp"
    || row.action === "high_value_scalp_add"
    || signals.highValueScalp === true;
  const amount = Number(signals.highValueScalpAmount);
  const count = Number(signals.highValueScalpAddCount);
  return {
    source: isManual ? "manual" : isScalp ? "high_value_scalp" : "bot",
    ...(isScalp && Number.isFinite(amount) && amount > 0 ? { highValueScalpAmount: amount } : {}),
    ...(isScalp && Number.isInteger(count) && count > 0 ? { highValueScalpAddCount: count } : {}),
  };
}