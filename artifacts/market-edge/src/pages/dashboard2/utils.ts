export function formatCents(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const num = typeof cents === "string" ? parseFloat(cents) : cents;
  if (isNaN(num)) return "—";
  return `${(num * 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}¢`;
}

export function formatDollar(dollars: number | string | null | undefined): string {
  if (dollars === null || dollars === undefined) return "—";
  const num = typeof dollars === "string" ? parseFloat(dollars) : dollars;
  if (isNaN(num)) return "—";
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatTime(seconds: number): string {
  if (seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  const date = new Date(isoString);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}