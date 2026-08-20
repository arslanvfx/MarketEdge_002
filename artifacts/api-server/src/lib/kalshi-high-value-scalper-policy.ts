import type { BotConfig } from "./kalshi-bot-engine";
import type { OpenPosition } from "./kalshi-bot-state";

export type HighValueScalpSide = "yes" | "no";

export interface HighValueScalpEligibility {
  eligible: boolean;
  side: HighValueScalpSide | null;
  price: number | null;
  reason: string | null;
}

/**
 * Pure quote and position policy for the isolated high-value scalp scanner.
 * It deliberately receives no model inputs or normal bot guard state.
 */
export function evaluateHighValueScalpEligibility(input: {
  yesAsk: number | null;
  yesBid: number | null;
  secondsRemaining: number;
  config: Pick<BotConfig, "highValueScalpMinPrice" | "highValueScalpMaxPrice" | "highValueScalpMaxMinutesRemaining">;
  activePosition?: Pick<OpenPosition, "direction"> | null;
}): HighValueScalpEligibility {
  const min = input.config.highValueScalpMinPrice ?? 0.90;
  const max = input.config.highValueScalpMaxPrice ?? 0.95;
  const maxRemainingSeconds = (input.config.highValueScalpMaxMinutesRemaining ?? 2) * 60;
  if (!Number.isFinite(input.secondsRemaining) || input.secondsRemaining <= 0 || input.secondsRemaining > maxRemainingSeconds) {
    return { eligible: false, side: null, price: null, reason: "outside final scalp window" };
  }
  if (input.yesAsk == null || input.yesBid == null || input.yesAsk <= 0 || input.yesBid <= 0 || input.yesBid > input.yesAsk) {
    return { eligible: false, side: null, price: null, reason: "missing or crossed two-sided quote" };
  }
  // Kalshi contracts are cent-resolution. Normalize the complement so binary
  // floating-point noise never changes a 93¢ band boundary to 92.999...¢.
  const noAsk = Number((1 - input.yesBid).toFixed(2));
  const yesEligible = input.yesAsk >= min && input.yesAsk <= max;
  const noEligible = noAsk >= min && noAsk <= max;
  if (yesEligible === noEligible) {
    return { eligible: false, side: null, price: null, reason: yesEligible ? "ambiguous winning side" : "winning side outside scalp band" };
  }
  const side: HighValueScalpSide = yesEligible ? "yes" : "no";
  if (input.activePosition && input.activePosition.direction !== side) {
    return { eligible: false, side, price: yesEligible ? input.yesAsk : noAsk, reason: "opposite active position blocks scalp" };
  }
  return { eligible: true, side, price: yesEligible ? input.yesAsk : noAsk, reason: null };
}