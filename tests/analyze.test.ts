import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { createPeriod } from "../src/time.js";
import type { FactSet, Scope } from "../src/types.js";

const scope: Scope = { period: createPeriod("month", "2026-07"), timezone: "Asia/Shanghai", dayStartHour: 4, privacy: "redacted" };

function fixture(): FactSet {
  return {
    sourceIds: ["source_test"], scannedFiles: 1, scannedBytes: 100, diagnostics: [],
    sessions: [{ id: "session_a", occurredAt: "2026-07-02T00:00:00Z", cwd: "/work/demo", sourceId: "source_test" }],
    turns: [{ id: "turn_a", sessionId: "a", occurredAt: "2026-07-02T00:00:01Z", cwd: "/work/demo", modelId: "gpt-test", effort: "medium" }],
    prompts: [{ id: "prompt_a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:00Z", cwd: "/work/demo", modelId: "gpt-test", text: "请修改 src/app.ts，然后运行 npm test" }],
    tokens: [{ id: "token_a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:01:00Z", modelId: "gpt-test", input: 100, cachedInput: 20, output: 30, reasoning: 5, total: 130 }],
    tools: [
      { id: "tool_a", callId: "call-a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:20Z", name: "apply_patch", category: "patch", cwd: "/work/demo", modelId: "gpt-test", isMutation: true, isCheckInvocation: false },
      { id: "tool_b", callId: "call-b", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:40Z", name: "exec_command", category: "shell-check", cwd: "/work/demo", modelId: "gpt-test", isMutation: false, isCheckInvocation: true, exitCode: 0 },
    ],
    fileChanges: [{ id: "change_a", callId: "call-a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:20Z", path: "src/app.ts", added: 4, deleted: 1, language: "TypeScript", modelId: "gpt-test" }],
  };
}

describe("V1 bundle", () => {
  it("emits observable metrics and excludes speculative conclusions", async () => {
    const bundle = await analyze(fixture(), scope, false);
    expect((bundle.overview.totals as any).value.prompts).toBe(1);
    expect((bundle.tools.postChangeChecks as any).value.rate).toBe(1);
    expect((bundle.code.languages as any).value[0].language).toBe("TypeScript");
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ["taskType", "taskTransition", "switchReason", "taskSuccess", "projectFamiliarity", "reasoningPlan", "attributedCommitTokens"]) expect(serialized).not.toContain(forbidden);
  });
});
