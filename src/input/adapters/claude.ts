import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { emptyFacts, mergeFactSets } from "../../domain/facts.js";
import { commandFamily, isCheckCommand, normalizeTool } from "../../domain/tools.js";
import { periodEpochBounds } from "../../domain/time.js";
import type { FactSet, FileChangeFact, Scope, ToolFact } from "../../domain/types.js";
import { hash, languageForPath, stableId } from "../../domain/utils.js";
import { factCacheKey, readFactCache, writeFactCache } from "../../storage/fact-cache.js";
import { mapConcurrent } from "../concurrency.js";
import { parseJsonlWithWorkers, type JsonlWorkerTask } from "../workers/fact-worker-pool.js";

async function walk(directory: string, output: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith("agent-")) output.push(path);
  }));
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item && typeof item === "object" && (item as any).type === "text").map((item) => String((item as any).text ?? "")).join("\n");
}

function isSynthetic(event: any, text: string): boolean {
  const value = text.trim();
  return event.isMeta === true || !value || /<(?:local-command-caveat|command-name|local-command-stdout|system-reminder)>/.test(value);
}

function changedLines(oldValue: unknown, newValue: unknown): { added: number; deleted: number } {
  const oldLines = typeof oldValue === "string" ? oldValue.split("\n").length : 0;
  const newLines = typeof newValue === "string" ? newValue.split("\n").length : 0;
  return { added: newLines, deleted: oldLines };
}

function fileChange(tool: ToolFact, rawName: string, input: any): FileChangeFact | undefined {
  if (!/^(edit|multiedit)$/i.test(rawName) || !input || typeof input !== "object") return undefined;
  const path = String(input.file_path ?? input.filePath ?? "");
  if (!path) return undefined;
  const counts = changedLines(input.old_string ?? input.oldString, input.new_string ?? input.newString);
  return { id: stableId("change", `${tool.id}:${path}`), callId: tool.callId, sessionId: tool.sessionId, turnId: tool.turnId, occurredAt: tool.occurredAt, path, ...counts, language: languageForPath(path), modelId: tool.modelId };
}

export async function parseClaudeFile(file: string, root: string, sourceId: string, scope: Scope, knownFileSize?: number): Promise<FactSet> {
  const facts = emptyFacts();
  facts.sources.push({ id: sourceId, agentType: "claude-code", root });
  const seen = { sessions: new Set<string>(), turns: new Set<string>(), prompts: new Set<string>(), tokens: new Set<string>(), tools: new Set<string>(), changes: new Set<string>() };
  facts.scannedFiles = 1;
  facts.scannedBytes = knownFileSize ?? (await stat(file)).size;
  let rawSessionId = basename(file, ".jsonl");
  let sessionId = stableId("session", `claude-code:${rawSessionId}`);
  let cwd: string | undefined;
  let currentTurn: string | undefined;
  let currentModel: string | undefined;
  let lineNumber = 0;
  const periodBounds = periodEpochBounds(scope.period, scope.timezone, scope.dayStartHour);
  const tools = new Map<string, ToolFact>();
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json", line: lineNumber }); continue; }
        const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
        if (!timestamp) continue;
        const timestampMs = Date.parse(timestamp);
        if (Number.isNaN(timestampMs)) continue;
        rawSessionId = String(event.sessionId ?? rawSessionId);
        sessionId = stableId("session", `claude-code:${rawSessionId}`);
        cwd = typeof event.cwd === "string" ? event.cwd : cwd;
        const inside = timestampMs >= periodBounds.startInclusive && timestampMs < periodBounds.endExclusive;
        if (inside && !seen.sessions.has(sessionId)) {
          seen.sessions.add(sessionId);
          facts.sessions.push({ id: sessionId, occurredAt: timestamp, cwd, sourceId });
        }
        const message = event.message;
        if (!message || typeof message !== "object") continue;
        if (event.type === "user" && message.role === "user") {
          const blocks = Array.isArray(message.content) ? message.content : [];
          for (const block of blocks) {
            if (block?.type !== "tool_result") continue;
            const tool = tools.get(String(block.tool_use_id ?? ""));
            if (tool && (block.is_error === true || event.is_error === true)) tool.exitCode = 1;
            else if (tool) tool.exitCode = 0;
          }
          const text = textContent(message.content).trim();
          if (!inside || isSynthetic(event, text) || blocks.some((item: any) => item?.type === "tool_result")) continue;
          currentTurn = stableId("turn", `${sessionId}:${event.uuid ?? timestamp}`);
          const id = stableId("prompt", `${sessionId}:${event.uuid ?? timestamp}:${hash(text)}`);
          if (!seen.prompts.has(id)) {
            seen.prompts.add(id);
            facts.prompts.push({ id, sessionId, turnId: currentTurn, occurredAt: timestamp, cwd, text });
          }
          continue;
        }
        if (event.type !== "assistant" || message.role !== "assistant" || !inside) continue;
        currentModel = typeof message.model === "string" ? message.model : currentModel ?? "unknown";
        currentTurn ??= stableId("turn", `${sessionId}:${event.parentUuid ?? event.uuid ?? timestamp}`);
        const model = currentModel ?? "unknown";
        const turnId = currentTurn ?? stableId("turn", `${sessionId}:${timestamp}`);
        if (!seen.turns.has(turnId)) {
          seen.turns.add(turnId);
          facts.turns.push({ id: turnId, sessionId, occurredAt: timestamp, cwd, modelId: model });
          const prompt = [...facts.prompts].reverse().find((item) => item.sessionId === sessionId && item.turnId === turnId);
          if (prompt) prompt.modelId = model;
        }
        const usage = message.usage;
        if (usage && typeof usage === "object") {
          const tokenId = stableId("token", `${sessionId}:${message.id ?? event.uuid ?? timestamp}`);
          if (!seen.tokens.has(tokenId)) {
            const input = Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
            const cachedInput = Number(usage.cache_read_input_tokens ?? 0);
            const output = Number(usage.output_tokens ?? 0);
            seen.tokens.add(tokenId);
            facts.tokens.push({ id: tokenId, sessionId, turnId, occurredAt: timestamp, modelId: model, input, cachedInput, output, reasoning: 0, total: input + cachedInput + output });
          }
        }
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type !== "tool_use") continue;
          const callId = String(block.id ?? stableId("call", `${sessionId}:${timestamp}:${facts.tools.length}`));
          const id = stableId("tool", `${sessionId}:${callId}`);
          if (seen.tools.has(id)) continue;
          const rawName = String(block.name ?? "unknown");
          const normalized = normalizeTool(rawName);
          const input = block.input && typeof block.input === "object" ? block.input : {};
          const command = String(input.command ?? input.cmd ?? "");
          const tool: ToolFact = { id, callId, sessionId, turnId, occurredAt: timestamp, name: normalized.name, rawName, category: normalized.category, cwd, modelId: model, commandFamily: commandFamily(command), isMutation: normalized.isMutation, isCheckInvocation: isCheckCommand(command) };
          seen.tools.add(id); facts.tools.push(tool); tools.set(callId, tool);
          const change = fileChange(tool, rawName, input);
          if (change && !seen.changes.has(change.id)) { seen.changes.add(change.id); facts.fileChanges.push(change); }
        }
  }
  return facts;
}

export async function readClaudeFacts(roots: string[], scope: Scope, onProgress?: (message: string) => void, options: { bypassCache?: boolean } = {}): Promise<FactSet> {
  const fragments: FactSet[] = [];
  let cacheHits = 0;
  for (const inputRoot of roots) {
    const root = resolve(inputRoot);
    const sourceId = stableId("source", root);
    const source = emptyFacts();
    source.sources.push({ id: sourceId, agentType: "claude-code", root });
    fragments.push(source);
    const files: string[] = [];
    await walk(join(root, "projects"), files);
    files.sort();
    onProgress?.(`Scanning ${files.length} Claude Code session files from ${root}`);
    const candidates = await mapConcurrent(files, 16, async (file) => {
      const info = await stat(file);
      const cacheKey = factCacheKey("claude-code", 1, scope, file, [{ path: file, size: info.size, mtimeMs: info.mtimeMs }]);
      const cached = options.bypassCache ? undefined : await readFactCache(cacheKey);
      return { file, fileSize: info.size, cacheKey, cached };
    });
    const reused = candidates.filter((candidate) => candidate.cached);
    const misses = candidates.filter((candidate) => !candidate.cached);
    cacheHits += reused.length;
    fragments.push(...reused.map((candidate) => candidate.cached!));
    if (reused.length) onProgress?.(`Claude Code cache: reused ${reused.length}/${files.length} session files from ${root}`);
    if (!misses.length) continue;

    const tasks: JsonlWorkerTask[] = misses.map(({ file, fileSize }) => ({ file, fileSize, root, sourceId, scope }));
    onProgress?.(`Parsing ${misses.length} Claude Code session files with up to ${Math.min(tasks.length, 4)} workers`);
    const parsed = await parseJsonlWithWorkers("claude-code", tasks, (completed, total) => {
      if (completed % 25 === 0 || completed === total) onProgress?.(`Parsed ${completed}/${total} uncached Claude Code files from ${root}`);
    });
    await mapConcurrent(misses, 16, async (candidate, index) => {
      await writeFactCache(candidate.cacheKey, parsed.facts[index]);
    });
    fragments.push(...parsed.facts);
  }
  if (cacheHits && roots.length > 1) onProgress?.(`Claude Code cache total: ${cacheHits} session files reused`);
  return mergeFactSets(fragments);
}
