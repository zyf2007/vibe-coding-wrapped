import { describe, expect, it } from "vitest";
import { completionScript } from "../src/completion.js";

describe("completionScript", () => {
  it("provides described zsh commands and options", () => {
    const script = completionScript("zsh");
    expect(script).toContain("build:只生成 JSON Report Bundle");
    expect(script).toContain("*-i[Agent 数据目录");
    expect(script).toContain("--clean[忽略已有 JSON");
  });

  it("supports bash and rejects unsupported shells", () => {
    expect(completionScript("bash")).toContain("complete -F");
    expect(() => completionScript("fish")).toThrow("Unsupported completion shell");
  });
});
