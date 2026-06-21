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
  jointProbability: number;
  payoutMultiplier: number;
  riskLevel: RiskLevel;
  riskScore: "low" | "medium" | "high";
  estimatedPayout: number;
}

/**
 * Automatically generate `count` diversified, non-overlapping parlay combos
 * from the full live market pool.
 *
 * Algorithm:
 *  1. Expand each market into YES and NO candidate legs.
 *  2. Filter to legs whose odds fall within the risk-level range.
 *  3. Score each leg by volume × interest (closeness to 50%).
 *  4. Take the top-N unique-market legs.
 *  5. Generate all 2-leg and 3-leg (+ 4-leg for aggressive) combos.
 *  6. Score each combo: payoutMultiplier × jointProbability^alpha
 *     (alpha varies by risk level — higher = prefer safer combos).
 *  7. Greedy non-overlapping selection: pick the top-scoring combo, mark its
 *     markets as used, repeat until `count` combos are collected.
 */
export function autoGenerateCombos(opts: {
  markets: Market[];
  riskLevel: RiskLevel;
  stakeAmount: number;
  count?: number;
}): SmartPickResult[] {
  const { markets, riskLevel, stakeAmount, count = 4 } = opts;

  // Odds range (per leg's chosen position) and scoring alpha per risk level.
  // Ranges are intentionally generous so the pool stays large enough to form
  // 4 non-overlapping combos across typical live market pools (~100–300 mkts).
  const RISK_CONFIG: Record<RiskLevel, { min: number; max: number; alpha: number; maxSize: number }> = {
    conservative: { min: 0.50, max: 0.92, alpha: 0.75, maxSize: 3 },
    balanced:     { min: 0.28, max: 0.82, alpha: 0.50, maxSize: 3 },
    aggressive:   { min: 0.12, max: 0.72, alpha: 0.25, maxSize: 4 },
  };
  const { min, max, alpha, maxSize } = RISK_CONFIG[riskLevel];

  // ── Step 1-3: candidate legs ──────────────────────────────────────────────
  type ScoredLeg = ComboLegResult & { legScore: number };
  const candidateLegs: ScoredLeg[] = [];

  for (const market of markets) {
    for (const position of ["yes", "no"] as const) {
      const odds = position === "yes" ? market.yesOdds : market.noOdds;
      if (odds < min || odds > max) continue;
      const vol = market.volume ?? 0;
      // interest: 1 at 50%, 0 at 0%/100%
      const interest = 1 - Math.abs(odds - 0.5) * 2;
      const legScore = (Math.log1p(vol) + 1) * (interest + 0.1);
      candidateLegs.push({
        marketId: market.id,
        platform: market.platform,
        marketTitle: market.title,
        position,
        odds,
        impliedProb: odds,
        legScore,
      });
    }
  }

  // ── Step 4: keep top-N, one entry per market (prefer the higher-scored position) ──
  candidateLegs.sort((a, b) => b.legScore - a.legScore);
  const seenMarkets = new Set<string>();
  const topLegs: ScoredLeg[] = [];
  for (const leg of candidateLegs) {
    const mk = `${leg.platform}:${leg.marketId}`;
    if (!seenMarkets.has(mk)) {
      seenMarkets.add(mk);
      topLegs.push(leg);
      if (topLegs.length >= 80) break;
    }
  }

  if (topLegs.length < 2) return [];

  // ── Step 5: enumerate combos ─────────────────────────────────────────────
  const forSmall = topLegs.slice(0, 60);   // 2-3 legs  C(60,3)=34220 — fast
  const forLarge = topLegs.slice(0, 25);   // 4 legs    C(25,4)=12650 — fast

  type RawCombo = { legs: ScoredLeg[]; score: number; jointProb: number; multiplier: number };
  const allRaw: RawCombo[] = [];

  for (let size = 2; size <= maxSize; size++) {
    const source = size <= 3 ? forSmall : forLarge;
    for (const legs of combinations(source, size)) {
      const jointProb = legs.reduce((acc, l) => acc * l.impliedProb, 1);
      if (jointProb < 0.005) continue; // Skip near-impossible combos
      const multiplier = 1 / jointProb;
      // score = multiplier × prob^alpha = (1/p) × p^alpha = p^(alpha-1)
      // alpha < 1 → higher payout preferred but less aggressively as alpha→1
      const score = multiplier * Math.pow(jointProb, alpha);
      allRaw.push({ legs, score, jointProb, multiplier });
    }
  }

  // ── Step 6: sort by score ─────────────────────────────────────────────────
  allRaw.sort((a, b) => b.score - a.score);

  // ── Step 7: greedy non-overlapping selection ─────────────────────────────
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
      candidate.jointProb >= 0.30 ? "low" :
      candidate.jointProb >= 0.10 ? "medium" : "high";

    selected.push({
      legs: candidate.legs,
      jointProbability: candidate.jointProb,
      payoutMultiplier: candidate.multiplier,
      riskLevel,
      riskScore,
      estimatedPayout: stakeAmount * candidate.multiplier,
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
