const NEW_YORK_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "2-digit",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Derives Kalshi's 15-minute crypto ticker from the UTC window-open key.
 * Kalshi encodes the window CLOSE in New York local time, including DST.
 */
export function buildKalshi15mTicker(symbol: string, windowKey: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(windowKey);
  if (!symbol || !match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const windowOpenMs = Date.UTC(year, month - 1, day, hour, minute);
  const parsed = new Date(windowOpenMs);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
  ) return null;
  const parts = Object.fromEntries(
    NEW_YORK_TIME.formatToParts(new Date(windowOpenMs + 15 * 60_000))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  const closeYear = parts.year;
  const closeMonth = parts.month?.toUpperCase();
  const closeDay = parts.day;
  const closeHour = parts.hour;
  const closeMinute = parts.minute;
  if (!closeYear || !closeMonth || !closeDay || !closeHour || !closeMinute) return null;
  return `KX${symbol.toUpperCase()}15M-${closeYear}${closeMonth}${closeDay}${closeHour}${closeMinute}-${closeMinute}`;
}