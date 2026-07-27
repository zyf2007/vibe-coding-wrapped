import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { temporarySiblingPath } from "../src/report/temporary.js";

describe("temporarySiblingPath", () => {
  it("keeps Windows temporary directories beside their target", () => {
    const target = String.raw`C:\Users\62758\.vibe-wrapped-2026.json-35656`;

    expect(temporarySiblingPath(target, 35656, win32)).toBe(
      String.raw`C:\Users\62758\..vibe-wrapped-2026.json-35656.tmp-35656`,
    );
  });
});
