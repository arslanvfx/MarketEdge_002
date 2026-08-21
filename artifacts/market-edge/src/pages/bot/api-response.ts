type ApiErrorPayload = {
  error?: unknown;
  message?: unknown;
  errors?: unknown;
};

function asUsefulText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function formatDetails(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const details = value
    .map(item => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const path = Array.isArray(record.path) ? record.path.join(".") : null;
        const message = asUsefulText(record.message) ?? asUsefulText(record.error);
        if (message) return path ? `${path}: ${message}` : message;
      }
      return null;
    })
    .filter((item): item is string => Boolean(item));
  return details.length > 0 ? details.join("; ") : null;
}

export function formatApiError(payload: unknown, status: number): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();

  if (payload && typeof payload === "object") {
    const body = payload as ApiErrorPayload;
    const primary = asUsefulText(body.error) ?? asUsefulText(body.message);
    const details = formatDetails(body.errors);
    if (primary && details) return `${primary}: ${details}`;
    if (primary) return primary;
    if (details) return details;
  }

  return `Request failed (HTTP ${status})`;
}

export async function readApiResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  let payload: unknown = {};

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    throw new Error(formatApiError(payload, response.status));
  }

  return payload;
}