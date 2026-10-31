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

  it("deduplicates replayed session snapshots by stable turn usage", async () => {
    const root = await mkdtemp(join("/tmp", "vibe-codex-snapshot-")); temporaryDirectories.push(root);
    const sessions = join(root, "sessions", "2026", "08"); await mkdir(sessions, { recursive: true });
    const makeSnapshot = (childId: string, timestamp: string) => [
      { timestamp, type: "session_meta", payload: { id: "parent", thread_source: "user" } },
      { timestamp, type: "response_item", payload: { type: "message", id: "msg-1", role: "user", internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }, content: [{ type: "input_text", text: "重放的会话上下文" }] } },
      { timestamp, type: "event_msg", payload: { type: "user_message", internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }, message: "重放的会话上下文" } },
      { timestamp, type: "event_msg", payload: { type: "token_count", internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }, info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 23 }, last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 23 } } } },
      { timestamp: "2026-08-07T08:00:01Z", type: "response_item", payload: { type: "message", id: "msg-2", role: "user", internal_chat_message_metadata_passthrough: { turn_id: "turn-2" }, content: [{ type: "input_text", text: "重放的会话上下文" }] } },
    ];
    await Promise.all([
      writeFile(join(sessions, "rollout-2026-08-07T08-00-00-one.jsonl"), `${makeSnapshot("child-1", "2026-08-07T08:00:00Z").map((row) => JSON.stringify(row)).join("\n")}\n`),
      writeFile(join(sessions, "rollout-2026-08-07T08-00-02-two.jsonl"), `${makeSnapshot("child-2", "2026-08-07T08:00:02Z").map((row) => JSON.stringify(row)).join("\n")}\n`),
    ]);
    const facts = await readCodexFacts([root], { period: { kind: "month", value: "2026-08", startCodingDay: "2026-08-01", endCodingDay: "2026-08-31" }, timezone: "UTC", dayStartHour: 4, privacy: "redacted" }, () => {}, { bypassCache: true });
    expect(facts.prompts).toHaveLength(2);
    expect(facts.tokens).toHaveLength(1);
  });

  it("skips inherited parent history in a Codex subagent snapshot", async () => {
    const root = await mkdtemp(join("/tmp", "vibe-codex-subagent-replay-")); temporaryDirectories.push(root);
    const sessions = join(root, "sessions", "2026", "08"); await mkdir(sessions, { recursive: true });
    const rows = [
      { timestamp: "2026-08-07T08:00:00Z", type: "session_meta", payload: { id: "00000000-0000-0000-0000-0000000000a0", session_id: "parent", thread_source: "subagent" } },
      { timestamp: "2026-08-07T08:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "00000000-0000-0000-0000-000000000090" } },
      { timestamp: "2026-08-07T08:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "父会话历史" }] } },
      { timestamp: "2026-08-07T08:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "00000000-0000-0000-0000-0000000000b0" } },
      { timestamp: "2026-08-07T08:00:01Z", type: "turn_context", payload: { turn_id: "00000000-0000-0000-0000-0000000000b0", model: "gpt-5" } },
      { timestamp: "2026-08-07T08:00:01Z", type: "event_msg", payload: { type: "user_message", message: "子代理真实任务" } },
    ];
    await writeFile(join(sessions, "rollout-2026-08-07T08-00-00-subagent.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const facts = await readCodexFacts([root], { period: { kind: "month", value: "2026-08", startCodingDay: "2026-08-01", endCodingDay: "2026-08-31" }, timezone: "UTC", dayStartHour: 4, privacy: "redacted" }, () => {}, { bypassCache: true });
    expect(facts.prompts.map((prompt) => prompt.text)).toEqual(["子代理真实任务"]);
  });
});
