import {
  resolveEntryQuietHoursDecisionForSymbol,
  type BotConfig,
  type EntryQuietHoursDecision,
} from "./kalshi-bot-engine-core.ts";
import type { Dashboard2Mode } from "./dashboard2-v2-pure.ts";

export type Dashboard2CanonicalPolicy = Readonly<{
  allowed: boolean;
  reason: string | null;
  quietHours: Pick<EntryQuietHoursDecision, "action" | "qhMode" | "forcedPaper" | "entryMode" | "reducedPct" | "isDataGathering" | "dgOverrideAmount" | "utcHour">;
  paused: boolean;
  overrideMaxBetSize: number | null;
  canonicalBetSize: number | null;
  effectiveBudget: number | null;
  limitingReason: "dashboard_budget" | "canonical_bet_size" | "per_coin_max_bet" | "smart_hours_reduced" | "data_gathering" | null;
  originalQuantity: number;
  cappedQuantity: number;
  dataGatheringAmount: number | null;
}>;

const positiveFinite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const finiteNonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Applies the canonical BotConfig entry controls to Dashboard 2 sizing. This
 * intentionally delegates schedule semantics to the canonical resolver. */
export function applyDashboard2CanonicalPolicy(input: {
  canonicalConfig: Readonly<BotConfig> | null;
  symbol: string;
  mode: Dashboard2Mode;
  sideCost: number;
  dashboardBudget: number;
  maxContracts: number;
  intendedQuantity: number;
  now?: Date;
}): Dashboard2CanonicalPolicy {
  const originalQuantity = Number.isSafeInteger(input.intendedQuantity) && input.intendedQuantity > 0
    ? input.intendedQuantity : 0;
  const unavailable = (): Dashboard2CanonicalPolicy => Object.freeze({
    allowed: false, reason: "canonical_bot_config_unavailable",
    quietHours: { action: "block", qhMode: "silenced", forcedPaper: false, entryMode: input.mode, reducedPct: null, isDataGathering: false, utcHour: new Date().getUTCHours() },
    paused: false, overrideMaxBetSize: null, canonicalBetSize: null, effectiveBudget: null, limitingReason: null,
    originalQuantity, cappedQuantity: 0, dataGatheringAmount: null,
  });
  if (!input.canonicalConfig || !Number.isFinite(input.sideCost) || input.sideCost <= 0 ||
      !Number.isSafeInteger(input.maxContracts) || input.maxContracts < 1) return unavailable();
  let quietHours: EntryQuietHoursDecision;
  try {
    quietHours = resolveEntryQuietHoursDecisionForSymbol(input.canonicalConfig, input.mode, input.symbol, input.now);
  } catch {
    return unavailable();
  }
  const override = input.canonicalConfig.coinOverrides?.[input.symbol.toUpperCase()];
  const paused = override?.paused === true;
  const overrideMaxBetSize = positiveFinite(override?.maxBetSize);
  const canonicalBetSize = positiveFinite(input.canonicalConfig.betSize);
  const dataGatheringAmount = quietHours.isDataGathering
    ? finiteNonNegative(quietHours.dgOverrideAmount) ?? finiteNonNegative(input.canonicalConfig.dataGatheringBetCap) ?? 1
    : null;
  const reducedBudget = quietHours.reducedPct == null ? null
    : canonicalBetSize == null ? null : canonicalBetSize * quietHours.reducedPct / 100;
  const namedCaps = [
    { amount: positiveFinite(input.dashboardBudget), reason: "dashboard_budget" as const },
    { amount: canonicalBetSize, reason: "canonical_bet_size" as const },
    { amount: overrideMaxBetSize, reason: "per_coin_max_bet" as const },
    { amount: reducedBudget, reason: "smart_hours_reduced" as const },
    { amount: dataGatheringAmount, reason: "data_gathering" as const },
  ].filter((cap): cap is { amount: number; reason: Dashboard2CanonicalPolicy["limitingReason"] & string } => cap.amount !== null);
  const limitingCap = namedCaps.reduce<(typeof namedCaps)[number] | null>(
    (lowest, cap) => lowest === null || cap.amount < lowest.amount ? cap : lowest,
    null,
  );
  const effectiveBudget = limitingCap?.amount ?? null;
  const forcedPaperForLive = input.mode === "live" && (quietHours.forcedPaper || quietHours.entryMode !== "live");
  const quantity = effectiveBudget == null ? 0 : Math.min(
    originalQuantity, input.maxContracts, Math.floor(effectiveBudget / input.sideCost),
  );
  const reason = paused ? "canonical_coin_paused"
    : quietHours.action === "block" ? "canonical_smart_hours_blocked"
    : forcedPaperForLive ? "canonical_smart_hours_forced_paper"
    : quantity < 1 ? "canonical_budget_below_one_contract"
    : null;
  return Object.freeze({
    allowed: reason === null, reason, quietHours, paused, overrideMaxBetSize, canonicalBetSize, effectiveBudget,
    limitingReason: limitingCap?.reason ?? null,
    originalQuantity, cappedQuantity: reason === null ? quantity : 0, dataGatheringAmount,
  });
}