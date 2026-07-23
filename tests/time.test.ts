import { describe, expect, it } from "vitest";
import { codingDay, createPeriod, enumerateDays, inPeriod } from "../src/time.js";

describe("coding day", () => {
  it("uses 04:00 as the default-style boundary", () => {
    expect(codingDay("2026-07-02T19:59:00Z", "Asia/Shanghai", 4)).toBe("2026-07-02");
    expect(codingDay("2026-07-02T20:00:00Z", "Asia/Shanghai", 4)).toBe("2026-07-03");
  });

  it("handles DST through IANA timezone parts", () => {
    expect(codingDay("2026-03-08T06:30:00Z", "America/New_York", 4)).toBe("2026-03-07");
    expect(codingDay("2026-03-08T08:30:00Z", "America/New_York", 4)).toBe("2026-03-08");
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
