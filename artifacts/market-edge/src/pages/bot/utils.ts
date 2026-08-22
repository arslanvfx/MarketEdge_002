export const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

// ─── Helpers ────────────────────────────────────────────────────────────────

export const fmt$ = (n: number | string | null | undefined, decimals = 2) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

export const fmtPct = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : `${(v * 100).toFixed(0)}¢`;
};

export const fmtContracts = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const value = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
};

export const fmtCrypto = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "—";
  // Use enough decimals to preserve meaningful precision at every price tier.
  // $1000+  → 2dp (BTC, ETH high-range)
  // $1–999  → up to 4dp (XRP $1.1355, SOL, LINK, etc.)
  // <$1     → up to 6dp (DOGE, very low-priced coins)
  if (v >= 1000) return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 1)    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
};

export const EST = "America/New_York";
export const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: EST }) + " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: EST }) + " EST";
};

/** Convert a windowKey like "2026-07-03T05:15" (UTC) to "12:15 AM EST" display. */
export const wkToEst = (wk: string | null | undefined): string => {
  if (!wk) return "—";
  const d = new Date(wk + ":00Z");
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EST });
};

/** Convert a windowKey like "2026-07-08T13:15" (UTC) to an ET range like "9:15 – 9:30 AM". */
export const wkToEstRange = (wk: string | null | undefined): string => {
  if (!wk) return "—";
  const start = new Date(wk + ":00Z");
  const end = new Date(start.getTime() + 15 * 60_000);
  const fmtNoAmPm = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EST }).replace(/\s?[AP]M$/i, "");
  const fmtFull = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EST });
  return `${fmtNoAmPm(start)} – ${fmtFull(end)}`;
};

/** Convert "HH-HH" UTC hour band to EST, e.g. "00-02" → "7PM-9PM EST". */
export const bandToEst = (band: string): string => {
  const [s, e] = band.split("-").map(Number);
  const fmt = (h: number) => {
    const ampm = ((h % 24) < 12) ? "AM" : "PM";
    const h12 = ((h % 24) % 12) || 12;
    return `${h12}${ampm}`;
  };
  return `${fmt((s - 5 + 24) % 24)}-${fmt((e - 5 + 24) % 24)}`;
};

export const fmtDuration = (start: string | null, end: string | null) => {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
};

export const GUARD_LABELS: Record<string, string> = {
  holdDurationMet: "Hold", flipConfirmed: "Flip",
  erSupports: "ER", timingSupports: "Timing", phase2Active: "Phase2",
  mlFlipped: "ML",
};

// Eastern Time ↔ UTC helpers — accounts for DST (EDT = UTC−4 in summer, EST = UTC−5 in winter)
export function getEtUtcOffset(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  // DST starts: second Sunday of March at 2AM ET (= 7AM UTC)
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7, 7));
  // DST ends: first Sunday of November at 2AM ET (= 6AM UTC)
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, (7 - novFirst.getUTCDay()) % 7 + 1, 6));
  return now >= dstStart && now < dstEnd ? 4 : 5;
}
export const ET_OFFSET = getEtUtcOffset(); // 4 = EDT (summer), 5 = EST (winter)
export const ET_LABEL = ET_OFFSET === 4 ? "EDT" : "EST";
export const utcToEst = (h: number) => (h - ET_OFFSET + 24) % 24;
export const estToUtc = (h: number) => (h + ET_OFFSET) % 24;

