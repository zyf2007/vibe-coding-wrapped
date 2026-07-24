import type { Period } from "./types.js";

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
const zonedMinuteCache = new Map<string, ZonedParts>();
const codingBoundaryCache = new Map<string, number>();
const MAX_ZONED_MINUTES = 100_000;

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatters.set(timezone, value);
  }
  return value;
}

export function zonedParts(instant: string | Date, timezone: string): ZonedParts {
  const date = new Date(instant);
  const cacheKey = `${timezone}\0${Math.floor(date.getTime() / 60_000)}`;
  const cached = zonedMinuteCache.get(cacheKey);
  if (cached) return cached;
  const values: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const result = {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday,
  };
  zonedMinuteCache.set(cacheKey, result);
  if (zonedMinuteCache.size > MAX_ZONED_MINUTES) zonedMinuteCache.delete(zonedMinuteCache.keys().next().value!);
  return result;
}

export function dateKey(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function codingDay(instant: string | Date, timezone: string, dayStartHour: number): string {
  const parts = zonedParts(instant, timezone);
  if (parts.hour >= dayStartHour) return dateKey(parts.year, parts.month, parts.day);
  const previous = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return dateKey(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

function nextDate(day: string): string {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return dateKey(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

export function codingDayBoundary(day: string, timezone: string, dayStartHour: number): number {
  const cacheKey = `${timezone}\0${dayStartHour}\0${day}`;
  const cached = codingBoundaryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const approximate = Date.parse(`${day}T${String(dayStartHour).padStart(2, "0")}:00:00Z`);
  let low = Math.floor((approximate - 36 * 3_600_000) / 60_000);
  let high = Math.ceil((approximate + 36 * 3_600_000) / 60_000);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (codingDay(new Date(middle * 60_000), timezone, dayStartHour) < day) low = middle + 1;
    else high = middle;
  }
  const boundary = low * 60_000;
  codingBoundaryCache.set(cacheKey, boundary);
  return boundary;
}

export function periodEpochBounds(period: Period, timezone: string, dayStartHour: number): { startInclusive: number; endExclusive: number } {
  return {
    startInclusive: codingDayBoundary(period.startCodingDay, timezone, dayStartHour),
    endExclusive: codingDayBoundary(nextDate(period.endCodingDay), timezone, dayStartHour),
  };
}

export function activeMinute(instant: string | Date, timezone: string, dayStartHour: number): number {
  const parts = zonedParts(instant, timezone);
  return ((parts.hour - dayStartHour + 24) % 24) * 60 + parts.minute;
}

export function localDateTime(instant: string | Date, timezone: string): string {
  const p = zonedParts(instant, timezone);
  return `${dateKey(p.year, p.month, p.day)}T${p.hour.toString().padStart(2, "0")}:${p.minute.toString().padStart(2, "0")}`;
}

export function createPeriod(kind: "year" | "month", value: string): Period {
  if (kind === "year") {
    if (!/^\d{4}$/.test(value)) throw new Error(`Invalid year: ${value}`);
    return { kind, value, startCodingDay: `${value}-01-01`, endCodingDay: `${value}-12-31` };
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Invalid month: ${value}`);
  const [year, month] = value.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { kind, value, startCodingDay: `${value}-01`, endCodingDay: `${value}-${last}` };
}

export function createRangePeriod(value: string): Period {
  const match = value.trim().match(/^(\d{4})[.-](\d{1,2})\s*-\s*(\d{4})[.-](\d{1,2})$/);
  if (!match) throw new Error(`Invalid range: ${value}; expected YYYY.M-YYYY.M`);
  const startYear = Number(match[1]), startMonth = Number(match[2]), endYear = Number(match[3]), endMonth = Number(match[4]);
  if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) throw new Error(`Invalid range: ${value}; month must be 1..12`);
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}`;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}`;
  if (start > end) throw new Error(`Invalid range: ${value}; start must not be after end`);
  const last = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return { kind: "range", value: `${start.replace("-", ".")}-${end.replace("-", ".")}`, startCodingDay: `${start}-01`, endCodingDay: `${end}-${last}` };
}

export function inPeriod(day: string, period: Period): boolean {
  return day >= period.startCodingDay && day <= period.endCodingDay;
}

export function enumerateDays(period: Period): string[] {
  const result: string[] = [];
  const cursor = new Date(`${period.startCodingDay}T00:00:00Z`);
  const end = new Date(`${period.endCodingDay}T00:00:00Z`);
  while (cursor <= end) {
    result.push(dateKey(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
