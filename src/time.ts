import type { Period } from "./types.js";

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

const formatters = new Map<string, Intl.DateTimeFormat>();

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
  const values: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday,
  };
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
