const EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date used by every daily bot counter. New York time is DST-aware. */
export function todayEastern(now: Date = new Date()): string {
  const parts = EASTERN_DATE_FORMATTER.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Unable to resolve the current America/New_York date");
  }
  return `${year}-${month}-${day}`;
}