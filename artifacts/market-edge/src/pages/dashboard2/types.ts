export interface BotConfig {
  enabled: boolean;
  version: number;
  minEntryMinute: number;
  sideCostFloor: number;
  sideCostCeiling: number;
  maxContracts: number;
  maxDollarBudget: number;
  minAccountBalance: number;
  maxTotalExposure: number;
  maxConcurrentPositions: number;
  enabledSymbols: string[];
  quietHours: { enabled: boolean; startUtc: number; endUtc: number };
  proximityGuard: { enabled: boolean; minPct: number };
  directionGuard: { enabled: boolean };
  stopLoss: { enabled: boolean; floor: number; activationMinute: number };
  circuitBreaker: { enabled: boolean; maxDailyLoss: number; maxConsecutiveLosses: number };
  liveActivation: boolean;
  paperStartingBalance: number;
}

export interface LedgerRow {
  id: string;
  mode: 'paper' | 'live';
  symbol: string;
  window_key: string | null;
  ticker: string | null;
  side: 'yes' | 'no' | null;
  status: string;
  requested_contracts: number | string;
  filled_contracts: number | string;
  entry_cost: number | string;
  book_version: string | null;
  client_order_id: string | null;
  order_id: string | null;
  reconcile_reason: string | null;
  details: any;
  settled_at: string | null;
  settlement_value: number | string | null;
  pnl?: number | string | null;
  remaining_contracts?: number | string | null;
  exited_contracts?: number | string | null;
  created_at: string;
}

export interface Analytics {
  attempts: number | string;
  fills: number | string;
  contracts: number | string;
  settled: number | string;
  pnl: number | string;
}

export interface AuditRow {
  id: string;
  action: string;
  mode: 'paper' | 'live' | null;
  details: any;
  created_at: string;
}

export interface ReadinessReason {
  id: string;
  label: string;
  status: 'ready' | 'warming' | 'blocked' | 'stale' | string;
  detail: string;
  updatedAt?: string | null;
}

export interface Dashboard2Status {
  system: {
    executionOwner: 'current_bot' | 'dashboard2_bot' | 'paused';
    observationOnly: boolean;
    selectedMode: 'paper' | 'live';
    running: boolean;
    bookConnection: {
      ready: boolean;
      connected: boolean;
      connecting: boolean;
      connectedAt: string | null;
      lastMessageAt: string | null;
      subscribedTickers: number;
      reconnectAttempt: number;
      lastError: string | null;
    };
    readiness?: {
      activationReady: boolean;
      reasons: string[];
    };
    updatedAt: string;
  };
  policy: {
    minEntryMinute: number;
    sideCostFloor: number;
    sideCostCeiling: number;
    maxContracts: number;
    version: string;
  };
  window: {
    key: string | null;
    elapsedSeconds: number;
    entryOpensInSeconds: number;
    phase: 'preparing' | 'armed' | 'eligible' | 'blocked';
  };
  readiness: ReadinessReason[];
  markets: Array<{
    symbol: string;
    ticker: string | null;
    side: 'yes' | 'no' | null;
    sideCost: number | null;
    visibleContracts: number;
    bookFresh: boolean;
    safety: 'approved' | 'waiting' | 'blocked';
    reason: string | null;
    target: number | null;
    spot: number | null;
    distancePct: number | null;
    intendedQuantity: number | null;
    bookVersion: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    at: string;
    type: string;
    message: string;
    severity: 'info' | 'success' | 'warning' | 'error';
  }>;
}

export interface PerformanceSummary {
  balance: number | null;
  balanceLabel: string;
  todayPnl: number;
  allTimePnl: number;
  wins: number;
  losses: number;
  pushes: number;
  totalBets: number;
  winRate: number | null;
}

export interface HourlyPerformance {
  etHour: number;
  pnl: number;
  bets: number;
}

export interface DailyPerformance {
  mode: 'paper' | 'live';
  timeZone: string;
  dayStartAt: string;
  nextResetAt: string;
  summary: PerformanceSummary;
  hours: HourlyPerformance[];
}

export interface WhatIfPerformance {
  mode: 'paper' | 'live';
  timeZone: string;
  dayStartAt: string;
  nextResetAt: string;
  stakePerBet: number;
  includedCount: number;
  excludedCount: number;
  actualStake: number;
  actualPnl: number;
  actualRoiPct: number | null;
  hypotheticalStake: number;
  hypotheticalPnl: number;
  hypotheticalRoiPct: number | null;
  deltaPnl: number;
  deltaPct: number | null;
  assumptions: string[];
}
