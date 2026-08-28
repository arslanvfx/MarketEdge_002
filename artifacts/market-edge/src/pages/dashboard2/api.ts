import { Dashboard2Status } from "./types";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

export async function fetchStatus(token: string | null): Promise<Dashboard2Status> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/status`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch dashboard status: ${res.status}`);
  }
  return res.json();
}

export async function updateExecutionOwner(
  token: string | null,
  owner: 'current_bot' | 'dashboard2_bot' | 'paused'
): Promise<Dashboard2Status['system']> {
  const res = await fetch(`${API_BASE}/v2/dashboard2/execution-owner`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ executionOwner: owner })
  });
  
  if (!res.ok) {
    let errMessage = `Failed to update execution owner (${res.status})`;
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