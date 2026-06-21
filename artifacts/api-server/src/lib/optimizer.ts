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
  closeTime?: string | null; // ISO resolution time of the market (Smart Picks legs)
  // "value" = genuinely mispriced (edge ≥ threshold). "safe" = a high-probability
  // favorite the AI is confident in but the market prices fairly (edge ≥ 0).
  legType?: "value" | "safe";
  // Human-readable pick: which outcome to back on the platform, e.g. "Senegal to
  // win" / "Not Senegal" (Kalshi) or "Yes" / "No" (Polymarket). Disambiguates
  // markets that share a title across multiple outcome contracts.
  selection?: string;
}

/**
 * Build the human-readable pick label for a leg. On Kalshi, several contracts
 * share one title (e.g. "Senegal vs Iraq Winner?" → Senegal / Iraq / Tie), so
 * "YES" alone is ambiguous; we surface the specific side from yesSubtitle.
 */
function sideLabel(
  title: string,
  yesSubtitle: string | null | undefined,
  position: "yes" | "no",
): string {
  const sub = yesSubtitle?.trim();
  if (sub) {
    // Head-to-head markets ("Senegal vs Iraq Winner?") read naturally as
    // "<team> to win". Threshold/other markets (e.g. yes_sub_title "Above 3.75%")
    // must stay verbatim — appending "to win" there reads wrong.
    const isMatch = /\bvs\.?\b/i.test(title);
    const isTie = /^tie$/i.test(sub);
    const yesText = isMatch && !isTie ? `${sub} to win` : sub;
    return position === "yes" ? yesText : `Not ${sub}`;
  }
  return position === "yes" ? "Yes" : "No";
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

/**
 * Title patterns that identify a shared competition/event across BOTH platforms.
 * Two markets matching the same pattern are correlated (same tournament, or
 * mutually-exclusive outcomes of one event) and must never share a combo — the
 * platform won't let you parlay them, and multiplying their probabilities as if
 * independent is statistically invalid. This is the cross-platform bridge: e.g.
 * a Polymarket "Will Morocco win the 2026 FIFA World Cup?" outright and a Kalshi
 * World Cup match both resolve to the same "fifa-world-cup" group.
 */
const COMPETITION_TITLE_PATTERNS: [RegExp, string][] = [
  [/world cup|\bfifa\b/i, "fifa-world-cup"],
  [/super bowl/i, "nfl-superbowl"],
  [/champions league|\bucl\b/i, "uefa-champions-league"],
  [/premier league|\bepl\b/i, "epl"],
  [/\bla liga\b/i, "la-liga"],
  [/stanley cup/i, "nhl-stanley-cup"],
  [/\bnba\b (finals|championship)|nba finals/i, "nba-championship"],
  [/world series/i, "mlb-world-series"],
  [/\bnba\b (mvp|most valuable)/i, "nba-mvp"],
  [/\bnfl\b (mvp|most valuable)/i, "nfl-mvp"],
];

/**
 * Map a Kalshi series-ticker prefix (the part of the market id before the first
 * "-") to a canonical competition group. Markets in the same competition (all
 * World Cup games + totals, all of one election's candidates, all S&P levels…)
 * collapse together so a combo never contains two correlated legs. Unmapped
 * prefixes fall through to the prefix itself, which still groups same-series
 * markets (e.g. two thresholds of the same CPI release).
 */
function kalshiCompetitionGroup(ticker: string): string {
  const dash = ticker.indexOf("-");
  const prefix = (dash === -1 ? ticker : ticker.slice(0, dash)).toUpperCase();
  if (prefix.startsWith("KXWC")) return "fifa-world-cup";
  if (prefix.startsWith("KXNBA")) return "nba";
  if (prefix.startsWith("KXNFL")) return "nfl";
  if (prefix.startsWith("KXMLB")) return "mlb";
  if (prefix.startsWith("KXNHL")) return "nhl";
  if (prefix.startsWith("KXEPL")) return "epl";
  if (prefix.startsWith("KXUCL")) return "uefa-champions-league";
  return prefix;
}

/** A single head-to-head match ("A vs B"), as opposed to a season/tournament
 * outright or a threshold market. Used to allow parlaying several INDEPENDENT
 * matches of the same competition while still blocking outright winners (which
 * correlate with every game) and same-event outcomes. */
function isMatchMarket(title: string): boolean {
  return /\bvs\.?\b|\bversus\b/i.test(title);
}

interface LegCorrelation {
  /** Groups outcomes of the SAME underlying event (e.g. both sides of one
   * match, or every candidate in one election). */
  eventKey: string;
  /** Canonical competition/tournament, or null if the market isn't part of a
   * recognised competition. */
  competition: string | null;
  /** True for a single head-to-head match (independent of other matches). */
  isMatch: boolean;
  /** Normalised title family — catches the same market at different thresholds. */
  family: string;
}

function legCorrelation(leg: {
  platform: string;
  marketId: string;
  marketTitle: string;
}): LegCorrelation {
  let competition: string | null = null;
  for (const [re, key] of COMPETITION_TITLE_PATTERNS) {
    if (re.test(leg.marketTitle)) {
      competition = key;
      break;
    }
  }
  // Kalshi: the ticker prefix names the series/competition even when the title
  // (e.g. "Tunisia vs Netherlands Winner?") doesn't mention the tournament.
  if (competition === null && leg.platform === "kalshi") {
    competition = kalshiCompetitionGroup(leg.marketId);
  }

  // Event key. Kalshi tickers are "<series>-<event>-<outcome>" — dropping the
  // outcome segment groups every outcome of one event together. Polymarket
  // exposes no event grouping in our data, so each market stands alone.
  let eventKey: string;
  if (leg.platform === "kalshi") {
    const parts = leg.marketId.split("-");
    eventKey =
      parts.length > 2 ? parts.slice(0, -1).join("-") : leg.marketId;
  } else {
    eventKey = leg.marketId;
  }

  return {
    eventKey: `${leg.platform}:${eventKey}`,
    competition,
    isMatch: isMatchMarket(leg.marketTitle),
    family: marketFamilyKey(leg.marketTitle),
  };
}

/**
 * Decide whether a set of legs is safe to parlay together. Rejects when any two
 * legs are correlated — i.e. the platform won't let you place the combo and
 * multiplying their probabilities as if independent is statistically invalid:
 *  1. Same underlying event (both sides of one match, or two candidates in one
 *     mutually-exclusive race).
 *  2. Same competition where at least one leg is NOT an independent match — an
 *     outright winner ("Will Morocco win the World Cup?") correlates with every
 *     game and with every other team's outright, and threshold markets (two S&P
 *     or CPI levels) move together. Two DIFFERENT matches of the same
 *     competition are allowed (a normal multi-game sports parlay).
 *  3. Same title family (the same market quoted at different thresholds).
 */
function legsAreCorrelated(legs: LegCorrelation[]): boolean {
  const events = new Set<string>();
  const families = new Set<string>();
  const byCompetition = new Map<string, LegCorrelation[]>();

  for (const leg of legs) {
    if (events.has(leg.eventKey)) return true;
    events.add(leg.eventKey);
    if (families.has(leg.family)) return true;
    families.add(leg.family);
    if (leg.competition !== null) {
      const arr = byCompetition.get(leg.competition) ?? [];
      arr.push(leg);
      byCompetition.set(leg.competition, arr);
    }
  }

  for (const arr of byCompetition.values()) {
    // Multiple legs in one competition are only OK when every one is an
    // independent match; any outright/threshold leg makes them correlated.
    if (arr.length > 1 && !arr.every((l) => l.isMatch)) return true;
  }

  return false;
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
  /**
   * MINIMUM number of legs per combo, or "auto" for no minimum (2+). A value of
   * N means "N or more legs" — the optimizer considers every size from N up to
   * however many quality legs exist, with no artificial cap. "5" therefore
   * permits large combos (10, 20+ legs) when enough quality legs are available.
   */
  legCount?: "auto" | 1 | 2 | 3 | 4 | 5;
}): SmartPickResult[] {
  const { markets, analyses, riskLevel, stakeAmount, count = 4, legCount = "auto" } = opts;

  const EDGE_THRESHOLD = 0.05; // require ≥5 percentage points of value to be a "value" bet
  // Hard cap on the candidate-leg pool fed into combination enumeration. With N
  // legs we may enumerate up to 2^N subsets across all sizes, so this MUST stay
  // small enough to stay tractable (2^16 ≈ 65k). In practice the quality-leg pool
  // is far smaller than this; the cap only guards pathological pools.
  const TOP_LEGS_CAP = 16;

  // Per-risk tuning:
  //  • minLegTrue — minimum true probability of the CHOSEN side for a leg.
  //  • minJoint   — minimum probability the WHOLE parlay actually hits. Stops
  //    low-probability lottery combos from surfacing at all.
  //  (Ranking is by EXPECTED RETURN — see the sort below — not a probability
  //  tier, so there is no band here; the floors in this block keep each combo's
  //  win probability sane for the chosen risk level.)
  //  • minGeoMean — minimum acceptable per-leg average win probability. The
  //    whole-parlay floor is minGeoMean^n, so it scales with the number of legs:
  //    a fixed joint floor would unfairly reject every multi-leg combo (joint
  //    probability shrinks as legs are added), which would make the 3/4-leg
  //    options return nothing. A geometric floor keeps each leg high-quality
  //    while still letting users opt into more legs for a bigger payout.
  //  • safeMinTrue — minimum true probability for a "safe favorite": a leg the AI
  //    is confident in that the market prices fairly (edge ≥ 0 but < threshold).
  //    These fill out larger combos when genuine value bets are scarce.
  const RISK_TUNING: Record<
    RiskLevel,
    { minLegTrue: number; minGeoMean: number; safeMinTrue: number }
  > = {
    conservative: { minLegTrue: 0.6, minGeoMean: 0.67, safeMinTrue: 0.8 },
    balanced: { minLegTrue: 0.45, minGeoMean: 0.55, safeMinTrue: 0.7 },
    aggressive: { minLegTrue: 0.3, minGeoMean: 0.39, safeMinTrue: 0.6 },
  };
  const { minLegTrue: minTrue, minGeoMean, safeMinTrue } = RISK_TUNING[riskLevel];

  // Combo sizes to generate. legCount is now a MINIMUM: "auto" means 2+, while a
  // number N means "N or more legs". The upper bound is however many quality legs
  // exist (capped at TOP_LEGS_CAP) — no artificial 4-leg ceiling. The geometric
  // floor + probability-first ranking naturally bound runaway leg counts.
  const minLegs = legCount === "auto" ? 2 : Math.max(2, legCount);

  // ── Build value-bet legs (one best side per market) ───────────────────────
  type ScoredLeg = ComboLegResult & {
    trueProbability: number;
    edge: number;
    edgeRatio: number; // trueProb / price
    legType: "value" | "safe";
    category: string; // used to keep every combo within one placeable category
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

    // For each market pick a single best side, classifying it as either a
    // genuine "value" bet (edge ≥ threshold AND clears the value floor) or, if no
    // value side exists, a "safe favorite" (high-probability, fairly-priced,
    // edge ≥ 0). Value always wins over safe; within a class the stronger leg wins.
    let best: ScoredLeg | null = null;
    for (const s of sides) {
      if (s.price <= 0 || s.price >= 1) continue;
      const edge = s.trueProb - s.price;
      const edgeRatio = s.trueProb / s.price;

      const isValue = edge >= EDGE_THRESHOLD && s.trueProb >= minTrue;
      // Safe favorite: not (yet) a value bet, but a confident high-probability
      // favorite the market isn't underpricing against us (edge ≥ 0). Low-
      // confidence estimates are excluded so we never pad combos with guesses.
      const isSafe =
        !isValue &&
        edge >= 0 &&
        s.trueProb >= safeMinTrue &&
        analysis.confidence !== "low";

      if (!isValue && !isSafe) continue;

      const leg: ScoredLeg = {
        marketId: market.id,
        platform: market.platform,
        marketTitle: market.title,
        category: market.category ?? "Other",
        position: s.position,
        selection: sideLabel(market.title, market.yesSubtitle, s.position),
        odds: s.price,
        impliedProb: s.price,
        trueProbability: s.trueProb,
        edge,
        edgeRatio,
        legType: isValue ? "value" : "safe",
        aiReasoning: analysis.reasoning,
        aiConfidence: analysis.confidence,
        closeTime: market.closeTime,
      };

      if (!best) {
        best = leg;
      } else if (best.legType === leg.legType) {
        // Same class: prefer the stronger leg (value → bigger edge, safe → higher prob).
        const better =
          leg.legType === "value"
            ? leg.edge > best.edge
            : leg.trueProbability > best.trueProbability;
        if (better) best = leg;
      } else if (leg.legType === "value") {
        best = leg; // value always beats safe
      }
    }
    if (best) valueLegs.push(best);
  }

  // Order the candidate pool: value bets first (sorted by edge), then safe
  // favorites (sorted by win probability). Slicing keeps the highest-quality legs
  // and enforces the enumeration cap.
  valueLegs.sort((a, b) => {
    if (a.legType !== b.legType) return a.legType === "value" ? -1 : 1;
    if (a.legType === "value") return b.edge - a.edge;
    return b.trueProbability - a.trueProbability;
  });
  // ── Group legs into single platform + category pools ──────────────────────
  // A parlay must be PLACEABLE: every leg has to live on the same platform (you
  // build one slip on one site) and in the same category (the platform won't let
  // you combine, say, a World Cup match with a presidential market). So we never
  // mix platforms or categories inside a combo — legs are grouped by
  // platform+category and every combo is enumerated strictly within one group.
  const groups = new Map<string, ScoredLeg[]>();
  for (const leg of valueLegs) {
    const key = `${leg.platform}::${leg.category}`;
    const arr = groups.get(key) ?? [];
    arr.push(leg);
    groups.set(key, arr);
  }

  // ── Enumerate combos within each group, scored by expected value ──────────
  type RawCombo = {
    legs: ScoredLeg[];
    jointTrueProb: number;
    multiplier: number;
    evMultiplier: number; // Π(trueProb / price)
  };
  const allRaw: RawCombo[] = [];

  for (const groupLegs of groups.values()) {
    // valueLegs is pre-sorted (value bets by edge, then safe favorites by
    // probability), so this slice keeps the highest-quality legs per group while
    // bounding enumeration (2^n subsets) to a tractable size.
    const pool = groupLegs.slice(0, TOP_LEGS_CAP);
    if (pool.length < minLegs) continue;

    // Sizes from the requested minimum up to the group size — legCount is a
    // MINIMUM, so there is no artificial leg ceiling; the geometric probability
    // floor below naturally bounds how many legs a surfaced combo can have.
    for (let size = minLegs; size <= pool.length; size++) {
      for (const legs of combinations(pool, size)) {
        // Correlation guard: reject combos whose legs aren't independent — same
        // event (both sides of one match), same competition with an outright/
        // threshold leg (a World Cup match + "Will Morocco win the World Cup?",
        // or two mutually-exclusive outright winners), or the same market at
        // different thresholds. Independent matches of one competition are kept.
        if (legsAreCorrelated(legs.map((l) => legCorrelation(l)))) continue;

        const jointTrueProb = legs.reduce((acc, l) => acc * l.trueProbability, 1);
        const jointPrice = legs.reduce((acc, l) => acc * l.impliedProb, 1);
        if (jointPrice < 0.0005) continue; // skip near-impossible payouts
        const multiplier = 1 / jointPrice;
        const evMultiplier = legs.reduce((acc, l) => acc * l.edgeRatio, 1);
        // Never negative-EV. Every leg has edge ≥ 0 (edgeRatio ≥ 1), so a
        // combined multiplier ≥ 1 is guaranteed; safe-favorite-only parlays
        // (≈1.0) are kept, genuinely-bad parlays (< 1, float drift) are dropped.
        if (evMultiplier < 1) continue;
        // Leg-count-aware floor: require the parlay's per-leg average win
        // probability to clear minGeoMean (floor = minGeoMean^legs). Keeps each
        // leg high-quality while scaling sensibly as legs are added.
        if (jointTrueProb < Math.pow(minGeoMean, legs.length)) continue;

        allRaw.push({ legs, jointTrueProb, multiplier, evMultiplier });
      }
    }
  }

  // Rank by EXPECTED RETURN per $1 staked = jointTrueProb × payoutMultiplier
  // (equivalently Π(trueProb / price), the combined edge ratio). This single
  // number is exactly what the user asked to optimise: a higher win probability
  // AND a higher payout both push it up, while a longshot whose payout doesn't
  // justify its small chance ranks low. The per-risk probability floors above
  // keep the pool sane, so the best risk-adjusted combos surface first. Ties
  // break toward the more likely (and therefore typically smaller) combo.
  allRaw.sort((a, b) => {
    if (b.evMultiplier !== a.evMultiplier) return b.evMultiplier - a.evMultiplier;
    return b.jointTrueProb - a.jointTrueProb;
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

    const nValue = candidate.legs.filter((l) => l.legType === "value").length;
    const nSafe = candidate.legs.length - nValue;
    const composition =
      nValue > 0 && nSafe > 0
        ? `${nValue} value + ${nSafe} safe`
        : nValue > 0
          ? `${nValue} value bet${nValue > 1 ? "s" : ""}`
          : `${nSafe} safe pick${nSafe > 1 ? "s" : ""}`;
    // Highlight the strongest leg: the biggest-edge value bet if any, else the
    // highest-probability safe favorite.
    const topLeg = [...candidate.legs].sort((a, b) =>
      a.legType !== b.legType
        ? a.legType === "value"
          ? -1
          : 1
        : a.legType === "value"
          ? b.edge - a.edge
          : b.trueProbability - a.trueProbability,
    )[0];
    const topLegNote =
      topLeg.legType === "value"
        ? `+${(topLeg.edge * 100).toFixed(0)} pts edge`
        : `${(topLeg.trueProbability * 100).toFixed(0)}% likely`;
    const topLegPick = topLeg.selection ?? topLeg.position.toUpperCase();
    const rationale = `${(candidate.jointTrueProb * 100).toFixed(0)}% chance to hit · +${edgePercent.toFixed(0)}% edge across ${composition} — strongest: ${topLeg.marketTitle} (${topLegPick}, ${topLegNote}).`;

    selected.push({
      legs: candidate.legs.map((l) => ({
        marketId: l.marketId,
        platform: l.platform,
        marketTitle: l.marketTitle,
        position: l.position,
        selection: l.selection,
        odds: l.odds,
        impliedProb: l.impliedProb,
        trueProbability: l.trueProbability,
        edge: l.edge,
        legType: l.legType,
        aiReasoning: l.aiReasoning,
        aiConfidence: l.aiConfidence,
        closeTime: l.closeTime,
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
