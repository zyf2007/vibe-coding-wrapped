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

async function walkJsonl(directory: string, output: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
  }));
}

async function sessionDirectory(root: string): Promise<string> {
  try { if ((await stat(join(root, "sessions"))).isDirectory()) return join(root, "sessions"); } catch {}
  return root;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("\n");
}

function lineCount(value: unknown): number {
  return typeof value === "string" && value.length ? value.split("\n").length : 0;
}

function fileChanges(tool: ToolFact, rawName: string, input: Record<string, any>): FileChangeFact[] {
  const path = String(input.path ?? input.filePath ?? input.file_path ?? "");
  if (!path || !["edit", "write"].includes(rawName.toLowerCase())) return [];
  let added = 0;
  let deleted = 0;
  if (rawName.toLowerCase() === "edit" && Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      added += lineCount(edit?.newText ?? edit?.new_string);
      deleted += lineCount(edit?.oldText ?? edit?.old_string);
    }
  } else if (rawName.toLowerCase() === "edit") {
    added = lineCount(input.newText ?? input.new_string);
    deleted = lineCount(input.oldText ?? input.old_string);
  } else {
    added = lineCount(input.content);
  }
  return [{ id: stableId("change", `${tool.id}:${path}`), callId: tool.callId, sessionId: tool.sessionId, turnId: tool.turnId, occurredAt: tool.occurredAt, path, added, deleted, language: languageForPath(path), modelId: tool.modelId }];
}

export async function parsePiFile(file: string, root: string, sourceId: string, scope: Scope, knownFileSize?: number): Promise<FactSet> {
  const facts = emptyFacts();
  facts.sources.push({ id: sourceId, agentType: "pi", root });
  facts.scannedFiles = 1;
  facts.scannedBytes = knownFileSize ?? (await stat(file)).size;
  const bounds = periodEpochBounds(scope.period, scope.timezone, scope.dayStartHour);
  let rawSessionId = basename(file, ".jsonl");
  let sessionId = stableId("session", `pi:${rawSessionId}`);
  let cwd: string | undefined;
  let currentTurn: string | undefined;
  let currentModel = "unknown";
  let effort: string | undefined;
  let lineNumber = 0;
  const seenSessions = new Set<string>();
  const seenTurns = new Set<string>();
  const tools = new Map<string, ToolFact>();
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json", line: lineNumber }); continue; }
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN;
    if (!timestamp || Number.isNaN(timestampMs)) continue;
    const inside = timestampMs >= bounds.startInclusive && timestampMs < bounds.endExclusive;

    if (event.type === "session") {
      rawSessionId = String(event.id ?? rawSessionId);
      sessionId = stableId("session", `pi:${rawSessionId}`);
      cwd = typeof event.cwd === "string" ? event.cwd : cwd;
      if (inside && !seenSessions.has(sessionId)) {
        seenSessions.add(sessionId);
        facts.sessions.push({ id: sessionId, occurredAt: timestamp, cwd, sourceId });
      }
      continue;
    }
    if (inside && !seenSessions.has(sessionId)) {
      seenSessions.add(sessionId);
      facts.sessions.push({ id: sessionId, occurredAt: timestamp, cwd, sourceId });
    }
    if (event.type === "model_change") {
      const model = String(event.modelId ?? "unknown");
      currentModel = event.provider ? `${event.provider}/${model}` : model;
      continue;
    }
    if (event.type === "thinking_level_change") {
      effort = typeof event.thinkingLevel === "string" ? event.thinkingLevel : effort;
      continue;
    }
    if (event.type !== "message" || !event.message || typeof event.message !== "object") continue;
    const message = event.message;
    if (message.role === "toolResult") {
      const tool = tools.get(String(message.toolCallId ?? ""));
      if (tool) tool.exitCode = message.isError === true ? 1 : 0;
      continue;
    }
    if (message.role === "user") {
      const text = textContent(message.content).trim();
      if (!inside || !text) continue;
      currentTurn = stableId("turn", `${sessionId}:${event.id ?? timestamp}`);
      facts.prompts.push({ id: stableId("prompt", `${sessionId}:${event.id ?? timestamp}:${hash(text)}`), sessionId, turnId: currentTurn, occurredAt: timestamp, cwd, text });
      continue;
    }
    if (message.role !== "assistant" || !inside) continue;
    const modelName = String(message.model ?? currentModel.split("/").at(-1) ?? "unknown");
    currentModel = message.provider ? `${message.provider}/${modelName}` : currentModel === "unknown" ? modelName : currentModel;
    currentTurn ??= stableId("turn", `${sessionId}:${event.parentId ?? event.id ?? timestamp}`);
    if (!seenTurns.has(currentTurn)) {
      seenTurns.add(currentTurn);
      facts.turns.push({ id: currentTurn, sessionId, occurredAt: timestamp, cwd, modelId: currentModel, effort });
      const prompt = [...facts.prompts].reverse().find((item) => item.turnId === currentTurn);
      if (prompt) prompt.modelId = currentModel;
    }
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      const input = Number(usage.input ?? 0);
      const cachedInput = Number(usage.cacheRead ?? 0);
      const cacheWrite = Number(usage.cacheWrite ?? 0);
      const output = Number(usage.output ?? 0);
      facts.tokens.push({ id: stableId("token", `${sessionId}:${event.id ?? timestamp}`), sessionId, turnId: currentTurn, occurredAt: timestamp, modelId: currentModel, input, cachedInput, cacheWrite, output, reasoning: 0, total: Number(usage.totalTokens ?? input + cachedInput + cacheWrite + output) });
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== "toolCall") continue;
      const callId = String(block.id ?? block.toolCallId ?? stableId("call", `${sessionId}:${event.id}:${facts.tools.length}`));
      const rawName = String(block.name ?? "unknown");
      const normalized = normalizeTool(rawName);
      const input = block.arguments && typeof block.arguments === "object" ? block.arguments : {};
      const command = String(input.command ?? input.cmd ?? "");
      const tool: ToolFact = { id: stableId("tool", `${sessionId}:${callId}`), callId, sessionId, turnId: currentTurn, occurredAt: timestamp, name: normalized.name, rawName, category: normalized.category, cwd, modelId: currentModel, commandFamily: commandFamily(command), isMutation: normalized.isMutation, isCheckInvocation: isCheckCommand(command) };
      facts.tools.push(tool);
      tools.set(callId, tool);
      facts.fileChanges.push(...fileChanges(tool, rawName, input));
    }
  }
  return facts;
}

export async function readPiFacts(roots: string[], scope: Scope, onProgress?: (message: string) => void, options: { bypassCache?: boolean } = {}): Promise<FactSet> {
  const fragments: FactSet[] = [];
  for (const inputRoot of roots) {
    const root = resolve(inputRoot);
    const sourceId = stableId("source", root);
    const source = emptyFacts();
    source.sources.push({ id: sourceId, agentType: "pi", root });
    fragments.push(source);
    const files: string[] = [];
    await walkJsonl(await sessionDirectory(root), files);
    files.sort();
    onProgress?.(`Scanning ${files.length} Pi session files from ${root}`);
    const candidates = await mapConcurrent(files, 16, async (file) => {
      const info = await stat(file);
      const cacheKey = factCacheKey("pi", 1, scope, file, [{ path: file, size: info.size, mtimeMs: info.mtimeMs }]);
      return { file, fileSize: info.size, cacheKey, cached: options.bypassCache ? undefined : await readFactCache(cacheKey) };
    });
    fragments.push(...candidates.filter((item) => item.cached).map((item) => item.cached!));
    const misses = candidates.filter((item) => !item.cached);
    if (candidates.length > misses.length) onProgress?.(`Pi cache: reused ${candidates.length - misses.length}/${candidates.length} session files from ${root}`);
    if (!misses.length) continue;
    onProgress?.(`Parsing ${misses.length} Pi session files with up to ${Math.min(misses.length, 4)} workers`);
    const tasks: JsonlWorkerTask[] = misses.map(({ file, fileSize }) => ({ file, fileSize, root, sourceId, scope }));
    const parsed = await parseJsonlWithWorkers("pi", tasks, (completed, total) => {
      if (completed % 25 === 0 || completed === total) onProgress?.(`Parsed ${completed}/${total} uncached Pi files from ${root}`);
    });
    await mapConcurrent(misses, 16, async (candidate, index) => writeFactCache(candidate.cacheKey, parsed.facts[index]));
    fragments.push(...parsed.facts);
  }
  return mergeFactSets(fragments);
}
