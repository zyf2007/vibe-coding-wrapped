import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexFacts } from "../src/input/adapters/codex.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Codex prompt formats", () => {
  it("reads response_item user messages and deduplicates old and new representations", async () => {
    const root = await mkdtemp(join("/tmp", "vibe-codex-new-format-")); temporaryDirectories.push(root);
    const sessions = join(root, "sessions", "2026", "07"); await mkdir(sessions, { recursive: true });
    const file = join(sessions, "rollout-2026-07-10-new-format.jsonl");
    const rows = [
      { timestamp: "2026-07-10T08:00:00Z", type: "session_meta", payload: { id: "s1", cwd: "/work/demo" } },
      { timestamp: "2026-07-10T08:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "兼容新格式并测试" }] } },
      { timestamp: "2026-07-10T08:00:01Z", type: "event_msg", payload: { type: "user_message", message: "兼容新格式并测试" } },
      { timestamp: "2026-07-10T08:00:02Z", type: "turn_context", payload: { turn_id: "t1", model: "gpt-5" } },
    ];
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const facts = await readCodexFacts([root], { period: { kind: "month", value: "2026-07", startCodingDay: "2026-07-01", endCodingDay: "2026-07-31" }, timezone: "UTC", dayStartHour: 4, privacy: "redacted" }, () => {}, { bypassCache: true });
    expect(facts.prompts).toHaveLength(1);
    expect(facts.prompts[0].text).toBe("兼容新格式并测试");
  });
});
