import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { emptyFacts, mergeFactSets } from "../../domain/facts.js";
import { commandFamily, isCheckCommand, normalizeTool, parseExitCode } from "../../domain/tools.js";
import { periodEpochBounds } from "../../domain/time.js";
import type { FactSet, FileChangeFact, Scope, ToolFact } from "../../domain/types.js";
import { hash, languageForPath, stableId } from "../../domain/utils.js";
import { factCacheKey, readFactCache, writeFactCache } from "../../storage/fact-cache.js";
import { mapConcurrent } from "../concurrency.js";

type DshEvent = { type?: string; seq?: number; time?: number; data?: Record<string, any> };
type DshFile = { file: string; size: number; mtimeMs: number };

function zstdInput(file: string): Readable {
  const child = spawn("zstd", ["-dc", file], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2048); });
  child.once("error", (error) => child.stdout?.destroy(new Error(`Unable to decode DSH session ${basename(file)}: ${error.message}`)));
  child.once("close", (code) => {
    if (code !== 0) child.stdout?.destroy(new Error(`Unable to decode DSH session ${basename(file)} with zstd: ${stderr.trim() || `exit ${code}`}`));
  });
  if (!child.stdout) throw new Error("Unable to start zstd decoder");
  return child.stdout;
}

async function sessionFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (names.has("session.v3.jsonl.zstd")) output.push(join(directory, "session.v3.jsonl.zstd"));
    else if (names.has("session.jsonl.zstd")) output.push(join(directory, "session.jsonl.zstd"));
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => walk(join(directory, entry.name))));
  }
  await walk(join(root, "sessions"));
  return output.sort();
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text as string).join("\n").trim();
}

function parseArguments(value: unknown): Record<string, any> {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  } catch { return {}; }
}

function extractChange(tool: ToolFact, rawName: string, args: Record<string, any>): FileChangeFact | undefined {
  const path = String(args.path ?? args.filePath ?? args.file_path ?? "");
  if (!path) return undefined;
  let added = 0, deleted = 0;
  if (typeof args.old_string === "string" || typeof args.oldText === "string") deleted = String(args.old_string ?? args.oldText).split("\n").length;
  if (typeof args.new_string === "string" || typeof args.newText === "string") added = String(args.new_string ?? args.newText).split("\n").length;
  if (!added && !deleted && typeof args.content === "string" && ["write", "file.write"].includes(rawName.toLowerCase())) added = args.content.split("\n").length;
  if (!added && !deleted && !["edit", "write", "apply_patch", "patch"].includes(rawName.toLowerCase())) return undefined;
  return { id: stableId("change", `${tool.id}:${path}`), callId: tool.callId, sessionId: tool.sessionId, turnId: tool.turnId, occurredAt: tool.occurredAt, path, added, deleted, language: languageForPath(path), modelId: tool.modelId };
}

export async function parseDshFile(file: string, root: string, sourceId: string, scope: Scope, knownFileSize?: number): Promise<FactSet> {
  const facts = emptyFacts();
  const info = knownFileSize === undefined ? await stat(file) : undefined;
  facts.scannedFiles = 1;
  facts.scannedBytes = knownFileSize ?? info!.size;
  const bounds = periodEpochBounds(scope.period, scope.timezone, scope.dayStartHour);
  const turns = new Set<string>(), prompts = new Set<string>(), tokenEvents = new Set<string>(), toolEvents = new Set<string>(), changes = new Set<string>();
  const tools = new Map<string, ToolFact>();
  let rawSessionId = basename(dirname(file));
  let sessionId = stableId("session", `dsh:${rawSessionId}`);
  let cwd: string | undefined;
  let currentTurn: string | undefined;
  let currentModel = "unknown";
  let sessionSeen = false;
  let lineNumber = 0;
  const reader = createInterface({ input: zstdInput(file), crlfDelay: Infinity });

  const ensureSession = (occurredAt: string) => {
    if (sessionSeen) return;
    sessionSeen = true;
    facts.sessions.push({ id: sessionId, occurredAt, cwd, sourceId });
  };
  const ensureTurn = (turn: string, occurredAt: string) => {
    currentTurn = stableId("turn", `${sessionId}:${turn}`);
    if (turns.has(currentTurn)) return;
    turns.add(currentTurn);
    facts.turns.push({ id: currentTurn, sessionId, occurredAt, cwd, modelId: currentModel });
  };

  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event: DshEvent & Record<string, any>;
    try { event = JSON.parse(line); } catch { facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json", line: lineNumber }); continue; }

    if (event.type === "session") {
      rawSessionId = String(event.id ?? rawSessionId);
      sessionId = stableId("session", `dsh:${rawSessionId}`);
      cwd = typeof event.cwd === "string" ? event.cwd : cwd;
      const createdAt = typeof event.createdAt === "number" ? new Date(event.createdAt).toISOString() : undefined;
      if (createdAt && event.createdAt >= bounds.startInclusive && event.createdAt < bounds.endExclusive) ensureSession(createdAt);
      continue;
    }

    const timestamp = typeof event.time === "number" ? event.time : NaN;
    if (!Number.isFinite(timestamp)) continue;
    const inside = timestamp >= bounds.startInclusive && timestamp < bounds.endExclusive;
    const occurredAt = new Date(timestamp).toISOString();
    const data = event.data ?? {};

    if (event.type === "model/selection") {
      const model = String(data.model ?? "unknown");
      currentModel = data.provider ? `${data.provider}/${model}` : model;
      continue;
    }
    if (event.type === "turn/start") {
      const turn = String(data.turn ?? event.seq ?? timestamp);
      if (inside) {
        ensureSession(occurredAt);
        ensureTurn(turn, occurredAt);
      } else currentTurn = stableId("turn", `${sessionId}:${turn}`);
      continue;
    }
    if (event.type === "user/message") {
      if (!inside || data.role !== "user" || data.source?.kind !== "user") continue;
      const text = contentText(data.content);
      if (!text) continue;
      ensureSession(occurredAt);
      if (data.turn !== undefined) ensureTurn(String(data.turn), occurredAt);
      const id = stableId("prompt", `${sessionId}:${data.id ?? event.seq ?? timestamp}:${hash(text)}`);
      if (prompts.has(id)) continue;
      prompts.add(id);
      facts.prompts.push({ id, sessionId, turnId: currentTurn, occurredAt, cwd, text, modelId: currentModel });
      continue;
    }
    if (event.type === "assistant/message") {
      const message = data.message ?? {};
      if (!inside || message.role !== "assistant") continue;
      ensureSession(occurredAt);
      if (typeof data.turn === "number" || typeof data.turn === "string") ensureTurn(String(data.turn), occurredAt);
      const model = String(message.model ?? currentModel);
      if (model !== "unknown") currentModel = model;
      if (currentTurn && !turns.has(currentTurn)) ensureTurn(String(data.turn ?? currentTurn), occurredAt);
      const usage = data.usage;
      if (usage && typeof usage === "object") {
        const id = stableId("token", `${sessionId}:${event.seq ?? timestamp}:${data.turn ?? ""}:${data.step ?? ""}`);
        if (!tokenEvents.has(id)) {
          tokenEvents.add(id);
          const input = Number(usage.inputTokens ?? 0), cachedInput = Number(usage.cacheReadTokens ?? 0), output = Number(usage.outputTokens ?? 0), reasoning = Number(usage.reasoningTokens ?? 0);
          facts.tokens.push({ id, sessionId, turnId: currentTurn, occurredAt, modelId: currentModel, input, cachedInput, output, reasoning, total: Number(usage.totalTokens ?? input + cachedInput + output + reasoning) });
        }
      }
      continue;
    }
    if (event.type === "tool/call") {
      if (!inside) continue;
      ensureSession(occurredAt);
      const callId = String(data.callId ?? `seq-${event.seq ?? timestamp}`);
      const id = stableId("tool", `${sessionId}:${callId}`);
      if (toolEvents.has(id)) continue;
      toolEvents.add(id);
      const rawName = String(data.name ?? "unknown");
      const normalized = normalizeTool(rawName);
      const args = parseArguments(data.arguments);
      const command = String(args.command ?? args.cmd ?? "");
      const tool: ToolFact = { id, callId, sessionId, turnId: currentTurn, occurredAt, name: normalized.name, rawName, category: normalized.category, cwd, modelId: currentModel, commandFamily: commandFamily(command), isMutation: normalized.isMutation, isCheckInvocation: isCheckCommand(command) };
      tools.set(callId, tool);
      facts.tools.push(tool);
      const change = extractChange(tool, rawName, args);
      if (change && !changes.has(change.id)) { changes.add(change.id); facts.fileChanges.push(change); }
      continue;
    }
    if (event.type === "tool/result") {
      const callId = String(data.message?.source?.callId ?? "");
      const tool = tools.get(callId);
      if (tool) {
        const text = contentText(data.message?.content?.flatMap((item: any) => item.content ?? []));
        tool.exitCode = parseExitCode(text);
      }
    }
  }

  facts.sources.push({ id: sourceId, agentType: "dsh", root });
  return facts;
}

export async function readDshFacts(roots: string[], scope: Scope, onProgress?: (message: string) => void, options: { bypassCache?: boolean } = {}): Promise<FactSet> {
  const fragments: FactSet[] = [];
  for (const inputRoot of roots) {
    const root = resolve(inputRoot), sourceId = stableId("source", root);
    const source = emptyFacts();
    source.sources.push({ id: sourceId, agentType: "dsh", root });
    fragments.push(source);
    const files = await sessionFiles(root);
    onProgress?.(`Scanning ${files.length} DSH session files from ${root}`);
    const candidates = await mapConcurrent(files, 16, async (file): Promise<DshFile & { cacheKey: string; cached?: FactSet }> => {
      const info = await stat(file);
      const cacheKey = factCacheKey("dsh", 1, scope, file, [{ path: file, size: info.size, mtimeMs: info.mtimeMs }]);
      return { file, size: info.size, mtimeMs: info.mtimeMs, cacheKey, cached: options.bypassCache ? undefined : await readFactCache(cacheKey) };
    });
    const hits = candidates.filter((item) => item.cached);
    fragments.push(...hits.map((item) => item.cached!));
    const misses = candidates.filter((item) => !item.cached);
    if (hits.length) onProgress?.(`DSH cache: reused ${hits.length}/${files.length} session files from ${root}`);
    if (!misses.length) continue;
    const parsed = await mapConcurrent(misses, 4, (item) => parseDshFile(item.file, root, sourceId, scope, item.size));
    await mapConcurrent(misses, 16, (item, index) => writeFactCache(item.cacheKey, parsed[index]));
    fragments.push(...parsed);
    onProgress?.(`Parsed ${parsed.length}/${misses.length} uncached DSH files from ${root}`);
  }
  return mergeFactSets(fragments);
}
