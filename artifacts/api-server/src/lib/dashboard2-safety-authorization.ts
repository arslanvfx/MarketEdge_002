import { randomUUID } from "node:crypto";
import type { Dashboard2Policy } from "./dashboard2-policy.ts";

export interface Dashboard2SafetyIdentity {
  mode: "paper" | "live";
  symbol: string;
  ticker: string;
  windowKey: string;
  side: "yes" | "no";
  policyVersion: string;
  bookVersion: string;
}

export interface Dashboard2SafetyAuthorization extends Dashboard2SafetyIdentity {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

const sameIdentity = (a: Dashboard2SafetyIdentity, b: Dashboard2SafetyIdentity): boolean =>
  a.mode === b.mode &&
  a.symbol === b.symbol &&
  a.ticker === b.ticker &&
  a.windowKey === b.windowKey &&
  a.side === b.side &&
  a.policyVersion === b.policyVersion &&
  a.bookVersion === b.bookVersion;

/** In-memory, one-use authorization contract. It grants no broker capability. */
export class Dashboard2SafetyAuthorizationStore {
  private readonly authorizations = new Map<string, Dashboard2SafetyAuthorization>();

  issue(
    identity: Omit<Dashboard2SafetyIdentity, "policyVersion"> & { policyVersion?: string },
    policy: Dashboard2Policy,
    now = Date.now(),
    ttlMs = 5_000,
  ): Dashboard2SafetyAuthorization {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 30_000) {
      throw new Error("Dashboard 2.0 safety authorization TTL must be in (0, 30000]ms");
    }
    const authorization = Object.freeze({
      ...identity,
      symbol: identity.symbol.toUpperCase(),
      policyVersion: identity.policyVersion ?? policy.version,
      token: randomUUID(),
      issuedAt: now,
      expiresAt: now + ttlMs,
    });
    this.authorizations.set(authorization.token, authorization);
    return authorization;
  }

  consume(
    token: string,
    identity: Dashboard2SafetyIdentity,
    now = Date.now(),
  ): { accepted: true } | { accepted: false; reason: "not_found_or_used" | "expired" | "identity_mismatch" } {
    const authorization = this.authorizations.get(token);
    if (!authorization) return { accepted: false, reason: "not_found_or_used" };
    // Consume on every attempt, including a mismatched or expired attempt.
    this.authorizations.delete(token);
    if (now >= authorization.expiresAt) return { accepted: false, reason: "expired" };
    const normalized = { ...identity, symbol: identity.symbol.toUpperCase() };
    if (!sameIdentity(authorization, normalized)) {
      return { accepted: false, reason: "identity_mismatch" };
    }
    return { accepted: true };
  }
}