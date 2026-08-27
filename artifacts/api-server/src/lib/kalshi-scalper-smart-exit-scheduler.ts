import type { ScalperExitSample } from "./kalshi-scalper-smart-exit-policy.ts";

export interface ScalperHotCadenceSnapshot {
  latestGapMs: number | null;
  worstRecentGapMs: number | null;
  tickCount: number;
}

export interface AbortableCoalescedRequest<T> {
  promise: Promise<T>;
  abort: () => void;
}

export class AbortableRequestRegistry<T> {
  private readonly requests = new Map<string, AbortableCoalescedRequest<T>>();

  getOrCreate(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
  ): AbortableCoalescedRequest<T> {
    const existing = this.requests.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    let request!: AbortableCoalescedRequest<T>;
    const promise = factory(controller.signal).finally(() => {
      if (this.requests.get(key) === request) this.requests.delete(key);
    });
    request = {
      promise,
      abort: () => {
        controller.abort();
        if (this.requests.get(key) === request) this.requests.delete(key);
      },
    };
    this.requests.set(key, request);
    return request;
  }

  size(): number {
    return this.requests.size;
  }
}

export class ScalperHotCadenceTracker {
  private lastTickAtMs: number | null = null;
  private readonly gaps: number[] = [];
  private ticks = 0;
  private readonly historySize: number;

  constructor(historySize = 40) {
    this.historySize = historySize;
  }

  recordTick(nowMs: number): ScalperHotCadenceSnapshot {
    if (!Number.isFinite(nowMs)) return this.snapshot();
    if (this.lastTickAtMs != null && nowMs >= this.lastTickAtMs) {
      this.gaps.push(nowMs - this.lastTickAtMs);
      if (this.gaps.length > this.historySize) this.gaps.shift();
    }
    this.lastTickAtMs = nowMs;
    this.ticks += 1;
    return this.snapshot();
  }

  snapshot(): ScalperHotCadenceSnapshot {
    return {
      latestGapMs: this.gaps[this.gaps.length - 1] ?? null,
      worstRecentGapMs: this.gaps.length > 0 ? Math.max(...this.gaps) : null,
      tickCount: this.ticks,
    };
  }
}

export function selectScalperHotCandidates<T extends { id: string; lastSampleAtMs: number }>(
  candidates: readonly T[],
  inFlightIds: ReadonlySet<string>,
  maxConcurrency: number,
): { selected: T[]; coalescedCount: number } {
  const slots = Math.max(0, Math.floor(maxConcurrency) - inFlightIds.size);
  if (slots === 0) return { selected: [], coalescedCount: candidates.length };
  const eligible = candidates
    .filter((candidate) => !inFlightIds.has(candidate.id))
    .sort((a, b) => a.lastSampleAtMs - b.lastSampleAtMs || a.id.localeCompare(b.id));
  const selected = eligible.slice(0, slots);
  return {
    selected,
    coalescedCount: Math.max(0, candidates.length - selected.length),
  };
}

export function advanceScalperExitSamples(
  history: readonly ScalperExitSample[],
  next: ScalperExitSample,
  maxHistory = 32,
  maxGapMs = 900,
): ScalperExitSample[] {
  if (next.sourceAtMs == null || !next.sourceSequence) return [...history];
  const prior = history[history.length - 1];
  const base = prior && next.atMs - prior.atMs > maxGapMs ? [] : [...history];
  const comparablePrior = base[base.length - 1];
  if (comparablePrior && (
    next.atMs <= comparablePrior.atMs
    || (comparablePrior.sourceAtMs != null && next.sourceAtMs < comparablePrior.sourceAtMs)
    || (next.sourceAtMs === comparablePrior.sourceAtMs
      && next.sourceSequence === comparablePrior.sourceSequence)
  )) {
    return base;
  }
  if (base.some((sample) =>
    sample.sourceAtMs === next.sourceAtMs
    && sample.sourceSequence === next.sourceSequence)) {
    return base;
  }
  base.push(next);
  return base.slice(-Math.max(1, Math.floor(maxHistory)));
}