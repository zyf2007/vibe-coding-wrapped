import { describe, expect, it } from "vitest";
import { emptyFacts, mergeFactSets } from "../src/domain/facts.js";

describe("mergeFactSets", () => {
  it("merges large collections without spreading them into function arguments", () => {
    const facts = emptyFacts();
    facts.diagnostics = Array.from({ length: 200_000 }, (_, index) => ({
      sourceId: "source",
      file: `file-${index}.json`,
      code: "invalid_json",
    }));

    const merged = mergeFactSets([facts]);

    expect(merged.diagnostics).toHaveLength(200_000);
    expect(merged.diagnostics.at(-1)?.file).toBe("file-199999.json");
  });
});
