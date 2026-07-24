import { describe, expect, it } from "vitest";
import { codingDay, createPeriod, createRangePeriod, enumerateDays, inPeriod } from "../src/domain/time.js";

describe("coding day", () => {
  it("uses 04:00 as the default-style boundary", () => {
    expect(codingDay("2026-07-02T19:59:00Z", "Asia/Shanghai", 4)).toBe("2026-07-02");
    expect(codingDay("2026-07-02T20:00:00Z", "Asia/Shanghai", 4)).toBe("2026-07-03");
  });

  it("handles DST through IANA timezone parts", () => {
    expect(codingDay("2026-03-08T06:30:00Z", "America/New_York", 4)).toBe("2026-03-07");
    expect(codingDay("2026-03-08T08:30:00Z", "America/New_York", 4)).toBe("2026-03-08");
  });

  it("accepts an inclusive calendar-month range", () => {
    const period = createRangePeriod("2026.1-2026.7");
    expect(period).toEqual({ kind: "range", value: "2026.01-2026.07", startCodingDay: "2026-01-01", endCodingDay: "2026-07-31" });
    expect(enumerateDays(period)).toHaveLength(212);
    expect(() => createRangePeriod("2026.8-2026.7")).toThrow(/start/);
  });
});

describe("period", () => {
  it("enumerates a month exactly", () => {
    const period = createPeriod("month", "2026-07");
    expect(enumerateDays(period)).toHaveLength(31);
    expect(inPeriod("2026-07-31", period)).toBe(true);
    expect(inPeriod("2026-08-01", period)).toBe(false);
  });
});
