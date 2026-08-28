export interface Dashboard2Status {
  system: {
    executionOwner: 'current_bot' | 'dashboard2_bot' | 'paused';
    observationOnly: boolean;
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
  readiness: Array<{
    id: string;
    label: string;
    status: 'ready' | 'warming' | 'blocked' | 'stale';
    detail: string;
    updatedAt: string | null;
  }>;
  markets: Array<{
    symbol: string;
    ticker: string | null;
    side: 'yes' | 'no' | null;
    sideCost: number | null;
    visibleContracts: number;
    bookFresh: boolean;
    safety: 'approved' | 'waiting' | 'blocked';
    reason: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    at: string;
    type: string;
    message: string;
    severity: 'info' | 'success' | 'warning' | 'error';
  }>;
}
