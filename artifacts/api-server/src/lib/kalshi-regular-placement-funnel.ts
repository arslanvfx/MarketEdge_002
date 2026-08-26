// Bounded, process-local observability for the regular entry placement path.
// This intentionally has no database or bot-tick dependency: callers decide
// where lifecycle boundaries occur and record them here.

export type RegularPlacementMode = "live" | "paper";
export type RegularPlacementSide = "yes" | "no";
export type RegularPlacementStage =
  | "identified"
  | "final_eligibility"
  | "reservation"
  | "submit"
  | "response"
  | "fill";

export type RegularPlacementTerminalOutcome =
  | "smart_hours"
  | "proximity"
  | "direction"
  | "freefall"
  | "intent_denied"
  | "intent_error"
  | "zero_fill"
  | "filled"
  | "unknown"
  | "definite_error"
  | "paper_synthetic";

export interface RegularPlacementCandidateInput {
  mode: RegularPlacementMode;
  symbol: string;
  windowKey: string;
  side: RegularPlacementSide;
}

export interface RegularPlacementLatency {
  /** End-to-end time from identification through the terminal result. */
  totalMs: number | null;
  /** Time spent awaiting the exchange after submit. */
  exchangeMs: number | null;
  /** totalMs less exchangeMs; never negative. */
  internalMs: number | null;
}

export interface RegularPlacementCandidate extends RegularPlacementCandidateInput {
  id: string;
  candidateKey: string;
  sequence: number;
  timestamps: Partial<Record<RegularPlacementStage, number>>;
  finalEligible: boolean | null;
  reservationClaimed: boolean | null;
  submitted: boolean;
  responseReceived: boolean;
  filledCount: number | null;
  outcome: RegularPlacementTerminalOutcome | null;
  reason: string | null;
  /** Paper work that models a fill but never submitted an exchange order. */
  paperSynthetic: boolean;
  /** Advisory paper-only result of the same live eligibility predicates. */
  paperLiveEligible: boolean | null;
  paperLiveEligibilityReason: string | null;
  latency: RegularPlacementLatency;
}

export interface RegularPlacementSummary {
  capacity: number;
  retained: number;
  totalRecorded: number;
  active: number;
  terminal: number;
  outcomes: Partial<Record<RegularPlacementTerminalOutcome, number>>;
  latency: {
    samples: number;
    averageInternalMs: number | null;
    averageExchangeMs: number | null;
    averageTotalMs: number | null;
  };
}

export interface RegularPlacementFunnelOptions {
  /** Maximum retained candidates. Defaults to 500. */
  capacity?: number;
  now?: () => number;
}

const terminalSet = new Set<RegularPlacementTerminalOutcome>([
  "smart_hours", "proximity", "direction", "freefall", "intent_denied",
  "intent_error", "zero_fill", "filled", "unknown", "definite_error",
  "paper_synthetic",
]);

export function regularPlacementCandidateKey(input: RegularPlacementCandidateInput): string {
  return [
    input.mode,
    input.symbol.trim().toUpperCase(),
    input.windowKey.trim(),
    input.side,
  ].join("|");
}

/**
 * Deterministic, readable ID. The identity portion is stable for a placement
 * key; the caller-owned sequence makes repeated candidates collision-safe.
 */
export function createRegularPlacementCandidateId(
  input: RegularPlacementCandidateInput,
  sequence: number,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("sequence must be a non-negative safe integer");
  }
  const key = regularPlacementCandidateKey(input);
  // encodeURIComponent avoids ambiguous delimiters in external window keys.
  return `regular-placement:${encodeURIComponent(key)}:${sequence.toString(36)}`;
}

export function calculateRegularPlacementLatency(
  timestamps: Partial<Record<RegularPlacementStage, number>>,
): RegularPlacementLatency {
  const identified = timestamps.identified;
  const end = timestamps.fill ?? timestamps.response;
  if (!isFiniteTimestamp(identified) || !isFiniteTimestamp(end)) {
    return { totalMs: null, exchangeMs: null, internalMs: null };
  }
  const totalMs = Math.max(0, end - identified);
  const submit = timestamps.submit;
  const response = timestamps.response;
  const exchangeMs = isFiniteTimestamp(submit) && isFiniteTimestamp(response)
    ? Math.max(0, response - submit)
    : 0;
  return { totalMs, exchangeMs, internalMs: Math.max(0, totalMs - exchangeMs) };
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clone(candidate: RegularPlacementCandidate): RegularPlacementCandidate {
  return {
    ...candidate,
    timestamps: { ...candidate.timestamps },
    latency: { ...candidate.latency },
  };
}

export class KalshiRegularPlacementFunnel {
  private readonly capacity: number;
  private readonly now: () => number;
  private sequence = 0;
  private totalRecorded = 0;
  /** Active candidates are never evicted while the trading path still owns them. */
  private readonly active = new Map<string, RegularPlacementCandidate>();
  /** Capacity applies to completed history; active work is transient and small. */
  private readonly entries: RegularPlacementCandidate[] = [];
  private readonly byId = new Map<string, RegularPlacementCandidate>();

  constructor(options: RegularPlacementFunnelOptions = {}) {
    const requestedCapacity = options.capacity ?? 500;
    if (!Number.isSafeInteger(requestedCapacity) || requestedCapacity < 1) {
      throw new Error("capacity must be a positive safe integer");
    }
    this.capacity = requestedCapacity;
    this.now = options.now ?? Date.now;
  }

  identify(input: RegularPlacementCandidateInput, at = this.now()): RegularPlacementCandidate {
    assertTimestamp(at);
    const normalized = { ...input, symbol: input.symbol.trim().toUpperCase(), windowKey: input.windowKey.trim() };
    const sequence = this.sequence++;
    const candidate: RegularPlacementCandidate = {
      ...normalized,
      id: createRegularPlacementCandidateId(normalized, sequence),
      candidateKey: regularPlacementCandidateKey(normalized),
      sequence,
      timestamps: { identified: at },
      finalEligible: null, reservationClaimed: null, submitted: false,
      responseReceived: false, filledCount: null, outcome: null, reason: null,
      paperSynthetic: false, paperLiveEligible: null,
      paperLiveEligibilityReason: null,
      latency: { totalMs: null, exchangeMs: null, internalMs: null },
    };
    while (this.entries.length + this.active.size >= this.capacity) {
      const completed = this.entries.shift();
      if (completed) {
        this.byId.delete(completed.id);
        continue;
      }
      const oldestActive = [...this.active.values()]
        .sort((a, b) => a.sequence - b.sequence)[0];
      if (!oldestActive) break;
      this.active.delete(oldestActive.id);
      this.byId.delete(oldestActive.id);
    }
    this.active.set(candidate.id, candidate);
    this.byId.set(candidate.id, candidate);
    this.totalRecorded += 1;
    return clone(candidate);
  }

  finalEligibility(id: string, eligible: boolean, at = this.now(), reason: string | null = null): RegularPlacementCandidate | null {
    const entry = this.stage(id, "final_eligibility", at);
    if (!entry) return null;
    entry.finalEligible = eligible;
    entry.reason = reason;
    return clone(entry);
  }

  reservation(id: string, claimed: boolean, at = this.now(), reason: string | null = null): RegularPlacementCandidate | null {
    const entry = this.stage(id, "reservation", at);
    if (!entry) return null;
    entry.reservationClaimed = claimed;
    entry.reason = reason;
    return clone(entry);
  }

  submit(id: string, at = this.now()): RegularPlacementCandidate | null {
    const entry = this.stage(id, "submit", at);
    if (!entry) return null;
    entry.submitted = true;
    return clone(entry);
  }

  response(id: string, at = this.now()): RegularPlacementCandidate | null {
    const entry = this.stage(id, "response", at);
    if (!entry) return null;
    entry.responseReceived = true;
    return clone(entry);
  }

  fill(id: string, filledCount: number, at = this.now()): RegularPlacementCandidate | null {
    if (!Number.isFinite(filledCount) || filledCount < 0) throw new Error("filledCount must be non-negative");
    const entry = this.stage(id, "fill", at);
    if (!entry) return null;
    entry.filledCount = filledCount;
    return clone(entry);
  }

  paperSynthetic(id: string, at = this.now(), reason: string | null = null): RegularPlacementCandidate | null {
    const entry = this.require(id);
    if (!entry) return null;
    if (entry.mode !== "paper") throw new Error("paper synthetic outcomes require paper mode");
    entry.paperSynthetic = true;
    return this.terminal(id, "paper_synthetic", at, reason);
  }

  paperLiveEligibility(id: string, eligible: boolean, reason: string | null = null): RegularPlacementCandidate | null {
    const entry = this.require(id);
    if (!entry) return null;
    if (entry.mode !== "paper") throw new Error("paper live-eligibility previews require paper mode");
    if (entry.outcome != null) return clone(entry);
    entry.paperLiveEligible = eligible;
    entry.paperLiveEligibilityReason = reason;
    return clone(entry);
  }

  terminal(id: string, outcome: RegularPlacementTerminalOutcome, at = this.now(), reason: string | null = null): RegularPlacementCandidate | null {
    if (!terminalSet.has(outcome)) throw new Error(`unsupported terminal outcome: ${outcome}`);
    const entry = this.require(id);
    if (!entry) return null;
    // Telemetry must never rewrite a completed economic outcome or throw in the
    // trading path when two cleanup branches observe the same terminal state.
    if (entry.outcome != null) return clone(entry);
    assertTimestamp(at);
    entry.outcome = outcome;
    entry.reason = reason;
    entry.latency = calculateRegularPlacementLatency(entry.timestamps);
    // A pre-submit terminal outcome has no response/fill boundary, so total
    // latency is still observable through its final recorded stage.
    if (entry.latency.totalMs === null) {
      const identified = entry.timestamps.identified!;
      entry.latency = { totalMs: Math.max(0, at - identified), exchangeMs: 0, internalMs: Math.max(0, at - identified) };
    }
    this.active.delete(id);
    this.entries.push(entry);
    while (this.entries.length + this.active.size > this.capacity) {
      const evicted = this.entries.shift()!;
      this.byId.delete(evicted.id);
    }
    return clone(entry);
  }

  recent(limit = 50): RegularPlacementCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative safe integer");
    return [...this.entries, ...this.active.values()]
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, limit)
      .map(clone);
  }

  summary(): RegularPlacementSummary {
    const outcomes: RegularPlacementSummary["outcomes"] = {};
    let active = 0, terminal = 0, internal = 0, exchange = 0, total = 0, samples = 0;
    for (const entry of [...this.entries, ...this.active.values()]) {
      if (entry.outcome == null) active += 1;
      else { terminal += 1; outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1; }
      if (entry.latency.totalMs != null && entry.latency.internalMs != null && entry.latency.exchangeMs != null) {
        samples += 1; total += entry.latency.totalMs; internal += entry.latency.internalMs; exchange += entry.latency.exchangeMs;
      }
    }
    return {
      capacity: this.capacity, retained: this.entries.length + this.active.size, totalRecorded: this.totalRecorded, active, terminal, outcomes,
      latency: {
        samples,
        averageInternalMs: samples ? internal / samples : null,
        averageExchangeMs: samples ? exchange / samples : null,
        averageTotalMs: samples ? total / samples : null,
      },
    };
  }

  private stage(id: string, stage: RegularPlacementStage, at: number): RegularPlacementCandidate | null {
    const entry = this.require(id);
    if (!entry) return null;
    if (entry.outcome != null) return entry;
    assertTimestamp(at);
    entry.timestamps[stage] = at;
    return entry;
  }

  private require(id: string): RegularPlacementCandidate | null {
    return this.byId.get(id) ?? null;
  }
}

function assertTimestamp(at: number): void {
  if (!isFiniteTimestamp(at)) throw new Error("timestamp must be finite");
}

export function createKalshiRegularPlacementFunnel(
  options?: RegularPlacementFunnelOptions,
): KalshiRegularPlacementFunnel {
  return new KalshiRegularPlacementFunnel(options);
}

export const regularPlacementFunnel = createKalshiRegularPlacementFunnel();

export function getRegularPlacementFunnelSnapshot(limit = 50): {
  summary: RegularPlacementSummary;
  recent: RegularPlacementCandidate[];
} {
  return {
    summary: regularPlacementFunnel.summary(),
    recent: regularPlacementFunnel.recent(limit),
  };
}