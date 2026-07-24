import Database from "better-sqlite3";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { emptyFacts, mergeFactSets } from "../../domain/facts.js";
import { commandFamily, isCheckCommand, normalizeTool, parseExitCode } from "../../domain/tools.js";
import { periodEpochBounds } from "../../domain/time.js";
import type { FactSet, FileChangeFact, Scope, ToolFact } from "../../domain/types.js";
import { hash, languageForPath, stableId } from "../../domain/utils.js";
import { factCacheKey, readFactCache, readJsonCache, writeFactCache, writeJsonCache, type FileFingerprint } from "../../storage/fact-cache.js";
import { mapConcurrent } from "../concurrency.js";

type RawMessage = { id: string; sessionId: string; timestamp: number; data: any; cwd?: string };
type RawPart = { id: string; messageId: string; sessionId: string; timestamp: number; data: any };

function instant(timestamp: number): string { return new Date(timestamp).toISOString(); }
function modelId(data: any): string | undefined {
  const provider = data.providerID ?? data.model?.providerID;
  const model = data.modelID ?? data.model?.modelID;
  return model ? (provider ? `${provider}/${model}` : String(model)) : undefined;
}
function eventTime(value: any, fallback: number): number {
  return Number(value?.time?.start ?? value?.time?.created ?? fallback);
}
function inScope(timestamp: number, range: { startInclusive: number; endExclusive: number }): boolean {
  return Number.isFinite(timestamp) && timestamp >= range.startInclusive && timestamp < range.endExclusive;
}
function bounds(scope: Scope): [number, number] {
  const range = periodEpochBounds(scope.period, scope.timezone, scope.dayStartHour);
  return [range.startInclusive - 86_400_000, range.endExclusive + 86_400_000];
}

function fileChange(tool: ToolFact, input: any, metadata: any): FileChangeFact | undefined {
  const diff = metadata?.filediff;
  const path = String(diff?.file ?? input?.filePath ?? input?.file_path ?? "");
  if (!path || (!diff && tool.name !== "file.edit")) return undefined;
  let added = Number(diff?.additions ?? 0);
  let deleted = Number(diff?.deletions ?? 0);
  if (!diff && typeof input?.oldString === "string" && typeof input?.newString === "string") {
    deleted = input.oldString.split("\n").length;
    added = input.newString.split("\n").length;
  }
  return { id: stableId("change", `${tool.id}:${path}`), callId: tool.callId, sessionId: tool.sessionId, turnId: tool.turnId, occurredAt: tool.occurredAt, path, added, deleted, language: languageForPath(path), modelId: tool.modelId };
}

function consume(sourceId: string, messages: RawMessage[], parts: RawPart[], scope: Scope, facts: FactSet): void {
  const range = periodEpochBounds(scope.period, scope.timezone, scope.dayStartHour);
  const partsByMessage = new Map<string, RawPart[]>();
  for (const part of parts) { const list = partsByMessage.get(part.messageId) ?? []; list.push(part); partsByMessage.set(part.messageId, list); }
  const seenSessions = new Set(facts.sessions.map((item) => item.id));
  const seenTurns = new Set(facts.turns.map((item) => item.id));
  const seenPrompts = new Set(facts.prompts.map((item) => item.id));
  const seenTokens = new Set(facts.tokens.map((item) => item.id));
  const seenTools = new Set(facts.tools.map((item) => item.id));
  const seenChanges = new Set(facts.fileChanges.map((item) => item.id));
  const turnByMessage = new Map<string, string>();
  const promptByTurn = new Map(facts.prompts.filter((item) => item.turnId).map((item) => [item.turnId!, item]));
  for (const message of messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
    const timestamp = eventTime(message.data, message.timestamp);
    if (!inScope(timestamp, range)) continue;
    const occurredAt = instant(timestamp);
    const sessionId = stableId("session", `opencode:${message.sessionId}`);
    if (!seenSessions.has(sessionId)) { seenSessions.add(sessionId); facts.sessions.push({ id: sessionId, occurredAt, cwd: message.cwd, sourceId }); }
    const role = String(message.data?.role ?? "");
    const messageParts = (partsByMessage.get(message.id) ?? []).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    if (role === "user") {
      const text = messageParts.filter((part) => part.data?.type === "text" && !part.data?.synthetic).map((part) => String(part.data.text ?? "")).join("\n").trim();
      if (!text) continue;
      const turnId = stableId("turn", `${sessionId}:${message.id}`);
      turnByMessage.set(message.id, turnId);
      const id = stableId("prompt", `${sessionId}:${message.id}:${hash(text)}`);
      if (!seenPrompts.has(id)) {
        const prompt = { id, sessionId, turnId, occurredAt, cwd: message.cwd, text, modelId: modelId(message.data) };
        seenPrompts.add(id); facts.prompts.push(prompt); promptByTurn.set(turnId, prompt);
      }
      continue;
    }
    if (role !== "assistant") continue;
    const turnId = turnByMessage.get(String(message.data?.parentID ?? "")) ?? stableId("turn", `${sessionId}:${message.data?.parentID ?? message.id}`);
    turnByMessage.set(message.id, turnId);
    const model = modelId(message.data) ?? "unknown";
    if (!seenTurns.has(turnId)) { seenTurns.add(turnId); facts.turns.push({ id: turnId, sessionId, occurredAt, cwd: message.cwd, modelId: model }); }
    const prompt = promptByTurn.get(turnId);
    if (prompt && !prompt.modelId) prompt.modelId = model;
    const tokens = message.data?.tokens;
    if (tokens) {
      const id = stableId("token", `${sessionId}:${message.id}`);
      if (!seenTokens.has(id)) {
        const input = Number(tokens.input ?? 0), cachedInput = Number(tokens.cache?.read ?? 0), cacheWrite = Number(tokens.cache?.write ?? 0), output = Number(tokens.output ?? 0), reasoning = Number(tokens.reasoning ?? 0);
        seenTokens.add(id); facts.tokens.push({ id, sessionId, turnId, occurredAt, modelId: model, input, cachedInput, cacheWrite, output, reasoning, total: input + cachedInput + cacheWrite + output + reasoning });
      }
    }
    for (const part of messageParts) {
      if (part.data?.type !== "tool") continue;
      const state = part.data.state ?? {};
      const rawName = String(part.data.tool ?? "unknown");
      const normalized = normalizeTool(rawName);
      const callId = String(part.data.callID ?? part.id);
      const id = stableId("tool", `${sessionId}:${callId}`);
      if (seenTools.has(id)) continue;
      const command = String(state.input?.command ?? state.input?.cmd ?? "");
      const toolAt = eventTime(state, part.timestamp || timestamp);
      const tool: ToolFact = { id, callId, sessionId, turnId, occurredAt: instant(toolAt), name: normalized.name, rawName, category: normalized.category, cwd: message.cwd, modelId: model, commandFamily: commandFamily(command), isMutation: normalized.isMutation, isCheckInvocation: isCheckCommand(command), exitCode: state.status === "error" ? 1 : parseExitCode(state.output) ?? (state.status === "completed" ? 0 : undefined) };
      seenTools.add(id); facts.tools.push(tool);
      const change = fileChange(tool, state.input, state.metadata);
      if (change && !seenChanges.has(change.id)) { seenChanges.add(change.id); facts.fileChanges.push(change); }
    }
  }
}

type SqliteSnapshot = { facts: FactSet; sessionIds: string[] };

function isSqliteSnapshot(value: unknown): value is SqliteSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SqliteSnapshot>;
  return Boolean(snapshot.facts && Array.isArray(snapshot.facts.prompts) && Array.isArray(snapshot.facts.sources) && Array.isArray(snapshot.sessionIds));
}

function readSqlite(root: string, sourceId: string, scope: Scope): SqliteSnapshot {
  const dbPath = join(root, "opencode.db");
  const facts = emptyFacts();
  facts.sources.push({ id: sourceId, agentType: "opencode", root });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const [start, end] = bounds(scope);
    const messageRows = db.prepare(`SELECT m.id, m.session_id AS sessionId, m.time_created AS timestamp, m.data, s.directory AS cwd FROM message m JOIN session s ON s.id=m.session_id WHERE m.time_created>=? AND m.time_created<? ORDER BY m.time_created,m.id`).all(start, end) as Array<any>;
    const partRows = db.prepare(`SELECT p.id, p.message_id AS messageId, p.session_id AS sessionId, p.time_created AS timestamp, p.data FROM part p JOIN message m ON m.id=p.message_id WHERE m.time_created>=? AND m.time_created<? ORDER BY p.time_created,p.id`).all(start, end) as Array<any>;
    const messages = messageRows.flatMap((row) => { try { return [{ ...row, data: JSON.parse(row.data) }]; } catch { facts.diagnostics.push({ sourceId, file: "opencode.db", code: "invalid_message_json" }); return []; } });
    const parts = partRows.flatMap((row) => { try { return [{ ...row, data: JSON.parse(row.data) }]; } catch { facts.diagnostics.push({ sourceId, file: "opencode.db", code: "invalid_part_json" }); return []; } });
    const sessionIds = new Set<string>(messages.map((item) => item.sessionId));
    consume(sourceId, messages, parts, scope, facts);
    return { facts, sessionIds: [...sessionIds] };
  } finally { db.close(); }
}

async function jsonFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => { const child = join(path, entry.name); if (entry.isDirectory()) await walk(child); else if (entry.isFile() && entry.name.endsWith(".json")) output.push(child); }));
  }
  await walk(directory); return output.sort();
}

type LegacySession = { file: string; size: number; mtimeMs: number; data: any };
type LegacyFile = { file: string; size: number; mtimeMs: number };

async function prepareLegacySession(root: string, sourceId: string, scope: Scope, session: LegacySession, options: { bypassCache?: boolean }): Promise<{ facts: FactSet; cached: boolean }> {
  const storage = join(root, "storage");
  const facts = emptyFacts();
  facts.sources.push({ id: sourceId, agentType: "opencode", root });
  const sessionId = String(session.data.id);
  const range = periodEpochBounds(scope.period, scope.timezone, scope.dayStartHour);
  const messageFiles = await jsonFiles(join(storage, "message", sessionId));
  const messageInputs = await mapConcurrent(messageFiles, 16, async (file): Promise<LegacyFile & { data?: any }> => {
    const info = await stat(file);
    try { return { file, size: info.size, mtimeMs: info.mtimeMs, data: JSON.parse(await readFile(file, "utf8")) }; }
    catch { return { file, size: info.size, mtimeMs: info.mtimeMs }; }
  });
  const messages: RawMessage[] = [];
  for (const input of messageInputs) {
    facts.scannedFiles += 1; facts.scannedBytes += input.size;
    if (!input.data) { facts.diagnostics.push({ sourceId, file: basename(input.file), code: "invalid_json" }); continue; }
    const messageSessionId = String(input.data.sessionID ?? "");
    if (messageSessionId === sessionId && inScope(Number(input.data.time?.created ?? 0), range)) messages.push({ id: String(input.data.id), sessionId, timestamp: Number(input.data.time?.created ?? 0), data: input.data, cwd: session.data.directory });
  }
  const wantedMessages = new Set(messages.map((item) => item.id));
  const partFiles = (await Promise.all([...wantedMessages].map((id) => jsonFiles(join(storage, "part", id))))).flat();
  const partInputs = await mapConcurrent(partFiles, 16, async (file): Promise<LegacyFile> => {
    const info = await stat(file);
    return { file, size: info.size, mtimeMs: info.mtimeMs };
  });
  const fingerprints: FileFingerprint[] = [
    { path: session.file, size: session.size, mtimeMs: session.mtimeMs },
    ...messageInputs.map((input) => ({ path: input.file, size: input.size, mtimeMs: input.mtimeMs })),
    ...partInputs.map((input) => ({ path: input.file, size: input.size, mtimeMs: input.mtimeMs })),
  ];
  const cacheKey = factCacheKey("opencode-legacy", 1, scope, sessionId, fingerprints);
  const cached = options.bypassCache ? undefined : await readFactCache(cacheKey);
  if (cached) return { facts: cached, cached: true };

  const parts: RawPart[] = [];
  const parsedParts = await mapConcurrent(partInputs, 16, async (input) => {
    try { return { input, data: JSON.parse(await readFile(input.file, "utf8")) }; }
    catch { return { input, data: undefined }; }
  });
  for (const { input, data } of parsedParts) {
    facts.scannedFiles += 1; facts.scannedBytes += input.size;
    if (!data) { facts.diagnostics.push({ sourceId, file: basename(input.file), code: "invalid_json" }); continue; }
    const messageId = String(data.messageID ?? "");
    if (wantedMessages.has(messageId)) parts.push({ id: String(data.id), messageId, sessionId: String(data.sessionID), timestamp: eventTime(data, 0), data });
  }
  consume(sourceId, messages, parts, scope, facts);
  await writeFactCache(cacheKey, facts);
  return { facts, cached: false };
}

async function readLegacy(root: string, sourceId: string, scope: Scope, excluded: Set<string>, onProgress?: (message: string) => void, options: { bypassCache?: boolean } = {}): Promise<FactSet[]> {
  const source = emptyFacts();
  source.sources.push({ id: sourceId, agentType: "opencode", root });
  const sessionFiles = await jsonFiles(join(root, "storage", "session"));
  const sessionInputs = await mapConcurrent(sessionFiles, 16, async (file): Promise<LegacySession | undefined> => {
    const info = await stat(file);
    try { return { file, size: info.size, mtimeMs: info.mtimeMs, data: JSON.parse(await readFile(file, "utf8")) }; }
    catch { source.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json" }); return undefined; }
  });
  source.scannedFiles += sessionFiles.length;
  source.scannedBytes += sessionInputs.reduce((sum, input) => sum + (input?.size ?? 0), 0);
  const [rangeStart, rangeEnd] = bounds(scope);
  const candidates = sessionInputs.filter((input): input is LegacySession => {
    if (!input) return false;
    const id = String(input.data.id), created = Number(input.data.time?.created ?? 0), updated = Number(input.data.time?.updated ?? created);
    return !excluded.has(id) && created < rangeEnd && updated >= rangeStart;
  });
  const prepared = await mapConcurrent(candidates, 4, (session) => prepareLegacySession(root, sourceId, scope, session, options));
  const cacheHits = prepared.reduce((count, item) => count + Number(item.cached), 0);
  if (candidates.length) onProgress?.(`OpenCode legacy cache: reused ${cacheHits}/${candidates.length} sessions from ${root}`);
  return [source, ...prepared.map((item) => item.facts)];
}

export async function readOpenCodeFacts(roots: string[], scope: Scope, onProgress?: (message: string) => void, options: { bypassCache?: boolean } = {}): Promise<FactSet> {
  const fragments: FactSet[] = [];
  for (const inputRoot of roots) {
    const root = resolve(inputRoot), sourceId = stableId("source", root);
    const source = emptyFacts();
    source.sources.push({ id: sourceId, agentType: "opencode", root });
    fragments.push(source);
    let sqliteSessions = new Set<string>();
    try {
      const dbPath = join(root, "opencode.db");
      const info = await stat(dbPath);
      const cacheKey = factCacheKey("opencode-sqlite", 1, scope, dbPath, [{ path: dbPath, size: info.size, mtimeMs: info.mtimeMs }]);
      let snapshot = options.bypassCache ? undefined : await readJsonCache(cacheKey, isSqliteSnapshot);
      if (snapshot) onProgress?.(`OpenCode SQLite fact cache hit: ${cacheKey.slice(0, 12)}`);
      else {
        snapshot = readSqlite(root, sourceId, scope);
        snapshot.facts.scannedFiles = 1;
        snapshot.facts.scannedBytes = info.size;
        await writeJsonCache(cacheKey, snapshot);
      }
      sqliteSessions = new Set(snapshot.sessionIds);
      fragments.push(snapshot.facts);
      onProgress?.(`Read ${sqliteSessions.size} OpenCode SQLite sessions from ${root}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") source.diagnostics.push({ sourceId, file: "opencode.db", code: "sqlite_read_error" });
    }
    fragments.push(...await readLegacy(root, sourceId, scope, sqliteSessions, onProgress, options));
  }
  return mergeFactSets(fragments);
}
