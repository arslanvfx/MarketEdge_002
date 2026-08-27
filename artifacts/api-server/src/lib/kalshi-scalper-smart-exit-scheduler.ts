import {
  MAX_SCALPER_EXIT_SAMPLE_GAP_MS,
  MAX_SCALPER_EXIT_SAMPLE_SPAN_MS,
  isScalperSourceSequenceRegression,
  type ScalperExitSample,
} from "./kalshi-scalper-smart-exit-policy.ts";

export interface ScalperHotCadenceSnapshot {
  latestGapMs: number | null;
  worstRecentGapMs: number | null;
  tickCount: number;
}

export interface AbortableCoalescedRequest<T> {
  promise: Promise<T>;
  abort: () => void;
}

export type ScalperExitWorkPriority = "critical" | "background";

interface QueuedScalperExitWork<T> {
  priority: ScalperExitWorkPriority;
  sequence: number;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Bounds Smart Exit's use of shared process resources. Critical lifecycle work
 * may move ahead of queued observational writes, while FIFO order is preserved
 * within each priority. The normal entry path deliberately does not use this
 * gate, so a small gate limit leaves shared DB capacity available to entries.
 */
export class ScalperExitPriorityGate {
  private readonly queue: QueuedScalperExitWork<unknown>[] = [];
  private readonly maxConcurrency: number;
  private active = 0;
  private sequence = 0;

  constructor(maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = maxConcurrency;
  }

  run<T>(
    work: () => Promise<T>,
    priority: ScalperExitWorkPriority = "critical",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        sequence: this.sequence++,
        work,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  snapshot(): {
    active: number;
    queuedCritical: number;
    queuedBackground: number;
    maxConcurrency: number;
  } {
    return {
      active: this.active,
      queuedCritical: this.queue.filter((item) => item.priority === "critical").length,
      queuedBackground: this.queue.filter((item) => item.priority === "background").length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      this.queue.sort((a, b) => (
        Number(b.priority === "critical") - Number(a.priority === "critical")
        || a.sequence - b.sequence
      ));
      const next = this.queue.shift()!;
      this.active += 1;
      void next.work()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
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
  maxGapMs = MAX_SCALPER_EXIT_SAMPLE_GAP_MS,
  maxSpanMs = MAX_SCALPER_EXIT_SAMPLE_SPAN_MS,
): ScalperExitSample[] {
  if (next.sourceAtMs == null || !next.sourceSequence) return [...history];
  const prior = history[history.length - 1];
  const base = prior && next.atMs - prior.atMs > maxGapMs
    ? []
    : history.filter((sample) => next.atMs - sample.atMs <= maxSpanMs);
  const comparablePrior = base[base.length - 1];
  const lastOrderablePrior = [...base].reverse().find((sample) =>
    sample.sourceSequence != null && /^\d+$/.test(sample.sourceSequence));
  if (comparablePrior && (
    next.atMs <= comparablePrior.atMs
    || (comparablePrior.sourceAtMs != null && next.sourceAtMs < comparablePrior.sourceAtMs)
    || isScalperSourceSequenceRegression(
      lastOrderablePrior?.sourceSequence,
      next.sourceSequence,
    )
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