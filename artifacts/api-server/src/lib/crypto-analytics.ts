// ---------------------------------------------------------------------------
// crypto-analytics.ts — self-learning analytics, calibration, ensemble weights
// ---------------------------------------------------------------------------

import { desc, inArray } from "drizzle-orm";
import { db, predictionRecordsTable } from "@workspace/db";
import { clamp, mean } from "./crypto-indicators";
import { CRYPTO_COINS } from "./crypto-data";
import { regimeFromER, type PromptRegime } from "./crypto-stat";
import {
  historyStore,
  rowToRecord,
  TRAINING_COINS,
  type PredictionRecord,
} from "./crypto-history";

// Confidence bands aligned to the model's clamp range (20–92).
const CONF_BANDS: Array<{ band: string; lo: number; hi: number }> = [
  { band: "20-39%", lo: 0,  hi: 40  },
  { band: "40-54%", lo: 40, hi: 55  },
  { band: "55-69%", lo: 55, hi: 70  },
  { band: "70-92%", lo: 70, hi: 101 },
];

function confBand(c: number): { band: string; lo: number; hi: number } {
  return CONF_BANDS.find((b) => c >= b.lo && c < b.hi) ?? CONF_BANDS[CONF_BANDS.length - 1];
}

const REGIMES: PromptRegime[] = ["trending", "drifting", "choppy"];

export interface SourceMetrics {
  n: number;
  hits: number;
  accuracyPct: number | null;
  brier: number | null;
  signedBiasPct: number | null;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function metricsFor(records: PredictionRecord[]): SourceMetrics {
  const ev = records.filter((r) => r.status === "evaluated" && r.correct !== null);
  const n = ev.length;
  if (n === 0) return { n: 0, hits: 0, accuracyPct: null, brier: null, signedBiasPct: null };
  const hits = ev.filter((r) => r.correct === true).length;
  const brier = mean(ev.map((r) => (r.confidence / 100 - (r.correct ? 1 : 0)) ** 2));
  const biasRecs = ev.filter((r) => r.actualPrice != null && (r.actualPrice ?? 0) > 0);
  const signedBiasPct =
    biasRecs.length > 0
      ? mean(biasRecs.map((r) => ((r.predictedPrice - (r.actualPrice ?? 1)) / (r.actualPrice ?? 1)) * 100))
      : null;
  return {
    n,
    hits,
    accuracyPct: Math.round((hits / n) * 100),
    brier: round3(brier),
    signedBiasPct: signedBiasPct != null ? round3(signedBiasPct) : null,
  };
}

export interface AbstentionMetrics {
  evaluated: number;
  avoidedLoss: number;
  missedWin: number;
  avoidedLossPct: number | null;
}

export interface CoinAnalytics {
  symbol: string;
  bySource: { stat: SourceMetrics; claude: SourceMetrics; ensemble: SourceMetrics };
  byRegime: {
    stat: Record<PromptRegime, SourceMetrics>;
    claude: Record<PromptRegime, SourceMetrics>;
    ensemble: Record<PromptRegime, SourceMetrics>;
  };
  abstention: AbstentionMetrics;
  calibration: Array<{ band: string; n: number; avgConfidencePct: number | null; hitRatePct: number | null }>;
  ensembleWeights: {
    overall: EnsembleWeights;
    byRegime: Record<PromptRegime, EnsembleWeights>;
  };
}

function regimeBreakdown(records: PredictionRecord[]): Record<PromptRegime, SourceMetrics> {
  const out = {} as Record<PromptRegime, SourceMetrics>;
  for (const reg of REGIMES) {
    out[reg] = metricsFor(
      records.filter((r) => r.efficiencyRatio != null && regimeFromER(r.efficiencyRatio) === reg),
    );
  }
  return out;
}

function bandValue(r: PredictionRecord): number {
  return r.rawConfidence ?? r.confidence;
}

export function getPredictionAnalytics(symbol: string): CoinAnalytics {
  const recs = historyStore.get(symbol.toUpperCase()) ?? [];
  const stat = recs.filter((r) => r.source === "stat");
  const claude = recs.filter((r) => r.source === "claude");
  const ensembleAll = recs.filter((r) => r.source === "ensemble");
  const ensembleBets = ensembleAll.filter((r) => r.abstained !== true);
  const ensembleAbstainedEval = ensembleAll.filter(
    (r) => r.abstained === true && r.status === "evaluated" && r.correct !== null,
  );
  const avoidedLoss = ensembleAbstainedEval.filter((r) => r.correct === false).length;
  const missedWin   = ensembleAbstainedEval.filter((r) => r.correct === true).length;
  const abstention: AbstentionMetrics = {
    evaluated: ensembleAbstainedEval.length,
    avoidedLoss,
    missedWin,
    avoidedLossPct:
      ensembleAbstainedEval.length > 0
        ? Math.round((avoidedLoss / ensembleAbstainedEval.length) * 100)
        : null,
  };
  const calClaude = claude.filter((r) => r.status === "evaluated" && r.correct !== null);
  const calibration = CONF_BANDS.map((b) => {
    const inBand = calClaude.filter((r) => bandValue(r) >= b.lo && bandValue(r) < b.hi);
    const n = inBand.length;
    const hits = inBand.filter((r) => r.correct === true).length;
    return {
      band: b.band,
      n,
      avgConfidencePct: n > 0 ? Math.round(mean(inBand.map(bandValue))) : null,
      hitRatePct: n > 0 ? Math.round((hits / n) * 100) : null,
    };
  });
  const base: Omit<CoinAnalytics, "ensembleWeights"> = {
    symbol: symbol.toUpperCase(),
    bySource: {
      stat:     metricsFor(stat),
      claude:   metricsFor(claude),
      ensemble: metricsFor(ensembleBets),
    },
    byRegime: {
      stat:     regimeBreakdown(stat),
      claude:   regimeBreakdown(claude),
      ensemble: regimeBreakdown(ensembleBets),
    },
    abstention,
    calibration,
  };
  const byRegimeWeights = {} as Record<PromptRegime, EnsembleWeights>;
  for (const reg of REGIMES) byRegimeWeights[reg] = ensembleWeightsFor(base, reg);
  return {
    ...base,
    ensembleWeights: {
      overall:  overallWeightsFor(base),
      byRegime: byRegimeWeights,
    },
  };
}

export function getAllPredictionAnalytics(): CoinAnalytics[] {
  return CRYPTO_COINS.map((c) => getPredictionAnalytics(c.symbol));
}

// ---------------------------------------------------------------------------
// Best-trading-windows analytics
// ---------------------------------------------------------------------------

const TW_MIN_BUCKET        = 10;
const TW_MIN_BUCKET_SINGLE =  3;
const TW_MIN_TOTAL         = 50;
const TW_MIN_TOTAL_SINGLE  = 10;

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHourLabel(h: number): string {
  if (h === 0)  return "12 AM";
  if (h < 12)   return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

export interface TradingWindowBucket {
  count: number;
  evaluatedCount: number;
  accuracyPct: number | null;
  avgEfficiencyRatio: number | null;
  trendingPct: number | null;
  sparse: boolean;
}

export interface RecommendedWindow {
  hour: number;
  label: string;
  score: number;
  avgEfficiencyRatio: number;
  accuracyPct: number | null;
  rank: "best" | "worst";
}

export interface TradingWindowsData {
  hourly: Array<TradingWindowBucket & { hour: number; label: string }>;
  daily: Array<TradingWindowBucket & { dayIndex: number; label: string }>;
  byDayHour: Array<Array<TradingWindowBucket & { hour: number; label: string }>>;
  recommendedWindows: RecommendedWindow[];
  totalSamples: number;
  lastUpdatedAt: string;
  recommendation: string;
  hasEnoughData: boolean;
}

export async function getTradingWindows(filterSymbol?: string): Promise<TradingWindowsData> {
  const symbols = filterSymbol
    ? TRAINING_COINS.has(filterSymbol) ? [filterSymbol] : []
    : [...TRAINING_COINS];

  const minBucket = symbols.length === 1 ? TW_MIN_BUCKET_SINGLE : TW_MIN_BUCKET;
  const minTotal  = symbols.length === 1 ? TW_MIN_TOTAL_SINGLE  : TW_MIN_TOTAL;

  let sourceRecords: PredictionRecord[];
  try {
    if (symbols.length === 0) {
      sourceRecords = [];
    } else {
      const rows = await db
        .select()
        .from(predictionRecordsTable)
        .where(inArray(predictionRecordsTable.symbol, symbols))
        .orderBy(desc(predictionRecordsTable.targetTime));
      sourceRecords = rows.map(rowToRecord);
    }
  } catch {
    sourceRecords = symbols.flatMap((sym) => historyStore.get(sym) ?? []);
  }

  const windowMap = new Map<string, PredictionRecord>();
  for (const r of sourceRecords) {
    const key = `${r.symbol}|${r.targetTime}`;
    const ex  = windowMap.get(key);
    if (!ex || r.source === "stat") windowMap.set(key, r);
  }

  type Acc = {
    erSum: number; erCount: number; trendingCount: number;
    hits: number; evaluated: number; total: number;
  };
  const mkAcc = (): Acc => ({
    erSum: 0, erCount: 0, trendingCount: 0, hits: 0, evaluated: 0, total: 0,
  });
  const hourAcc:    Acc[]   = Array.from({ length: 24 }, mkAcc);
  const dayAcc:     Acc[]   = Array.from({ length: 7  }, mkAcc);
  const dayHourAcc: Acc[][] = Array.from({ length: 7  }, () =>
    Array.from({ length: 24 }, mkAcc),
  );

  const ET_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour:     "numeric",
    hour12:   false,
    weekday:  "short",
  });

  for (const rec of windowMap.values()) {
    const date  = new Date(rec.snappedAt);
    const parts = ET_FMT.formatToParts(date);
    const rawH  = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
    const hour  = rawH === 24 ? 0 : rawH;
    const dow   = parts.find((p) => p.type === "weekday")?.value ?? "";
    const dayIdx = DOW_LABELS.indexOf(dow);
    if (hour < 0 || hour > 23 || dayIdx === -1) continue;

    const hA  = hourAcc[hour];
    const dA  = dayAcc[dayIdx];
    const dhA = dayHourAcc[dayIdx][hour];

    hA.total++; dA.total++; dhA.total++;

    if (rec.efficiencyRatio !== null) {
      hA.erSum  += rec.efficiencyRatio; hA.erCount++;
      dA.erSum  += rec.efficiencyRatio; dA.erCount++;
      dhA.erSum += rec.efficiencyRatio; dhA.erCount++;
      if (rec.efficiencyRatio >= 0.55) {
        hA.trendingCount++; dA.trendingCount++; dhA.trendingCount++;
      }
    }

    if (rec.status === "evaluated" && rec.correct !== null && rec.abstained !== true) {
      hA.evaluated++; dA.evaluated++; dhA.evaluated++;
      if (rec.correct) { hA.hits++; dA.hits++; dhA.hits++; }
    }
  }

  const toBucket = (acc: Acc): TradingWindowBucket => {
    const avgER = acc.erCount > 0
      ? Math.round((acc.erSum / acc.erCount) * 1000) / 1000
      : null;
    return {
      count:              acc.total,
      evaluatedCount:     acc.evaluated,
      accuracyPct:        acc.evaluated >= minBucket
        ? Math.round((acc.hits / acc.evaluated) * 100) : null,
      avgEfficiencyRatio: avgER,
      trendingPct:        acc.erCount > 0
        ? Math.round((acc.trendingCount / acc.erCount) * 100) : null,
      sparse: acc.total < minBucket,
    };
  };

  const hourly    = hourAcc.map((acc, h) => ({ ...toBucket(acc), hour: h, label: fmtHourLabel(h) }));
  const daily     = dayAcc.map((acc, i)  => ({ ...toBucket(acc), dayIndex: i, label: DOW_LABELS[i] }));
  const byDayHour = dayHourAcc.map((dayHours) =>
    dayHours.map((acc, h) => ({ ...toBucket(acc), hour: h, label: fmtHourLabel(h) })),
  );

  const totalSamples = windowMap.size;

  const scored = hourly
    .filter((h) => !h.sparse && h.avgEfficiencyRatio !== null)
    .map((h) => ({
      hour:  h.hour,
      label: h.label,
      er:    h.avgEfficiencyRatio ?? 0,
      score: ((h.accuracyPct ?? 50) / 100) * 0.4 + (h.avgEfficiencyRatio ?? 0) * 0.6,
    }))
    .sort((a, b) => b.score - a.score);

  let recommendation: string;
  let recommendedWindows: RecommendedWindow[] = [];
  if (totalSamples < minTotal) {
    recommendation =
      `Collecting data — needs at least ${minTotal} windows to identify patterns. ` +
      `${totalSamples} recorded so far.`;
  } else if (scored.length === 0) {
    recommendation = "No hour bucket has enough samples yet.";
  } else {
    const top   = scored.slice(0, Math.min(3, scored.length));
    const worst = scored.slice(-Math.min(3, scored.length)).reverse();
    const avgTopER = Math.round((top.reduce((s, h) => s + h.er, 0) / top.length) * 100) / 100;
    const topStr   = top.map((h) => h.label).join(", ");
    const worstStr = worst.map((h) => h.label).join(", ");
    recommendation =
      `Best windows: ${topStr} ET (avg efficiency ${avgTopER.toFixed(2)}). ` +
      `Tend to avoid: ${worstStr} ET — markets are choppier during those hours.`;
    recommendedWindows = [
      ...top.map((h) => ({
        hour:  h.hour,
        label: h.label,
        score: Math.round(h.score * 1000) / 1000,
        avgEfficiencyRatio: Math.round(h.er * 1000) / 1000,
        accuracyPct: hourly[h.hour].accuracyPct,
        rank: "best" as const,
      })),
      ...worst.map((h) => ({
        hour:  h.hour,
        label: h.label,
        score: Math.round(h.score * 1000) / 1000,
        avgEfficiencyRatio: Math.round(h.er * 1000) / 1000,
        accuracyPct: hourly[h.hour].accuracyPct,
        rank: "worst" as const,
      })),
    ];
  }

  return {
    hourly,
    daily,
    byDayHour,
    recommendedWindows,
    totalSamples,
    lastUpdatedAt: new Date().toISOString(),
    recommendation,
    hasEnoughData: totalSamples >= (symbols.length === 1 ? 10 : TW_MIN_TOTAL),
  };
}

// ---------------------------------------------------------------------------
// Confidence calibration
// ---------------------------------------------------------------------------

const CALIB_MIN_SAMPLES = 5;
const CALIB_SHRINK_K    = 8;

export function calibrateConfidence(symbol: string, rawConf: number): number {
  const claude = (historyStore.get(symbol.toUpperCase()) ?? []).filter(
    (r) => r.source === "claude" && r.status === "evaluated" && r.correct !== null,
  );
  const b = confBand(rawConf);
  const inBand = claude.filter((r) => bandValue(r) >= b.lo && bandValue(r) < b.hi);
  const n = inBand.length;
  if (n < CALIB_MIN_SAMPLES) return clamp(Math.round(rawConf), 20, 92);
  const hitRate = (inBand.filter((r) => r.correct === true).length / n) * 100;
  const w = n / (n + CALIB_SHRINK_K);
  const calibrated = rawConf * (1 - w) + hitRate * w;
  return clamp(Math.round(calibrated), 20, 92);
}

// ---------------------------------------------------------------------------
// Adaptive stat + Claude ensemble
// ---------------------------------------------------------------------------

const ENSEMBLE_MIN_SAMPLES   = 8;
const ENSEMBLE_WEIGHT_FLOOR  = 0.2;
export const ENSEMBLE_ABSTAIN_MIN_CONF = 55;

export interface EnsembleWeights {
  stat: number;
  claude: number;
}

interface ModelCall {
  predictedPrice: number;
  direction: "up" | "down" | "flat";
  confidence: number;
}

export interface EnsembleCall {
  predictedPrice: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  abstained: boolean;
  reason: string;
  weights: EnsembleWeights;
}

type CoinAnalyticsBase = Omit<CoinAnalytics, "ensembleWeights">;

function trustedAccuracy(
  a: CoinAnalyticsBase,
  src: "stat" | "claude",
  regime: PromptRegime,
): number | null {
  const reg = a.byRegime[src][regime];
  if (reg.n >= ENSEMBLE_MIN_SAMPLES && reg.accuracyPct != null) return reg.accuracyPct;
  const all = a.bySource[src];
  if (all.n >= ENSEMBLE_MIN_SAMPLES && all.accuracyPct != null) return all.accuracyPct;
  return null;
}

function weightsFromAccuracy(
  statAcc: number | null,
  claudeAcc: number | null,
): EnsembleWeights {
  if (statAcc == null || claudeAcc == null) return { stat: 0.5, claude: 0.5 };
  const edgeStat   = Math.max(0, statAcc - 50);
  const edgeClaude = Math.max(0, claudeAcc - 50);
  if (edgeStat + edgeClaude === 0) return { stat: 0.5, claude: 0.5 };
  const wStat = clamp(
    edgeStat / (edgeStat + edgeClaude),
    ENSEMBLE_WEIGHT_FLOOR,
    1 - ENSEMBLE_WEIGHT_FLOOR,
  );
  return { stat: round3(wStat), claude: round3(1 - wStat) };
}

function ensembleWeightsFor(a: CoinAnalyticsBase, regime: PromptRegime): EnsembleWeights {
  return weightsFromAccuracy(
    trustedAccuracy(a, "stat", regime),
    trustedAccuracy(a, "claude", regime),
  );
}

function overallWeightsFor(a: CoinAnalyticsBase): EnsembleWeights {
  const statAcc =
    a.bySource.stat.n >= ENSEMBLE_MIN_SAMPLES ? a.bySource.stat.accuracyPct : null;
  const claudeAcc =
    a.bySource.claude.n >= ENSEMBLE_MIN_SAMPLES ? a.bySource.claude.accuracyPct : null;
  return weightsFromAccuracy(statAcc, claudeAcc);
}

export function ensembleWeights(symbol: string, regime: PromptRegime): EnsembleWeights {
  return ensembleWeightsFor(getPredictionAnalytics(symbol), regime);
}

const CLAUDE_DOWN_SCALE_MIN_DIR_SAMPLES = 5;
function computeClaudeDownScale(symbol: string): number {
  const records = historyStore.get(symbol.toUpperCase()) ?? [];
  const claudeEval = records.filter(
    (r) => r.source === "claude" && r.status === "evaluated"
      && r.correct !== null && r.kalshiTarget != null,
  );
  const downRecs = claudeEval.filter((r) => r.predictedDirection === "down");
  const upRecs   = claudeEval.filter((r) => r.predictedDirection === "up");
  if (
    downRecs.length < CLAUDE_DOWN_SCALE_MIN_DIR_SAMPLES ||
    upRecs.length   < CLAUDE_DOWN_SCALE_MIN_DIR_SAMPLES
  ) {
    return 0.85;
  }
  const downAcc = downRecs.filter((r) => r.correct === true).length / downRecs.length;
  const upAcc   = upRecs.filter((r) => r.correct === true).length / upRecs.length;
  if (upAcc <= 0) return 1.0;
  return clamp(downAcc / upAcc, 0.5, 1.0);
}

export function computeEnsemble(
  symbol: string,
  regime: PromptRegime,
  stat: ModelCall,
  claude: ModelCall,
  referencePrice: number,
): EnsembleCall {
  const weights = ensembleWeights(symbol, regime);
  const claudeDownScale = claude.direction === "down" ? computeClaudeDownScale(symbol) : 1.0;
  const effectiveClaudeW = weights.claude * claudeDownScale;
  const effectiveStatW = weights.stat + (weights.claude - effectiveClaudeW);
  const predictedPrice = effectiveStatW * stat.predictedPrice + effectiveClaudeW * claude.predictedPrice;
  const confidence = Math.round(effectiveStatW * stat.confidence + effectiveClaudeW * claude.confidence);
  const changePct = referencePrice > 0 ? ((predictedPrice - referencePrice) / referencePrice) * 100 : 0;
  const direction: "up" | "down" | "flat" =
    changePct > 0.05 ? "up" : changePct < -0.05 ? "down" : "flat";

  const conflict =
    (stat.direction === "up" && claude.direction === "down") ||
    (stat.direction === "down" && claude.direction === "up");
  const lowConf = confidence < ENSEMBLE_ABSTAIN_MIN_CONF;
  const abstained = conflict || lowConf;
  const reason = conflict
    ? "Models disagree on direction"
    : lowConf
      ? `Combined confidence ${confidence}% below ${ENSEMBLE_ABSTAIN_MIN_CONF}% threshold`
      : "Models agree — regime-weighted blend";

  return { predictedPrice, direction, confidence, abstained, reason, weights };
}
