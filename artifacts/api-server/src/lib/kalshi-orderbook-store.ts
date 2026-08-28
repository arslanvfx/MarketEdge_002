import { regularCountHundredths } from "./kalshi-regular-fixed-point.ts";

export type KalshiSide = "yes" | "no";
export type BookLevel = readonly [price: number, count: number];

export interface ExecutableBook {
  readonly ticker: string;
  readonly side: KalshiSide;
  readonly sideCost: number;
  readonly visibleContracts: number;
  readonly seq: number;
  readonly updatedAt: number;
  readonly bookVersion: string;
}

type MutableBook = {
  /** Count values are exact hundredths-of-a-contract units. */
  yes: Map<number, number>;
  no: Map<number, number>;
  sid: number;
  seq: number;
  updatedAt: number;
  gapped: boolean;
};

const finitePrice = (value: unknown): number | null => {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};
const countHundredths = (value: unknown): number | null => {
  const units = regularCountHundredths(value);
  return units === null ? null : Number(units);
};
const signedCountHundredths = (value: unknown): number | null => {
  if (typeof value === "string" && value.startsWith("-")) {
    const units = regularCountHundredths(value.slice(1));
    return units === null ? null : -Number(units);
  }
  return countHundredths(value);
};
const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Pure, fail-closed sequence validator for Kalshi orderbook_delta streams. */
export class KalshiOrderbookStore {
  private readonly books = new Map<string, MutableBook>();
  /** Kalshi sequence numbers belong to the subscription id, not a ticker. */
  private readonly lastSeqBySid = new Map<number, number>();
  private readonly invalidSids = new Set<number>();
  private readonly staleAfterMs: number;

  constructor(staleAfterMs = 5_000) {
    this.staleAfterMs = staleAfterMs;
  }

  clear(): void {
    this.books.clear();
    this.lastSeqBySid.clear();
    this.invalidSids.clear();
  }

  invalidate(ticker: string): void {
    const book = this.books.get(ticker);
    if (book) book.gapped = true;
  }

  apply(raw: unknown, now = Date.now()): boolean {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (event.type === "orderbook_snapshot") return this.applySnapshot(event, now);
    if (event.type === "orderbook_delta") return this.applyDelta(event, now);
    return false;
  }

  private applySnapshot(event: Record<string, unknown>, now: number): boolean {
    const msg = event.msg;
    const sid = integer(event.sid);
    const seq = integer(event.seq);
    if (!msg || typeof msg !== "object" || sid === null || seq === null) return false;
    const body = msg as Record<string, unknown>;
    const ticker = typeof body.market_ticker === "string" && body.market_ticker ? body.market_ticker : null;
    const yes = this.parseLevels(body.yes_dollars_fp);
    const no = this.parseLevels(body.no_dollars_fp);
    if (!ticker || !yes || !no) {
      this.invalidateSid(sid);
      return false;
    }
    if (!this.acceptSequence(sid, seq)) return false;
    this.books.set(ticker, { yes, no, sid, seq, updatedAt: now, gapped: false });
    return true;
  }

  private parseLevels(raw: unknown): Map<number, number> | null {
    // Kalshi omits a side entirely when that side has no resting levels.
    // That is a valid empty book, not a malformed snapshot.
    if (raw === undefined || raw === null) return new Map();
    if (!Array.isArray(raw)) return null;
    const levels = new Map<number, number>();
    for (const level of raw) {
      if (!Array.isArray(level) || level.length !== 2) return null;
      const price = finitePrice(level[0]);
      const count = countHundredths(level[1]);
      if (price === null || count === null) return null;
      if (count > 0) levels.set(price, count);
    }
    return levels;
  }

  private applyDelta(event: Record<string, unknown>, now: number): boolean {
    const msg = event.msg;
    const sid = integer(event.sid);
    const seq = integer(event.seq);
    if (!msg || typeof msg !== "object" || sid === null || seq === null) return false;
    const body = msg as Record<string, unknown>;
    const ticker = typeof body.market_ticker === "string" && body.market_ticker ? body.market_ticker : null;
    const price = finitePrice(body.price_dollars);
    const delta = signedCountHundredths(body.delta_fp);
    const side = body.side === "yes" || body.side === "no" ? body.side : null;
    const book = ticker ? this.books.get(ticker) : undefined;
    if (!ticker || price === null || delta === null || !side || !book ||
        book.gapped || book.sid !== sid || !this.acceptSequence(sid, seq)) {
      this.invalidateSid(sid);
      return false;
    }
    const levels = book[side];
    const next = (levels.get(price) ?? 0) + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
      this.invalidateSid(sid);
      return false;
    }
    if (next === 0) levels.delete(price);
    else levels.set(price, next);
    book.seq = seq;
    book.updatedAt = now;
    return true;
  }

  private acceptSequence(sid: number, seq: number): boolean {
    const previous = this.lastSeqBySid.get(sid);
    // A fresh snapshot is the explicit recovery boundary after a detected gap.
    if (this.invalidSids.delete(sid)) {
      this.lastSeqBySid.set(sid, seq);
      return true;
    }
    if (previous !== undefined && seq !== previous + 1) {
      this.invalidateSid(sid);
      return false;
    }
    this.lastSeqBySid.set(sid, seq);
    return true;
  }

  /** A stream gap invalidates every ticker that came from that subscription. */
  private invalidateSid(sid: number): void {
    this.invalidSids.add(sid);
    for (const book of this.books.values()) {
      if (book.sid === sid) book.gapped = true;
    }
  }

  /** Returns an immutable executable view only while sequence-valid and fresh. */
  getExecutable(
    ticker: string,
    side: KalshiSide,
    maxContracts: number,
    floor: number,
    ceiling: number,
    now = Date.now(),
  ): ExecutableBook | null {
    const book = this.books.get(ticker);
    if (!book || book.gapped || now - book.updatedAt > this.staleAfterMs ||
        !Number.isInteger(maxContracts) || maxContracts < 1) return null;
    // To buy YES, lift NO bids: their YES cost is 1 - NO bid. Vice versa for NO.
    const source = side === "yes" ? book.no : book.yes;
    const levels = [...source.entries()]
      .map(([price, units]) => ({ cost: 1 - price, units }))
      .filter(({ cost, units }) => cost >= floor && cost <= ceiling && units > 0)
      .sort((a, b) => a.cost - b.cost);
    if (!levels.length) return null;
    // Quote only complete contracts. Fractional lots can contribute toward a
    // complete contract, but any remainder can never authorize another one.
    let availableUnits = 0;
    for (const level of levels) {
      availableUnits += level.units;
      if (!Number.isSafeInteger(availableUnits)) return null;
    }
    const contracts = Math.min(maxContracts, Math.floor(availableUnits / 100));
    if (contracts <= 0) return null;
    let remainingUnits = contracts * 100;
    let weightedCostUnits = 0;
    for (const level of levels) {
      const takeUnits = Math.min(remainingUnits, level.units);
      weightedCostUnits += takeUnits * level.cost;
      remainingUnits -= takeUnits;
      if (remainingUnits <= 0) break;
    }
    return Object.freeze({
      ticker, side, sideCost: Number((weightedCostUnits / (contracts * 100)).toFixed(8)), visibleContracts: contracts,
      seq: book.seq, updatedAt: book.updatedAt, bookVersion: `${book.sid}:${book.seq}`,
    });
  }

  isFresh(ticker: string, now = Date.now()): boolean {
    const book = this.books.get(ticker);
    return Boolean(book && !book.gapped && now - book.updatedAt <= this.staleAfterMs);
  }
}