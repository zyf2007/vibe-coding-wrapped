import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FactSet, FileChangeFact, PromptFact, Scope, ToolFact } from "./types.js";
import { codingDay, inPeriod } from "./time.js";
import { hash, languageForPath, stableId } from "./utils.js";

type RawEvent = { timestamp?: string; type?: string; payload?: Record<string, any> };

function candidateMonthKeys(scope: Scope): Set<string> {
  const start = new Date(`${scope.period.startCodingDay}T00:00:00Z`);
  const end = new Date(`${scope.period.endCodingDay}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const keys = new Set<string>();
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor <= end) {
    keys.add(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

async function walkJsonl(directory: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
  }));
}

async function discoverFiles(root: string, scope: Scope): Promise<string[]> {
  const files: string[] = [];
  await walkJsonl(join(root, "sessions"), files);
  const months = candidateMonthKeys(scope);
  return files
    .filter((file) => {
      const match = basename(file).match(/rollout-(\d{4}-\d{2})-/);
      return !match || months.has(match[1]);
    })
    .sort();
}

function metadataTurnId(payload: Record<string, any>): string | undefined {
  return payload.turn_id ?? payload.internal_chat_message_metadata_passthrough?.turn_id;
}

function isSyntheticPrompt(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed
    || /^<(environment_context|permissions instructions|collaboration_mode|skills_instructions)>/.test(trimmed)
    || /^# AGENTS\.md instructions/.test(trimmed)
    || /^Another language model started to solve this problem/.test(trimmed);
}

function normalizePrompt(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
    .trim();
}

function parseToolInput(payload: Record<string, any>): { raw: string; parsed?: Record<string, any> } {
  const value = payload.input ?? payload.arguments ?? "";
  if (typeof value === "object" && value) return { raw: JSON.stringify(value), parsed: value };
  const raw = String(value);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? { raw, parsed } : { raw };
  } catch {
    return { raw };
  }
}

function toolCategory(name: string, input: string): string {
  const value = name.toLowerCase();
  if (/spawn_agent|send_message|followup_task/.test(value)) return "subagent";
  if (/wait_agent|wait|write_stdin/.test(value)) return "wait";
  if (/apply_patch|write|edit/.test(value)) return "patch";
  if (/view_image|image/.test(value)) return "media";
  if (/search|rg|grep|find|list/.test(value)) return "search";
  if (/read|cat|sed|head|tail/.test(value)) return "read";
  if (/exec|shell|command/.test(value)) {
    if (isCheckCommand(input)) return "shell-check";
    return "shell";
  }
  if (/plan|goal/.test(value)) return "coordination";
  return "other";
}

function isCheckCommand(value: string): boolean {
  return /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)|(?:cargo|go)\s+test|pytest|vitest|jest|tsc(?:\s|$)|gradle\w*\s+(?:test|check|build)|mvn\s+(?:test|verify)|dotnet\s+(?:test|build)|swift\s+test/i.test(value);
}

function commandFamily(value: string): string | undefined {
  const match = value.trim().match(/^(?:\{[\s\S]*?cmd["']?\s*:\s*["'])?([\w./-]+)/);
  return match?.[1] ? basename(match[1]) : undefined;
}

function extractFileChanges(tool: ToolFact, input: string): FileChangeFact[] {
  if (tool.name !== "apply_patch" && !/apply_patch/i.test(tool.name)) return [];
  const result: FileChangeFact[] = [];
  const lines = input.split("\n");
  let current: { path: string; added: number; deleted: number } | undefined;
  const flush = () => {
    if (!current) return;
    result.push({
      id: stableId("change", `${tool.id}:${current.path}`),
      callId: tool.callId,
      sessionId: tool.sessionId,
      turnId: tool.turnId,
      occurredAt: tool.occurredAt,
      path: current.path,
      added: current.added,
      deleted: current.deleted,
      language: languageForPath(current.path),
    });
  };
  for (const line of lines) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (header) {
      flush();
      current = { path: header[1].trim(), added: 0, deleted: 0 };
      continue;
    }
    if (!current || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.deleted += 1;
  }
  flush();
  return result;
}

function parseExitCode(output: unknown): number | undefined {
  if (output && typeof output === "object") {
    const direct = (output as Record<string, unknown>).exit_code;
    if (typeof direct === "number") return direct;
  }
  const serialized = String(typeof output === "string" ? output : JSON.stringify(output ?? ""));
  const match = serialized.match(/["']?exit_code["']?\s*[:=]\s*(-?\d+)/) ?? serialized.match(/Process exited with code\s+(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export async function readCodexFacts(roots: string[], scope: Scope, onProgress?: (message: string) => void): Promise<FactSet> {
  const discovered = new Map<string, string[]>();
  const fingerprints: string[] = [];
  for (const inputRoot of roots) {
    const root = resolve(inputRoot);
    const files = await discoverFiles(root, scope);
    discovered.set(root, files);
    for (const file of files) {
      const info = await stat(file);
      fingerprints.push(`${file}\0${info.size}\0${info.mtimeMs}`);
    }
  }
  const cacheBase = process.env.XDG_CACHE_HOME ? resolve(process.env.XDG_CACHE_HOME) : join(homedir(), ".cache");
  const cacheDirectory = join(cacheBase, "vibe-coding-wrapped");
  const cacheKey = hash(JSON.stringify({ version: 1, roots: roots.map((root) => resolve(root)).sort(), period: scope.period, timezone: scope.timezone, dayStartHour: scope.dayStartHour, fingerprints: fingerprints.sort() }));
  const cacheFile = join(cacheDirectory, `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as FactSet;
    if (cached && Array.isArray(cached.prompts) && Array.isArray(cached.tools)) {
      onProgress?.(`Fact cache hit: ${cacheKey.slice(0, 12)}`);
      return cached;
    }
  } catch {
    // A missing or stale cache is a normal first-run condition.
  }

  const facts: FactSet = { sessions: [], turns: [], prompts: [], tokens: [], tools: [], fileChanges: [], diagnostics: [], scannedFiles: 0, scannedBytes: 0, sourceIds: [] };
  const seen = { sessions: new Set<string>(), turns: new Set<string>(), prompts: new Set<string>(), tokens: new Set<string>(), tools: new Set<string>(), changes: new Set<string>() };
  const toolByCallId = new Map<string, ToolFact>();
  const turnModels = new Map<string, { modelId: string; effort?: string; cwd?: string }>();

  for (const inputRoot of roots) {
    const root = resolve(inputRoot);
    const sourceId = stableId("source", root);
    facts.sourceIds.push(sourceId);
    const files = discovered.get(root) ?? [];
    onProgress?.(`Scanning ${files.length} candidate files from ${root}`);
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      const info = await stat(file);
      facts.scannedFiles += 1;
      facts.scannedBytes += info.size;
      let sessionId = stableId("session", `${sourceId}:${file}`);
      let sessionCwd: string | undefined;
      let currentTurn: string | undefined;
      let currentModel: string | undefined;
      let pendingPrompt: PromptFact | undefined;
      let previousTotal = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
      let lineNumber = 0;
      const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of reader) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let event: RawEvent;
        try {
          event = JSON.parse(line) as RawEvent;
        } catch {
          facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json", line: lineNumber });
          continue;
        }
        const timestamp = event.timestamp;
        if (!timestamp || Number.isNaN(Date.parse(timestamp))) continue;
        const payload = event.payload ?? {};

        if (event.type === "session_meta") {
          sessionId = String(payload.id ?? payload.session_id ?? sessionId);
          sessionCwd = typeof payload.cwd === "string" ? payload.cwd : sessionCwd;
          const id = stableId("session", sessionId);
          const sessionDay = codingDay(timestamp, scope.timezone, scope.dayStartHour);
          if (inPeriod(sessionDay, scope.period) && !seen.sessions.has(id)) {
            seen.sessions.add(id);
            facts.sessions.push({ id, occurredAt: timestamp, cwd: sessionCwd, sourceId });
          }
          continue;
        }

        if (event.type === "turn_context") {
          currentTurn = String(payload.turn_id ?? stableId("turn", `${sessionId}:${timestamp}`));
          currentModel = String(payload.model ?? "unknown");
          sessionCwd = typeof payload.cwd === "string" ? payload.cwd : sessionCwd;
          const effort = typeof payload.effort === "string" ? payload.effort : payload.collaboration_mode?.settings?.reasoning_effort;
          turnModels.set(currentTurn, { modelId: currentModel, effort, cwd: sessionCwd });
          if (pendingPrompt && !pendingPrompt.turnId) pendingPrompt.turnId = currentTurn;
          const id = stableId("turn", `${sessionId}:${currentTurn}`);
          const turnDay = codingDay(timestamp, scope.timezone, scope.dayStartHour);
          if (inPeriod(turnDay, scope.period) && !seen.turns.has(id)) {
            seen.turns.add(id);
            facts.turns.push({ id, sessionId, occurredAt: timestamp, cwd: sessionCwd, modelId: currentModel, effort });
          }
          continue;
        }

        if (event.type === "event_msg" && payload.type === "task_started") {
          currentTurn = String(payload.turn_id ?? currentTurn ?? "");
          if (pendingPrompt && currentTurn) pendingPrompt.turnId = currentTurn;
          continue;
        }

        const day = codingDay(timestamp, scope.timezone, scope.dayStartHour);
        if (!inPeriod(day, scope.period)) continue;

        if (event.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
          const text = normalizePrompt(payload.message);
          if (isSyntheticPrompt(text)) continue;
          const id = stableId("prompt", `${sessionId}:${timestamp}:${hash(text)}`);
          if (!seen.prompts.has(id)) {
            seen.prompts.add(id);
            pendingPrompt = { id, sessionId, turnId: undefined, occurredAt: timestamp, cwd: sessionCwd, text };
            facts.prompts.push(pendingPrompt);
          }
          continue;
        }

        if (event.type === "event_msg" && payload.type === "token_count" && payload.info?.total_token_usage) {
          const total = payload.info.total_token_usage;
          const last = payload.info.last_token_usage;
          const current = {
            input: Number(total.input_tokens ?? 0), cached: Number(total.cached_input_tokens ?? 0),
            output: Number(total.output_tokens ?? 0), reasoning: Number(total.reasoning_output_tokens ?? 0), total: Number(total.total_tokens ?? 0),
          };
          const unchanged = current.input === previousTotal.input && current.cached === previousTotal.cached && current.output === previousTotal.output && current.reasoning === previousTotal.reasoning && current.total === previousTotal.total;
          if (unchanged) continue;
          const usage = last ? {
            input: Number(last.input_tokens ?? 0), cached: Number(last.cached_input_tokens ?? 0),
            output: Number(last.output_tokens ?? 0), reasoning: Number(last.reasoning_output_tokens ?? 0), total: Number(last.total_tokens ?? 0),
          } : {
            input: Math.max(0, current.input - previousTotal.input), cached: Math.max(0, current.cached - previousTotal.cached),
            output: Math.max(0, current.output - previousTotal.output), reasoning: Math.max(0, current.reasoning - previousTotal.reasoning), total: Math.max(0, current.total - previousTotal.total),
          };
          previousTotal = current;
          const turnId = metadataTurnId(payload) ?? currentTurn;
          const id = stableId("token", `${sessionId}:${turnId ?? ""}:${timestamp}:${usage.total}`);
          if (!seen.tokens.has(id) && usage.total > 0) {
            seen.tokens.add(id);
            facts.tokens.push({ id, sessionId, turnId, occurredAt: timestamp, modelId: currentModel, input: usage.input, cachedInput: usage.cached, output: usage.output, reasoning: usage.reasoning, total: usage.total });
          }
          continue;
        }

        if (event.type === "response_item" && ["custom_tool_call", "function_call"].includes(String(payload.type))) {
          const callId = String(payload.call_id ?? payload.id ?? stableId("call", `${sessionId}:${timestamp}:${facts.tools.length}`));
          const name = String(payload.name ?? "unknown");
          const input = parseToolInput(payload);
          const turnId = metadataTurnId(payload) ?? currentTurn;
          const id = stableId("tool", `${sessionId}:${callId}`);
          if (seen.tools.has(id)) continue;
          seen.tools.add(id);
          const tool: ToolFact = {
            id, callId, sessionId, turnId, occurredAt: timestamp, name,
            category: toolCategory(name, input.raw), cwd: sessionCwd, modelId: currentModel,
            commandFamily: commandFamily(input.parsed?.cmd ?? input.raw),
            isMutation: /apply_patch|write|edit/i.test(name),
            isCheckInvocation: isCheckCommand(String(input.parsed?.cmd ?? input.raw)),
          };
          facts.tools.push(tool);
          toolByCallId.set(callId, tool);
          for (const change of extractFileChanges(tool, input.raw)) {
            if (!seen.changes.has(change.id)) {
              seen.changes.add(change.id);
              facts.fileChanges.push(change);
            }
          }
          continue;
        }

        if (event.type === "response_item" && ["custom_tool_call_output", "function_call_output"].includes(String(payload.type))) {
          const callId = String(payload.call_id ?? "");
          const tool = toolByCallId.get(callId);
          if (tool) tool.exitCode = parseExitCode(payload.output);
        }
      }
      if ((fileIndex + 1) % 25 === 0) onProgress?.(`Parsed ${fileIndex + 1}/${files.length} files from ${root}`);
    }
  }

  for (const prompt of facts.prompts) {
    const turn = prompt.turnId ? turnModels.get(prompt.turnId) : undefined;
    prompt.modelId = turn?.modelId;
    prompt.cwd ??= turn?.cwd;
  }
  for (const token of facts.tokens) token.modelId = (token.turnId ? turnModels.get(token.turnId)?.modelId : undefined) ?? token.modelId;
  for (const tool of facts.tools) tool.modelId = (tool.turnId ? turnModels.get(tool.turnId)?.modelId : undefined) ?? tool.modelId;
  for (const change of facts.fileChanges) {
    const tool = toolByCallId.get(change.callId);
    change.modelId = tool?.modelId;
  }

  facts.sourceIds = [...new Set(facts.sourceIds)].sort();
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await writeFile(cacheFile, JSON.stringify(facts), { encoding: "utf8", mode: 0o600 });
  await chmod(cacheFile, 0o600);
  return facts;
}
