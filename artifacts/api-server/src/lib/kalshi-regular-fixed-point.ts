const COUNT_SCALE = 100;

/**
 * Parse Kalshi FixedPointCount values exactly to hundredths of a contract.
 * Canonical strings may contain zero, one, or two fractional digits. Numbers
 * are accepted only when they are exactly representable at centi-contract
 * precision (within a tiny floating-point tolerance).
 */
export function regularCountHundredths(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const scaled = value * COUNT_SCALE;
    const units = Math.round(scaled);
    if (!Number.isSafeInteger(units) || Math.abs(scaled - units) > 1e-8) return null;
    return BigInt(units);
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const units = whole * BigInt(COUNT_SCALE) + fraction;
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? units : null;
}

export function parseRegularFixedPointCount(value: unknown): number | null {
  const units = regularCountHundredths(value);
  return units == null ? null : Number(units) / COUNT_SCALE;
}

export function formatRegularFixedPointCount(value: unknown): string | null {
  const units = regularCountHundredths(value);
  if (units == null) return null;
  const whole = units / BigInt(COUNT_SCALE);
  const fraction = (units % BigInt(COUNT_SCALE)).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function regularCountsEqual(a: unknown, b: unknown): boolean {
  const aUnits = regularCountHundredths(a);
  const bUnits = regularCountHundredths(b);
  return aUnits != null && bUnits != null && aUnits === bUnits;
}