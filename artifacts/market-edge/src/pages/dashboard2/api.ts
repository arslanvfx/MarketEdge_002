import { Dashboard2Status, BotConfig, LedgerRow, Analytics, AuditRow, ReadinessReason, DailyPerformance, WhatIfPerformance } from "./types";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

async function handleRes(res: Response, defaultError: string) {
  if (!res.ok) {
    let errMessage = `${defaultError} (${res.status})`;
    try {
      const err = await res.json();
      if (err && err.error) errMessage = err.error;
    } catch (e) {
      // Ignore JSON parse error
    }
    throw new Error(errMessage);
  }
  return res.json();
}

export async function fetchStatus(token: string | null): Promise<Dashboard2Status> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/status`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch dashboard status");
}

export async function updateExecutionOwner(
  token: string | null,
  owner: 'current_bot' | 'dashboard2_bot' | 'paused'
): Promise<{ executionOwner: string; observationOnly: boolean; updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/execution-owner`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ executionOwner: owner })
  });
  return handleRes(res, "Failed to update execution owner");
}

export async function fetchMode(token: string | null): Promise<{ selectedMode: 'paper' | 'live', updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/mode`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch mode");
}

export async function updateMode(token: string | null, mode: 'paper' | 'live'): Promise<{ selectedMode: 'paper' | 'live', updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/mode`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ selectedMode: mode })
  });
  return handleRes(res, "Failed to update mode");
}

export async function fetchConfig(token: string | null, mode: 'paper' | 'live'): Promise<{ config: BotConfig, updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/config/${mode}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch config");
}

export async function updateConfig(token: string | null, mode: 'paper' | 'live', config: Partial<BotConfig>): Promise<{ config: BotConfig, updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/config/${mode}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(config)
  });
  return handleRes(res, "Failed to update config");
}

export async function startBot(token: string | null, mode: 'paper' | 'live'): Promise<{ config: BotConfig, updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/${mode}/start`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to start bot");
}

export async function pauseBot(token: string | null, mode: 'paper' | 'live'): Promise<{ config: BotConfig, updatedAt: string }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/${mode}/pause`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to pause bot");
}

export async function fetchPositions(token: string | null, mode: 'paper' | 'live'): Promise<LedgerRow[]> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/positions/${mode}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch positions");
}

export async function fetchHistory(token: string | null, mode: 'paper' | 'live'): Promise<LedgerRow[]> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/history/${mode}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch history");
}

export async function fetchAnalytics(token: string | null, mode: 'paper' | 'live'): Promise<Analytics> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/analytics/${mode}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch analytics");
}

export async function fetchAudit(token: string | null): Promise<AuditRow[]> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/audit`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch audit trail");
}

export async function fetchReadiness(token: string | null): Promise<{ activationReady: boolean, reasons: ReadinessReason[] }> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/activation-readiness`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch readiness");
}

export async function fetchDailyPerformance(token: string | null, mode: 'paper' | 'live'): Promise<DailyPerformance> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/performance/daily/${mode}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch daily performance");
}

export async function fetchWhatIfPerformance(token: string | null, mode: 'paper' | 'live', stake: number): Promise<WhatIfPerformance> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/performance/what-if/${mode}?stake=${stake}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return handleRes(res, "Failed to fetch what-if performance");
}
