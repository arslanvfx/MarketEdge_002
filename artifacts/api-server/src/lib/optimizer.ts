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
  // Kalshi grouping (null for Polymarket): eventTicker = the underlying market
  // (every outcome/threshold shares it); gameKey = the physical game, shared by a
  // game's different prop series (winner/total/spread/corners/player props).
  eventTicker?: string | null;
  gameKey?: string | null;
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
    // Head-to-head WINNER markets ("Senegal vs Iraq Winner?") read naturally as
    // "<team> to win". Threshold and same-game PROP markets must stay verbatim —
    // appending "to win" to "Over 2.5 goals scored" or "Above 3.75%" reads wrong.
    // A prop subtitle is a full phrase (digits or stat words), not a bare team.
    const isMatch = /\bvs\.?\b/i.test(title);
    const isTie = /^tie$/i.test(sub);
    const isProp =
      /\d|\bover\b|\bunder\b|goals?|corners?|points?|assists?|rebounds?|\bscore\b|wins? by|both teams|spread|total|handicap|margin/i.test(
        sub,
      );
    const yesText = isMatch && !isTie && !isProp ? `${sub} to win` : sub;
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

interface LegCorrelation {
  /** Groups outcomes of the SAME underlying market (every team in one winner
   * market, every threshold of one totals ladder). Two legs sharing it can never
   * be parlayed. */
  eventKey: string;
  /** The physical GAME (Kalshi gameKey), shared across a game's different prop
   * series (winner/total/spread/corners/player props). Legs sharing it but with
   * different eventKeys are a legitimate Kalshi same-game combo. Null for
   * non-game markets (outrights, futures, economic thresholds) and Polymarket. */
  gameKey: string | null;
  /** Canonical competition/tournament, or null if the market isn't part of a
   * recognised competition. */
  competition: string | null;
  /** A market tied to a whole competition rather than one game — a tournament/
   * season outright, award, or threshold ladder. Correlates with every game and
   * every other outright in its competition, so it can never share a combo. */
  isOutright: boolean;
  /** Normalised title family — catches the same market at different thresholds. */
  family: string;
}

function legCorrelation(leg: {
  platform: string;
  marketId: string;
  marketTitle: string;
  eventTicker?: string | null;
  gameKey?: string | null;
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

  // Event key = the underlying market. Prefer Kalshi's authoritative event_ticker
  // (every outcome AND every threshold of one market share it, even multi-segment
  // player props). Fall back to dropping the outcome segment, then the id itself.
  // Polymarket exposes no event grouping, so each market stands alone.
  let eventKey: string;
  if (leg.platform === "kalshi") {
    if (leg.eventTicker) {
      eventKey = leg.eventTicker;
    } else {
      const parts = leg.marketId.split("-");
      eventKey = parts.length > 2 ? parts.slice(0, -1).join("-") : leg.marketId;
    }
  } else {
    eventKey = leg.marketId;
  }

  const gameKey = leg.gameKey ?? null;
  // An outright correlates with its whole competition. It's any competition
  // market that ISN'T a specific dated game: tournament/season winners, awards,
  // and threshold ladders (S&P levels, CPI). Game props all carry a gameKey.
  const isOutright = competition !== null && gameKey === null;

  return {
    eventKey: `${leg.platform}:${eventKey}`,
    gameKey: gameKey === null ? null : `${leg.platform}:${gameKey}`,
    competition,
    isOutright,
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
  const nonGameFamilies = new Set<string>();
  const byCompetition = new Map<string, LegCorrelation[]>();

  for (const leg of legs) {
    // (1) Two legs of the SAME underlying market — two winner outcomes, or two
    // thresholds of one totals ladder — can never be parlayed.
    if (events.has(leg.eventKey)) return true;
    events.add(leg.eventKey);

    // (3) Title-family guard, but ONLY for non-game markets (economic/crypto
    // thresholds, futures). Dated game props legitimately share families across
    // different games — every game has a "total goals" market — and Kalshi lets
    // you parlay them, so the family guard must not block multi-game prop combos.
    if (!leg.gameKey) {
      if (nonGameFamilies.has(leg.family)) return true;
      nonGameFamilies.add(leg.family);
    }

    if (leg.competition !== null) {
      const arr = byCompetition.get(leg.competition) ?? [];
      arr.push(leg);
      byCompetition.set(leg.competition, arr);
    }
  }

  // (2) Within one competition, an OUTRIGHT (tournament/season winner, award, or
  // threshold ladder) correlates with every game and every other outright, so it
  // can never share a combo. Game legs — whether the SAME game (a same-game prop
  // combo: winner + total + spread + corners…) or DIFFERENT games (a multi-game
  // parlay) — are independent enough to parlay; same-market dupes are already
  // caught by the event guard above.
  for (const arr of byCompetition.values()) {
    if (arr.length > 1 && arr.some((l) => l.isOutright)) return true;
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
        eventTicker: market.eventTicker ?? null,
        gameKey: market.gameKey ?? null,
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
  //  • minLegTrue   — minimum true probability of the CHOSEN side for a leg.
  //  • minGeoMean   — per-leg geometric floor (whole-parlay floor = minGeoMean^n),
  //    keeps each leg high-quality while scaling with leg count.
  //  • safeMinTrue  — minimum true probability for "safe favorite" legs.
  //  • minJointProb — hard absolute floor on the whole parlay's win probability.
  //    Prevents low-probability lottery combos (e.g. 5% chance, 1900x) regardless
  //    of how many legs are added. The geometric floor alone can't do this because
  //    minGeoMean^n → 0 as n grows.
  //  • maxAutoLegs  — hard upper bound on combo leg count when legCount="auto".
  //    Stops the EV ranking from surfacing absurd 8-leg parlays; explicit legCount
  //    values let the user consciously opt into more legs.
  const RISK_TUNING: Record<
    RiskLevel,
    { minLegTrue: number; minGeoMean: number; safeMinTrue: number; minJointProb: number; maxAutoLegs: number }
  > = {
    conservative: { minLegTrue: 0.6, minGeoMean: 0.67, safeMinTrue: 0.8, minJointProb: 0.25, maxAutoLegs: 3 },
    balanced:     { minLegTrue: 0.45, minGeoMean: 0.55, safeMinTrue: 0.7, minJointProb: 0.12, maxAutoLegs: 4 },
    aggressive:   { minLegTrue: 0.3, minGeoMean: 0.39, safeMinTrue: 0.6, minJointProb: 0.06, maxAutoLegs: 4 },
  };
  const { minLegTrue: minTrue, minGeoMean, safeMinTrue, minJointProb, maxAutoLegs } = RISK_TUNING[riskLevel];

  // Combo sizes: legCount is a MINIMUM (2, 3, 4, 5 or "auto" = 2+).
  // Auto mode is capped at maxAutoLegs so EV-ranking doesn't surface 8-leg lottery
  // parlays the user never asked for. Explicit leg counts let the user consciously
  // opt into larger combos.
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
        eventTicker: market.eventTicker ?? null,
        gameKey: market.gameKey ?? null,
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
    // Polymarket combos aren't reliably placeable — the Gamma feed exposes no
    // event grouping or combo pricing — so we surface Polymarket as the best
    // SINGLE bets (one leg each) instead of parlays. Kalshi keeps multi-leg
    // combos, including same-game prop combos (winner + total + spread + …).
    const isPolymarket = pool[0]?.platform === "polymarket";
    const groupMin = isPolymarket ? 1 : minLegs;
    // For "auto" mode, cap at maxAutoLegs to prevent EV-ranking from surfacing
    // lottery parlays (e.g. 8-leg combos with 5% win probability). Users who
    // explicitly set a higher leg count consciously accept more legs.
    const autoMax = legCount === "auto" ? maxAutoLegs : pool.length;
    const groupMax = isPolymarket ? 1 : Math.min(pool.length, autoMax);
    if (pool.length < groupMin) continue;

    for (let size = groupMin; size <= groupMax; size++) {
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
        // Per-leg geometric floor: each leg's average win probability must clear
        // minGeoMean. Scales sensibly as legs are added.
        if (jointTrueProb < Math.pow(minGeoMean, legs.length)) continue;
        // Absolute joint probability floor: the whole parlay must have at least
        // minJointProb chance to hit — prevents lottery combos that pass the
        // geometric floor only because they have many mediocre legs.
        if (jointTrueProb < minJointProb) continue;

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
    // Flag pure same-game combos: every leg backs the same physical game across
    // different prop markets (winner + total + spread + …). These legs are
    // positively correlated, so Kalshi prices the parlay as one combo — our
    // figures assume independent legs and are an approximation.
    const gameKeys = candidate.legs.map((l) => l.gameKey).filter(Boolean);
    const sameGameCombo =
      candidate.legs.length > 1 &&
      gameKeys.length === candidate.legs.length &&
      new Set(gameKeys).size === 1;
    const sameGameNote = sameGameCombo
      ? " Same-game combo — legs are correlated, so figures assume independent legs (Kalshi prices the parlay)."
      : "";
    const rationale = `${(candidate.jointTrueProb * 100).toFixed(0)}% chance to hit · +${edgePercent.toFixed(0)}% edge across ${composition} — strongest: ${topLeg.marketTitle} (${topLegPick}, ${topLegNote}).${sameGameNote}`;

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
        eventTicker: l.eventTicker ?? null,
        gameKey: l.gameKey ?? null,
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
