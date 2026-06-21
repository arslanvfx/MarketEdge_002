import type { Market } from "./markets";

export interface OptimizeLeg {
  marketId: string;
  platform: "kalshi" | "polymarket";
  position: "yes" | "no";
}

export interface ComboLegResult {
  marketId: string;
  platform: "kalshi" | "polymarket";
  marketTitle: string;
  position: "yes" | "no";
  odds: number;
  impliedProb: number;
  // AI value-analysis fields (present on Smart Picks legs only)
  trueProbability?: number; // AI true probability of the chosen side (0..1)
  edge?: number; // trueProbability - odds for the chosen side (positive = value)
  aiReasoning?: string;
  aiConfidence?: "low" | "medium" | "high";
}

export interface ComboSuggestion {
  legs: ComboLegResult[];
  jointProbability: number;
  payoutMultiplier: number;
  diversificationWarning: boolean;
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

/**
 * Normalize a market title into a "family" key so highly-correlated markets
 * collapse together. Strips numbers, percentages, months, and years so that
 * e.g. "Will CPI rise more than 0.0% in June 2026?" and "...more than 0.1% in
 * July 2026?" map to the same key, while distinct events stay separate.
 */
function marketFamilyKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\d+(\.\d+)?%?/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comboKey(legs: ComboLegResult[]): string {
  return legs
    .map((l) => `${l.platform}:${l.marketId}:${l.position}`)
    .sort()
    .join("|");
}

export function optimizeCombos(opts: {
  selectedLegs: OptimizeLeg[];
  markets: Market[];
  maxComboSize: number;
  topN: number;
}): ComboSuggestion[] {
  const { selectedLegs, markets, maxComboSize, topN } = opts;

  const marketMap = new Map(markets.map((m) => [m.id, m]));

  const enrichedLegs: ComboLegResult[] = selectedLegs
    .map((leg) => {
      const market = marketMap.get(leg.marketId);
      if (!market) return null;
      const impliedProb =
        leg.position === "yes" ? market.yesOdds : market.noOdds;
      return {
        marketId: leg.marketId,
        platform: leg.platform,
        marketTitle: market.title,
        position: leg.position,
        odds: impliedProb,
        impliedProb,
      };
    })
    .filter(Boolean) as ComboLegResult[];

  if (enrichedLegs.length < 2) return [];

  const allCombos: ComboSuggestion[] = [];

  for (let size = 2; size <= Math.min(maxComboSize, enrichedLegs.length); size++) {
    const combos = combinations(enrichedLegs, size);
    for (const legs of combos) {
      const jointProbability = legs.reduce(
        (acc, leg) => acc * leg.impliedProb,
        1,
      );
      const payoutMultiplier = jointProbability > 0 ? 1 / jointProbability : 0;
      allCombos.push({
        legs,
        jointProbability,
        payoutMultiplier,
        diversificationWarning: false,
      });
    }
  }

  // Sort by payout multiplier descending
  allCombos.sort((a, b) => b.payoutMultiplier - a.payoutMultiplier);
  const top = allCombos.slice(0, topN);

  // Compute diversification warnings
  // A combo gets a warning if every single one of its legs appears in EVERY other combo
  // More practically: flag combos where all legs are shared with the top combo
  const legSets = top.map((c) => new Set(c.legs.map((l) => `${l.platform}:${l.marketId}:${l.position}`)));

  for (let i = 0; i < top.length; i++) {
    const myLegs = legSets[i];
    // Find other combos
    const others = legSets.filter((_, j) => j !== i);
    if (others.length === 0) continue;
    // Warning: if at least one leg appears in ALL other combos (single point of failure)
    for (const legKey of myLegs) {
      const inAll = others.every((otherSet) => otherSet.has(legKey));
      if (inAll) {
        top[i].diversificationWarning = true;
        break;
      }
    }
  }

  return top;
}

// ─── Auto-generate 4 non-overlapping Smart Pick combos ──────────────────────

export type RiskLevel = "conservative" | "balanced" | "aggressive";

export interface SmartPickResult {
  legs: ComboLegResult[];
  jointProbability: number; // AI-estimated true probability the whole parlay hits
  payoutMultiplier: number;
  riskLevel: RiskLevel;
  riskScore: "low" | "medium" | "high";
  stakeAmount: number;
  estimatedPayout: number; // stake × multiplier (if it wins)
  expectedValue: number; // EV in $ at stake: stake × (jointTrueProb × multiplier − 1)
  edgePercent: number; // (Π edgeRatio − 1) × 100 — combined value of the parlay
  rationale: string; // combo-level summary of why these picks have value
}

/**
 * Automatically generate `count` diversified, non-overlapping parlay combos
 * made up ONLY of AI-vetted positive-edge bets.
 *
 * For every market we have an AI estimate of the true probability of YES. For
 * each side (YES / NO) we compute the live market price and the edge
 * (trueProb − price). A side is a "value bet" only when:
 *   • the market is AI-plausible, and
 *   • edge ≥ EDGE_THRESHOLD (the live price is genuinely cheaper than reality), and
 *   • the chosen side's true probability clears the risk-level floor.
 *
 * Combos are scored by expected value: for a parlay, EV-multiplier = Π(trueProb/price),
 * and positive EV requires the product of edge-ratios > 1. We greedily select the
 * highest-EV non-overlapping combos.
 */
export function autoGenerateCombos(opts: {
  markets: Market[];
  analyses: Map<string, { trueProbabilityYes: number; plausible: boolean; confidence: "low" | "medium" | "high"; reasoning: string }>;
  riskLevel: RiskLevel;
  stakeAmount: number;
  count?: number;
  /** Exact number of legs per combo, or "auto" to consider 2–4 legs. */
  legCount?: "auto" | 2 | 3 | 4;
}): SmartPickResult[] {
  const { markets, analyses, riskLevel, stakeAmount, count = 4, legCount = "auto" } = opts;

  const EDGE_THRESHOLD = 0.05; // require ≥5 percentage points of value

  // Per-risk tuning:
  //  • minLegTrue — minimum true probability of the CHOSEN side for a leg.
  //  • minJoint   — minimum probability the WHOLE parlay actually hits. Stops
  //    low-probability lottery combos from surfacing at all.
  //  • probBand   — width of the win-probability tier used for ranking. Combos
  //    are ranked PROBABILITY-FIRST (highest win-probability tier wins); within
  //    a tier the highest payout wins. A wider band lets return matter across a
  //    larger probability range (aggressive), a tighter band keeps it strictly
  //    probability-first (conservative).
  //  • minGeoMean — minimum acceptable per-leg average win probability. The
  //    whole-parlay floor is minGeoMean^n, so it scales with the number of legs:
  //    a fixed joint floor would unfairly reject every multi-leg combo (joint
  //    probability shrinks as legs are added), which would make the 3/4-leg
  //    options return nothing. A geometric floor keeps each leg high-quality
  //    while still letting users opt into more legs for a bigger payout.
  const RISK_TUNING: Record<
    RiskLevel,
    { minLegTrue: number; minGeoMean: number; probBand: number }
  > = {
    conservative: { minLegTrue: 0.6, minGeoMean: 0.67, probBand: 0.08 },
    balanced: { minLegTrue: 0.45, minGeoMean: 0.55, probBand: 0.12 },
    aggressive: { minLegTrue: 0.3, minGeoMean: 0.39, probBand: 0.2 },
  };
  const { minLegTrue: minTrue, minGeoMean, probBand } = RISK_TUNING[riskLevel];

  // Sizes of combos to generate: a single exact size, or 2–4 in "auto" mode.
  const sizes = legCount === "auto" ? [2, 3, 4] : [legCount];

  // ── Build value-bet legs (one best side per market) ───────────────────────
  type ScoredLeg = ComboLegResult & {
    trueProbability: number;
    edge: number;
    edgeRatio: number; // trueProb / price
  };
  // Confidence-based shrinkage: blend the AI's raw estimate toward the live
  // market price. The market aggregates real money, so we only deviate from it
  // in proportion to the AI's confidence. This keeps edges credible and stops
  // overconfident estimates from compounding into fantasy parlay payouts.
  const CONF_WEIGHT: Record<"low" | "medium" | "high", number> = {
    low: 0.45,
    medium: 0.65,
    high: 0.85,
  };

  const valueLegs: ScoredLeg[] = [];

  for (const market of markets) {
    const analysis = analyses.get(`${market.platform}:${market.id}`);
    if (!analysis || !analysis.plausible) continue;

    const w = CONF_WEIGHT[analysis.confidence] ?? 0.65;
    // Shrunk true probability of YES, used consistently for both sides.
    const trueYes = w * analysis.trueProbabilityYes + (1 - w) * market.yesOdds;

    const sides = [
      { position: "yes" as const, price: market.yesOdds, trueProb: trueYes },
      { position: "no" as const, price: market.noOdds, trueProb: 1 - trueYes },
    ];

    // Pick the side with the larger positive edge.
    let best: ScoredLeg | null = null;
    for (const s of sides) {
      if (s.price <= 0 || s.price >= 1) continue;
      const edge = s.trueProb - s.price;
      if (edge < EDGE_THRESHOLD) continue;
      if (s.trueProb < minTrue) continue;
      const edgeRatio = s.trueProb / s.price;
      const leg: ScoredLeg = {
        marketId: market.id,
        platform: market.platform,
        marketTitle: market.title,
        position: s.position,
        odds: s.price,
        impliedProb: s.price,
        trueProbability: s.trueProb,
        edge,
        edgeRatio,
        aiReasoning: analysis.reasoning,
        aiConfidence: analysis.confidence,
      };
      if (!best || leg.edge > best.edge) best = leg;
    }
    if (best) valueLegs.push(best);
  }

  // Sort by edge so the strongest value bets are preferred.
  valueLegs.sort((a, b) => b.edge - a.edge);
  const topLegs = valueLegs.slice(0, 50);

  if (topLegs.length < 2) return [];

  // ── Generate 2–4 leg combos, scored by expected value ────────────────────
  type RawCombo = {
    legs: ScoredLeg[];
    jointTrueProb: number;
    multiplier: number;
    evMultiplier: number; // Π(trueProb / price)
  };
  const allRaw: RawCombo[] = [];

  for (const size of sizes) {
    if (size > topLegs.length) continue;
    for (const legs of combinations(topLegs, size)) {
      // Correlation guard: reject combos with two legs from the same market
      // "family" (e.g. "CPI rise > 0.0% in June" and "CPI rise > 0.1% in June").
      // Such legs are highly correlated, so multiplying their probabilities as
      // if independent is statistically invalid and inflates the apparent edge.
      const families = new Set(legs.map((l) => marketFamilyKey(l.marketTitle)));
      if (families.size < legs.length) continue;

      const jointTrueProb = legs.reduce((acc, l) => acc * l.trueProbability, 1);
      const jointPrice = legs.reduce((acc, l) => acc * l.impliedProb, 1);
      if (jointPrice < 0.0005) continue; // skip near-impossible payouts
      const multiplier = 1 / jointPrice;
      const evMultiplier = legs.reduce((acc, l) => acc * l.edgeRatio, 1);
      if (evMultiplier <= 1) continue; // only positive-EV parlays
      // Leg-count-aware floor: require the parlay's per-leg average win
      // probability to clear minGeoMean (floor = minGeoMean^legs). Keeps each
      // leg high-quality while scaling sensibly as legs are added.
      if (jointTrueProb < Math.pow(minGeoMean, legs.length)) continue;

      allRaw.push({ legs, jointTrueProb, multiplier, evMultiplier });
    }
  }

  // Rank PROBABILITY-FIRST: bucket combos into win-probability tiers (band width
  // depends on risk) and order the highest-probability tier first. Within a tier
  // (where win odds are comparable) the highest payout wins. This guarantees the
  // safest bets surface first while still rewarding the best return available at
  // that probability — no longshot can leapfrog a likelier combo on payout alone.
  const tierOf = (p: number) => Math.floor(p / probBand);
  allRaw.sort((a, b) => {
    const tierA = tierOf(a.jointTrueProb);
    const tierB = tierOf(b.jointTrueProb);
    if (tierA !== tierB) return tierB - tierA; // higher win-probability tier first
    return b.multiplier - a.multiplier; // within tier, best return first
  });

  // ── Greedy non-overlapping selection ─────────────────────────────────────
  const usedMarkets = new Set<string>();
  const selected: SmartPickResult[] = [];

  for (const candidate of allRaw) {
    if (selected.length >= count) break;
    const hasOverlap = candidate.legs.some(
      (l) => usedMarkets.has(`${l.platform}:${l.marketId}`),
    );
    if (hasOverlap) continue;
    for (const l of candidate.legs) usedMarkets.add(`${l.platform}:${l.marketId}`);

    const riskScore: SmartPickResult["riskScore"] =
      candidate.jointTrueProb >= 0.3 ? "low" :
      candidate.jointTrueProb >= 0.1 ? "medium" : "high";

    const edgePercent = (candidate.evMultiplier - 1) * 100;
    const expectedValue =
      stakeAmount * (candidate.jointTrueProb * candidate.multiplier - 1);

    const topLeg = [...candidate.legs].sort((a, b) => b.edge - a.edge)[0];
    const rationale = `${(candidate.jointTrueProb * 100).toFixed(0)}% chance to hit · +${edgePercent.toFixed(0)}% edge across ${candidate.legs.length} value bets — strongest: ${topLeg.marketTitle} (${topLeg.position.toUpperCase()}, +${(topLeg.edge * 100).toFixed(0)} pts).`;

    selected.push({
      legs: candidate.legs.map((l) => ({
        marketId: l.marketId,
        platform: l.platform,
        marketTitle: l.marketTitle,
        position: l.position,
        odds: l.odds,
        impliedProb: l.impliedProb,
        trueProbability: l.trueProbability,
        edge: l.edge,
        aiReasoning: l.aiReasoning,
        aiConfidence: l.aiConfidence,
      })),
      jointProbability: candidate.jointTrueProb,
      payoutMultiplier: candidate.multiplier,
      riskLevel,
      riskScore,
      stakeAmount,
      estimatedPayout: stakeAmount * candidate.multiplier,
      expectedValue,
      edgePercent,
      rationale,
    });
  }

  return selected;
}

// ─── Portfolio overlap detection ─────────────────────────────────────────────

// Detect portfolio-level overlap: find legs that appear in ALL saved combos
export interface OverlapWarning {
  marketId: string;
  platform: string;
  marketTitle: string;
  position: string;
}

export function detectPortfolioOverlap(
  combos: Array<{ legs: Array<{ marketId: string; platform: string; marketTitle: string; position: string }> }>,
): OverlapWarning[] {
  if (combos.length < 2) return [];

  // Count how many combos each leg appears in
  const legCounts = new Map<string, { count: number; detail: OverlapWarning }>();

  for (const combo of combos) {
    // Use a set per combo to avoid double-counting
    const seenInCombo = new Set<string>();
    for (const leg of combo.legs) {
      const key = `${leg.platform}:${leg.marketId}:${leg.position}`;
      if (!seenInCombo.has(key)) {
        seenInCombo.add(key);
        const existing = legCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          legCounts.set(key, {
            count: 1,
            detail: {
              marketId: leg.marketId,
              platform: leg.platform,
              marketTitle: leg.marketTitle,
              position: leg.position,
            },
          });
        }
      }
    }
  }

  // A leg is a portfolio overlap if it appears in ALL combos
  const overlaps: OverlapWarning[] = [];
  for (const [, entry] of legCounts) {
    if (entry.count === combos.length) {
      overlaps.push(entry.detail);
    }
  }
  return overlaps;
}
