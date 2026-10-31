import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeFacts } from "../src/input/adapters/claude.js";
import { readCodexFacts } from "../src/input/adapters/codex.js";
import { normalizeTool } from "../src/domain/tools.js";
import { readOpenCodeFacts } from "../src/input/adapters/opencode.js";
import { readPiFacts } from "../src/input/adapters/pi.js";
import { readDshFacts } from "../src/input/adapters/dsh.js";
import { createPeriod } from "../src/domain/time.js";
import type { Scope } from "../src/domain/types.js";
import * as zlib from "node:zlib";

const scope: Scope = { period: createPeriod("month", "2026-07"), timezone: "UTC", dayStartHour: 4, privacy: "redacted" };
const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("canonical tool semantics", () => {
  it("maps equivalent tools from different agents to one name", () => {
    expect(normalizeTool("apply_patch").name).toBe("file.patch");
    expect(normalizeTool("Edit").name).toBe("file.edit");
    expect(normalizeTool("edit").name).toBe("file.edit");
    expect(normalizeTool("Bash").name).toBe("shell.run");
    expect(normalizeTool("mcp__github__search").name).toBe("mcp.call");
  });
});

describe("Claude Code adapter", () => {
  it("reads prompts, models, token usage, tools and edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-claude-")); temporaryDirectories.push(root);
    const projects = join(root, "projects", "demo"); await mkdir(projects, { recursive: true });
    const rows = [
      { type: "user", sessionId: "s1", cwd: "/work/demo", timestamp: "2026-07-10T08:00:00Z", uuid: "u1", message: { role: "user", content: "更新配置并测试" } },
      { type: "assistant", sessionId: "s1", cwd: "/work/demo", timestamp: "2026-07-10T08:00:01Z", uuid: "a1", message: { id: "m1", role: "assistant", model: "claude-opus-4.5", usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }, content: [{ type: "tool_use", id: "call1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b\nc" } }] } },
      { type: "user", sessionId: "s1", cwd: "/work/demo", timestamp: "2026-07-10T08:00:02Z", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "ok" }] } },
    ];
    await writeFile(join(projects, "s1.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const progress: string[] = [];
    const facts = await readClaudeFacts([root], scope, (message) => progress.push(message));
    expect(facts.prompts.map((item) => item.text)).toEqual(["更新配置并测试"]);
    expect(facts.tools[0]).toMatchObject({ name: "file.edit", rawName: "Edit", exitCode: 0 });
    expect(facts.fileChanges[0]).toMatchObject({ path: "src/app.ts", added: 2, deleted: 1 });
    expect(facts.tokens[0]).toMatchObject({ input: 12, cachedInput: 3, output: 4, total: 19 });
    const cached = await readClaudeFacts([root], scope, (message) => progress.push(message));
    expect(cached).toEqual(facts);
    expect(progress.some((message) => message.includes("Claude Code cache: reused 1/1"))).toBe(true);
  });
});

describe("Codex adapter cache", () => {
  it("reuses unchanged sessions and only reparses a changed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-codex-")); temporaryDirectories.push(root);
    const cache = await mkdtemp(join(tmpdir(), "vibe-cache-")); temporaryDirectories.push(cache);
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    try {
      const sessions = join(root, "sessions", "2026", "07"); await mkdir(sessions, { recursive: true });
      const file = join(sessions, "rollout-2026-07-10-demo.jsonl");
      const rows = [
        { timestamp: "2026-07-10T08:00:00Z", type: "session_meta", payload: { id: "s1", cwd: "/work/demo" } },
        { timestamp: "2026-07-10T08:00:01Z", type: "event_msg", payload: { type: "user_message", message: "修复缓存并验证" } },
        { timestamp: "2026-07-10T08:00:02Z", type: "turn_context", payload: { turn_id: "t1", model: "gpt-5" } },
        { timestamp: "2026-07-10T08:00:03Z", type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
      ];
      await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      const coldProgress: string[] = [];
      const cold = await readCodexFacts([root], scope, (message) => coldProgress.push(message));
      expect(cold.prompts).toHaveLength(1);
      expect(coldProgress.some((message) => message.includes("Parsed 1/1 uncached Codex files"))).toBe(true);

      const warmProgress: string[] = [];
      const warm = await readCodexFacts([root], scope, (message) => warmProgress.push(message));
      expect(warm).toEqual(cold);
      expect(warmProgress.some((message) => message.includes("Codex cache: reused 1/1"))).toBe(true);

      await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n\n`);
      const changedProgress: string[] = [];
      const changed = await readCodexFacts([root], scope, (message) => changedProgress.push(message));
      expect(changed.prompts).toEqual(cold.prompts);
      expect(changedProgress.some((message) => message.includes("Parsed 1/1 uncached Codex files"))).toBe(true);

      const cleanProgress: string[] = [];
      await readCodexFacts([root], scope, (message) => cleanProgress.push(message), { bypassCache: true });
      expect(cleanProgress.some((message) => message.includes("Codex cache: reused"))).toBe(false);
      expect(cleanProgress.some((message) => message.includes("Parsed 1/1 uncached Codex files"))).toBe(true);
    } finally {
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
    }
  });

});

describe("DSH adapter", () => {
  it("reads compressed user messages, usage, tools and filters plugin messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-dsh-")); temporaryDirectories.push(root);
    await mkdir(join(root, "sessions", "session-1"), { recursive: true });
    await writeFile(join(root, "settings.yaml"), "version: test\n");
    const rows = [
      { type: "session", id: "s1", cwd: "/work/dsh", createdAt: Date.parse("2026-07-10T08:00:00Z") },
      { type: "model/selection", time: Date.parse("2026-07-10T08:00:00Z"), data: { provider: "test", model: "dsh-model" } },
      { type: "turn/start", seq: 2, time: Date.parse("2026-07-10T08:00:01Z"), data: { turn: 1 } },
      { type: "user/message", seq: 3, time: Date.parse("2026-07-10T08:00:02Z"), data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "检查 DSH 适配器" }] } },
      { type: "user/message", seq: 4, time: Date.parse("2026-07-10T08:00:02Z"), data: { id: "system", role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "runtime context" }] } },
      { type: "assistant/message", seq: 5, time: Date.parse("2026-07-10T08:00:03Z"), data: { turn: 1, step: 1, message: { role: "assistant", content: [] }, usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 4, reasoningTokens: 1, totalTokens: 17 } } },
      { type: "tool/call", seq: 6, time: Date.parse("2026-07-10T08:00:04Z"), data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: JSON.stringify({ command: "npm test" }) } },
      { type: "tool/result", seq: 7, time: Date.parse("2026-07-10T08:00:05Z"), data: { message: { source: { kind: "tool", callId: "c1" }, content: [{ content: [{ type: "text", text: "exit_code: 0" }] }] } } },
      { type: "turn/end", seq: 8, time: Date.parse("2026-07-10T08:00:06Z"), data: { turn: 1 } },
    ];
    const plain = join(root, "sessions", "session-1", "session.v3.jsonl");
    await writeFile(plain, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const compressed = (zlib as typeof zlib & { zstdCompressSync: (input: Buffer) => Buffer }).zstdCompressSync(await readFile(plain));
    const compressedPath = `${plain}.zstd`;
    await writeFile(compressedPath, compressed);
    const facts = await readDshFacts([root], scope, () => {}, { bypassCache: true });
    expect(facts.sources[0].agentType).toBe("dsh");
    expect(facts.prompts).toHaveLength(1);
    expect(facts.prompts[0]).toMatchObject({ text: "检查 DSH 适配器", modelId: "test/dsh-model" });
    expect(facts.tokens[0]).toMatchObject({ input: 10, cachedInput: 2, output: 4, reasoning: 1, total: 17 });
    expect(facts.tools[0]).toMatchObject({ name: "shell.run", exitCode: 0, isCheckInvocation: true });
    expect(facts.sessions).toHaveLength(1);
  });
});

describe("Pi adapter", () => {
  it("normalizes prompts, usage, tools, outcomes and file edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-pi-")); temporaryDirectories.push(root);
    const sessions = join(root, "sessions", "--work-demo--"); await mkdir(sessions, { recursive: true });
    const rows = [
      { type: "session", id: "s1", timestamp: "2026-07-10T08:00:00Z", cwd: "/work/demo" },
      { type: "model_change", id: "m0", timestamp: "2026-07-10T08:00:00Z", provider: "openai", modelId: "gpt-5" },
      { type: "thinking_level_change", id: "e0", timestamp: "2026-07-10T08:00:00Z", thinkingLevel: "high" },
      { type: "message", id: "u1", timestamp: "2026-07-10T08:00:01Z", message: { role: "user", content: [{ type: "text", text: "更新配置并测试" }] } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-10T08:00:02Z", message: { role: "assistant", provider: "openai", model: "gpt-5", usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 19 }, content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "a", newText: "b\nc" }] } }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] } },
      { type: "message", id: "r1", parentId: "a1", timestamp: "2026-07-10T08:00:03Z", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", isError: false, content: [] } },
      { type: "message", id: "r2", parentId: "r1", timestamp: "2026-07-10T08:00:04Z", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, content: [] } },
    ];
    await writeFile(join(sessions, "session.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const progress: string[] = [];
    const facts = await readPiFacts([root], scope, (message) => progress.push(message));
    expect(facts.sources[0].agentType).toBe("pi");
    expect(facts.prompts[0]).toMatchObject({ text: "更新配置并测试", modelId: "openai/gpt-5" });
    expect(facts.turns[0]).toMatchObject({ modelId: "openai/gpt-5", effort: "high" });
    expect(facts.tokens[0]).toMatchObject({ input: 10, cachedInput: 3, cacheWrite: 2, output: 4, total: 19 });
    expect(facts.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "file.edit", exitCode: 0 }), expect.objectContaining({ name: "shell.run", isCheckInvocation: true, exitCode: 1 })]));
    expect(facts.fileChanges[0]).toMatchObject({ path: "src/app.ts", added: 2, deleted: 1, modelId: "openai/gpt-5" });
    expect((await readPiFacts([root], scope, (message) => progress.push(message)))).toEqual(facts);
    expect(progress.some((message) => message.includes("Pi cache: reused 1/1"))).toBe(true);
  });
});

describe("OpenCode adapter", () => {
  it("reads the current SQLite format without splitting canonical tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-opencode-")); temporaryDirectories.push(root);
    const db = new Database(join(root, "opencode.db"));
    db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
    const time = Date.parse("2026-07-11T09:00:00Z");
    db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("s1", "/work/demo", time, time);
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("u1", "s1", time, time, JSON.stringify({ role: "user", model: { providerID: "test", modelID: "model-a" } }));
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("a1", "s1", time + 1000, time + 1000, JSON.stringify({ role: "assistant", parentID: "u1", providerID: "test", modelID: "model-a", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } }));
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run("p1", "u1", "s1", time, time, JSON.stringify({ type: "text", text: "修复登录页面" }));
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run("p2", "a1", "s1", time + 1000, time + 1000, JSON.stringify({ type: "tool", callID: "c1", tool: "edit", state: { status: "completed", input: { filePath: "src/login.ts", oldString: "a", newString: "b" }, metadata: { filediff: { file: "src/login.ts", additions: 1, deletions: 1 } } } }));
    db.close();
    const progress: string[] = [];
    const facts = await readOpenCodeFacts([root], scope, (message) => progress.push(message));
    expect(facts.prompts[0]).toMatchObject({ text: "修复登录页面", modelId: "test/model-a" });
    expect(facts.tools[0]).toMatchObject({ name: "file.edit", rawName: "edit", exitCode: 0 });
    expect(facts.tokens[0]).toMatchObject({ input: 10, cachedInput: 3, cacheWrite: 1, output: 5, reasoning: 2, total: 21 });
    expect(facts.fileChanges[0]).toMatchObject({ path: "src/login.ts", added: 1, deleted: 1 });
    const cached = await readOpenCodeFacts([root], scope, (message) => progress.push(message));
    expect(cached).toEqual(facts);
    expect(progress.some((message) => message.includes("OpenCode SQLite fact cache hit"))).toBe(true);
  });

  it("caches legacy JSON sessions independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-opencode-legacy-")); temporaryDirectories.push(root);
    const sessionDirectory = join(root, "storage", "session", "global");
    const messageDirectory = join(root, "storage", "message", "s1");
    const userParts = join(root, "storage", "part", "u1");
    const assistantParts = join(root, "storage", "part", "a1");
    await Promise.all([sessionDirectory, messageDirectory, userParts, assistantParts].map((path) => mkdir(path, { recursive: true })));
    const time = Date.parse("2026-07-11T09:00:00Z");
    await writeFile(join(sessionDirectory, "s1.json"), JSON.stringify({ id: "s1", directory: "/work/legacy", time: { created: time, updated: time + 1000 } }));
    await writeFile(join(messageDirectory, "u1.json"), JSON.stringify({ id: "u1", sessionID: "s1", role: "user", time: { created: time }, model: { providerID: "test", modelID: "legacy" } }));
    await writeFile(join(messageDirectory, "a1.json"), JSON.stringify({ id: "a1", sessionID: "s1", role: "assistant", parentID: "u1", time: { created: time + 1000 }, providerID: "test", modelID: "legacy", tokens: { input: 2, output: 1 } }));
    await writeFile(join(userParts, "p1.json"), JSON.stringify({ id: "p1", messageID: "u1", sessionID: "s1", type: "text", text: "检查旧格式缓存", time: { created: time } }));
    await writeFile(join(assistantParts, "p2.json"), JSON.stringify({ id: "p2", messageID: "a1", sessionID: "s1", type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: { command: "npm test" } }, time: { created: time + 1000 } }));

    const progress: string[] = [];
    const cold = await readOpenCodeFacts([root], scope, (message) => progress.push(message));
    const warm = await readOpenCodeFacts([root], scope, (message) => progress.push(message));
    expect(cold.prompts[0]).toMatchObject({ text: "检查旧格式缓存", modelId: "test/legacy" });
    expect(cold.tools[0]).toMatchObject({ name: "shell.run", exitCode: 0 });
    expect(warm).toEqual(cold);
    expect(progress.some((message) => message.includes("OpenCode legacy cache: reused 1/1"))).toBe(true);
  });
});
