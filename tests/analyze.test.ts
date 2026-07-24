import { describe, expect, it } from "vitest";
import { analyze } from "../src/analysis/analyze.js";
import { createPeriod } from "../src/domain/time.js";
import type { FactSet, Scope } from "../src/domain/types.js";

const scope: Scope = { period: createPeriod("month", "2026-07"), timezone: "Asia/Shanghai", dayStartHour: 4, privacy: "redacted" };

function fixture(): FactSet {
  return {
    sources: [{ id: "source_test", agentType: "codex", root: "/test" }], scannedFiles: 1, scannedBytes: 100, diagnostics: [],
    sessions: [{ id: "session_a", occurredAt: "2026-07-02T00:00:00Z", cwd: "/work/demo", sourceId: "source_test" }],
    turns: [{ id: "turn_a", sessionId: "a", occurredAt: "2026-07-02T00:00:01Z", cwd: "/work/demo", modelId: "gpt-test", effort: "medium" }],
    prompts: [
      { id: "prompt_a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:00Z", cwd: "/work/demo", modelId: "gpt-test", text: "请保持现有接口兼容。不要改变公开字段。然后修改 src/app.ts，并运行 npm test" },
      { id: "prompt_b", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-04T00:00:10Z", cwd: "/work/demo", modelId: "gpt-test", text: "请保持现有接口兼容。不要改变公开字段。那个实现应该保留列表：\n- API\n- tests" },
    ],
    tokens: [{ id: "token_a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:01:00Z", modelId: "gpt-test", input: 100, cachedInput: 20, output: 30, reasoning: 5, total: 130 }],
    tools: [
      { id: "tool_a", callId: "call-a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:20Z", name: "file.patch", rawName: "apply_patch", category: "file", cwd: "/work/demo", modelId: "gpt-test", isMutation: true, isCheckInvocation: false },
      { id: "tool_b", callId: "call-b", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:40Z", name: "shell.run", rawName: "exec_command", category: "shell", cwd: "/work/demo", modelId: "gpt-test", isMutation: false, isCheckInvocation: true, exitCode: 0 },
    ],
    fileChanges: [{ id: "change_a", callId: "call-a", sessionId: "a", turnId: "turn-a", occurredAt: "2026-07-02T00:00:20Z", path: "src/app.ts", added: 4, deleted: 1, language: "TypeScript", modelId: "gpt-test" }],
  };
}

describe("V1 bundle", () => {
  it("emits observable metrics and excludes speculative conclusions", async () => {
    const bundle = await analyze(fixture(), scope, false);
    expect((bundle.overview.totals as any).value.prompts).toBe(2);
    expect((bundle.tools.postChangeChecks as any).value.rate).toBe(1);
    expect((bundle.code.languages as any).value[0].language).toBe("TypeScript");
    const terms = (bundle.prompts.terms as any).frequent.value.map((item: any) => item.term);
    expect(terms).not.toContain("然后");
    expect(terms).not.toContain("那个");
    expect(terms).not.toContain("应该");
    expect(terms).not.toContain("直接");
    expect((bundle.prompts.notable as any).value.length).toBeGreaterThan(0);
    expect((bundle.prompts.keySentences as any).value.map((item: any) => item.sentence)).toContain("不要改变公开字段");
    expect((bundle.prompts.terms as any).keywordContexts.value.length).toBeGreaterThan(0);
    expect((bundle.records.busiestDayPrompts as any).value.first.excerpt).toContain("接口兼容");
    expect((bundle.records.longestGap as any).value.days).toBe(1);
    expect((bundle.records.memoryMoments as any).value.map((item: any) => item.kind)).toContain("return_after_gap");
    expect((bundle.prompts.firstInPeriod as any).value).toMatchObject({ projectName: "demo", modelId: "gpt-test" });
    expect((bundle.records.earliestActivity as any).value).toMatchObject({ projectName: "demo", modelId: "gpt-test" });
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ["taskType", "taskTransition", "switchReason", "taskSuccess", "projectFamiliarity", "reasoningPlan", "attributedCommitTokens"]) expect(serialized).not.toContain(forbidden);
  });
});
