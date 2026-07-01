// Stock ML: online logistic regression for binary UP/DOWN prediction.
//
// This is a SEPARATE instance from the crypto ML system. The pure math mirrors
// crypto's ml-model.ts but is copied here (not imported) so the two models can
// have different feature-vector lengths and never contaminate each other's
// weights. Stock uses 21 features vs crypto's 19.
//
// State (weights + snapshots) is persisted to stock_ml_* tables and loaded at
// startup so the model survives restarts.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import type { Candle, Direction, MlSignal, NewsItem, EarningsInfo } from "./types";
import {
  rsi,
  bollinger,
  atrPct,
  efficiencyRatio,
  netDriftPct,
  volumeDirectionBias,
  volumeRatio,
  candleReversal,
  candlePatternScore,
  sma,
  ema,
} from "./indicators";

export const STOCK_N_FEATURES = 21;
export const MIN_TRAINING_SAMPLES = 30;

const LEARNING_RATE = 0.05;
const L2_LAMBDA = 0.01;
const EPOCHS = 25;
const MAX_EXAMPLES = 6_000;

type Weights = number[];

interface ModelState {
  weights: Weights;
  trainingSamples: number;
  labeledSamples: number;
  examples: { features: number[]; label: number }[];
}

// Per-ticker in-memory model state, hydrated from DB at startup.
const models = new Map<string, ModelState>();

function initWeights(): Weights {
  return new Array<number>(STOCK_N_FEATURES + 1).fill(0);
}

function sigmoid(z: number): number {
  if (z > 500) return 1 - 1e-9;
  if (z < -500) return 1e-9;
  return 1 / (1 + Math.exp(-z));
}

function forward(w: Weights, f: number[]): number {
  let z = w[0];
  for (let i = 0; i < STOCK_N_FEATURES; i++) z += w[i + 1] * f[i];
  return sigmoid(z);
}

function runEpoch(w: Weights, examples: { features: number[]; label: number }[]): Weights {
  const out = [...w];
  const idx = examples.map((_, i) => i).sort(() => Math.random() - 0.5);
  for (const i of idx) {
    const { features: f, label: y } = examples[i];
    const p = forward(out, f);
    const err = p - y;
    out[0] -= LEARNING_RATE * err;
    for (let j = 0; j < STOCK_N_FEATURES; j++) {
      out[j + 1] = out[j + 1] * (1 - LEARNING_RATE * L2_LAMBDA) - LEARNING_RATE * err * f[j];
    }
  }
  return out;
}

function trainModel(initW: Weights, examples: { features: number[]; label: number }[]): Weights {
  if (examples.length === 0) return initW;
  const subset = examples.slice(-MAX_EXAMPLES);
  let w = [...initW];
  for (let e = 0; e < EPOCHS; e++) w = runEpoch(w, subset);
  return w;
}

/**
 * Build the 21-feature vector for a ticker. All features are normalized to
 * roughly [-1, 1] or [0, 1] ranges to keep the logistic model well-conditioned.
 */
export function buildFeatures(
  candles: Candle[],
  news: NewsItem[],
  earnings: EarningsInfo | undefined,
  sectorMomentum: number,
): number[] {
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1] ?? 0;

  const rsiVal = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const atr = atrPct(candles, 14);
  const er = efficiencyRatio(closes, 14);
  const drift = netDriftPct(closes, 14);
  const volBias = volumeDirectionBias(candles, 8);
  const volRatio = volumeRatio(candles, 20);
  const pattern = candlePatternScore(candleReversal(candles));

  const sma5 = sma(closes, 5);
  const sma20 = sma(closes, 20);
  const ema12 = ema(closes.slice(-30), 12);
  const ema26 = ema(closes.slice(-40), 26);
  const macd = last > 0 ? ((ema12 - ema26) / last) * 100 : 0;
  const smaCross = sma20 > 0 ? ((sma5 - sma20) / sma20) * 100 : 0;

  // News sentiment aggregate (recency-weighted).
  let newsScore = 0;
  if (news.length) {
    let wsum = 0;
    for (const n of news.slice(0, 5)) {
      const w = 1;
      newsScore += (n.sentimentScore ?? 0) * w;
      wsum += w;
    }
    if (wsum) newsScore /= wsum;
  }

  const earningsSoon = earnings?.soon ? 1 : 0;
  const earningsProximity = earnings
    ? Math.max(0, Math.min(1, 1 - Math.abs(earnings.hoursUntil) / 168))
    : 0;

  // Short-term returns over 1, 3, 5 bars.
  const ret1 = closes.length > 1 ? (last - closes[closes.length - 2]) / closes[closes.length - 2] : 0;
  const ret3 = closes.length > 3 ? (last - closes[closes.length - 4]) / closes[closes.length - 4] : 0;
  const ret5 = closes.length > 5 ? (last - closes[closes.length - 6]) / closes[closes.length - 6] : 0;

  const rangePct = candles.length ? ((candles[candles.length - 1].h - candles[candles.length - 1].l) / last) * 100 : 0;

  const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

  return [
    clamp((rsiVal - 50) / 50),        // 0
    bb.position,                       // 1  (0..1)
    clamp(atr / 5),                    // 2
    er,                               // 3  (0..1)
    clamp(drift / 5),                  // 4
    volBias,                          // 5  (-1..1)
    clamp((volRatio - 1) / 2),         // 6
    pattern,                          // 7  (-1..1)
    clamp(macd / 2),                   // 8
    clamp(smaCross / 3),               // 9
    clamp(newsScore),                  // 10 (-1..1)
    earningsSoon,                     // 11 (0/1)
    earningsProximity,                // 12 (0..1)
    clamp(sectorMomentum / 3),         // 13
    clamp(ret1 * 100),                 // 14
    clamp(ret3 * 100 / 3),             // 15
    clamp(ret5 * 100 / 5),             // 16
    clamp(rangePct / 5),               // 17
    last > sma20 ? 1 : 0,             // 18
    last > sma5 ? 1 : 0,              // 19
    news.length ? clamp(news.length / 5, 0, 1) : 0, // 20
  ];
}

/** Live prediction for a feature vector. Returns not-ready while under gate. */
export function predictStock(ticker: string, features: number[]): MlSignal {
  const m = models.get(ticker.toUpperCase());
  if (!m || m.labeledSamples < MIN_TRAINING_SAMPLES) {
    return { direction: "up", confidence: 50, ready: false };
  }
  const prob = forward(m.weights, features);
  const direction: Direction = prob >= 0.5 ? "up" : "down";
  const confidence = Math.round(Math.max(prob, 1 - prob) * 100);
  return { direction, confidence, ready: true };
}

/**
 * Record a training snapshot for a settled trade. `label` is 1 if price went up
 * from entry, 0 if down. Retrains the ticker's model and persists.
 */
export async function recordOutcome(
  ticker: string,
  refId: string,
  features: number[],
  label: number,
): Promise<void> {
  const T = ticker.toUpperCase();
  try {
    await db.execute(sql`
      INSERT INTO stock_ml_snapshots (ticker, ref_id, snapshot_at, features, outcome)
      VALUES (${T}, ${refId}, NOW(), ${JSON.stringify(features)}::jsonb, ${label})
    `);
    let m = models.get(T);
    if (!m) {
      m = { weights: initWeights(), trainingSamples: 0, labeledSamples: 0, examples: [] };
      models.set(T, m);
    }
    m.examples.push({ features, label });
    m.labeledSamples = m.examples.length;
    if (m.labeledSamples >= MIN_TRAINING_SAMPLES) {
      m.weights = trainModel(initWeights(), m.examples);
      m.trainingSamples += m.examples.length;
      await persistModel(T, m);
    }
  } catch (err) {
    logger.warn({ err, ticker }, "[stock-ml] recordOutcome failed (non-fatal)");
  }
}

async function persistModel(ticker: string, m: ModelState): Promise<void> {
  await db.execute(sql`
    INSERT INTO stock_ml_model_state
      (ticker, weights, training_samples, labeled_samples, last_trained_at, updated_at)
    VALUES
      (${ticker}, ${JSON.stringify(m.weights)}::jsonb, ${m.trainingSamples}, ${m.labeledSamples}, NOW(), NOW())
    ON CONFLICT (ticker) DO UPDATE SET
      weights = EXCLUDED.weights,
      training_samples = EXCLUDED.training_samples,
      labeled_samples = EXCLUDED.labeled_samples,
      last_trained_at = NOW(),
      updated_at = NOW()
  `);
}

/** Hydrate model weights + training examples from DB at startup. */
export async function initStockMLFromDB(): Promise<void> {
  try {
    const stateRows = (await db.execute(sql`
      SELECT ticker, weights, training_samples, labeled_samples
      FROM stock_ml_model_state
    `)) as unknown as { rows: any[] };
    for (const r of stateRows.rows ?? []) {
      const weights: number[] = Array.isArray(r.weights) ? r.weights : JSON.parse(r.weights);
      // Reset to zero if the persisted feature count no longer matches.
      const w = weights.length === STOCK_N_FEATURES + 1 ? weights : initWeights();
      models.set(r.ticker, {
        weights: w,
        trainingSamples: Number(r.training_samples) || 0,
        labeledSamples: 0,
        examples: [],
      });
    }
    // Load recent labeled snapshots to rebuild the training set in memory.
    const snapRows = (await db.execute(sql`
      SELECT ticker, features, outcome
      FROM stock_ml_snapshots
      WHERE outcome IS NOT NULL
      ORDER BY snapshot_at ASC
    `)) as unknown as { rows: any[] };
    for (const r of snapRows.rows ?? []) {
      const T = r.ticker;
      let m = models.get(T);
      if (!m) {
        m = { weights: initWeights(), trainingSamples: 0, labeledSamples: 0, examples: [] };
        models.set(T, m);
      }
      const features: number[] = Array.isArray(r.features) ? r.features : JSON.parse(r.features);
      if (features.length === STOCK_N_FEATURES) {
        m.examples.push({ features, label: Number(r.outcome) });
      }
    }
    for (const [T, m] of models) {
      m.labeledSamples = m.examples.length;
      if (m.labeledSamples >= MIN_TRAINING_SAMPLES) {
        m.weights = trainModel(initWeights(), m.examples);
      }
    }
    logger.info({ tickers: models.size }, "[stock-ml] hydrated from DB");
  } catch (err) {
    logger.warn({ err }, "[stock-ml] init from DB failed (non-fatal)");
  }
}

export function mlStatus(ticker: string): { ready: boolean; labeledSamples: number } {
  const m = models.get(ticker.toUpperCase());
  return { ready: !!m && m.labeledSamples >= MIN_TRAINING_SAMPLES, labeledSamples: m?.labeledSamples ?? 0 };
}
