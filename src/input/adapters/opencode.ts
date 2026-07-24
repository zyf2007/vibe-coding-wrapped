import Database from "better-sqlite3";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { emptyFacts } from "../../domain/facts.js";
import { commandFamily, isCheckCommand, normalizeTool, parseExitCode } from "../../domain/tools.js";
import { codingDay, inPeriod } from "../../domain/time.js";
import type { FactSet, FileChangeFact, Scope, ToolFact } from "../../domain/types.js";
import { hash, languageForPath, stableId } from "../../domain/utils.js";

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
function inScope(timestamp: number, scope: Scope): boolean {
  return Number.isFinite(timestamp) && inPeriod(codingDay(instant(timestamp), scope.timezone, scope.dayStartHour), scope.period);
}
function bounds(scope: Scope): [number, number] {
  return [Date.parse(`${scope.period.startCodingDay}T00:00:00Z`) - 172_800_000, Date.parse(`${scope.period.endCodingDay}T00:00:00Z`) + 259_200_000];
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
  const partsByMessage = new Map<string, RawPart[]>();
  for (const part of parts) { const list = partsByMessage.get(part.messageId) ?? []; list.push(part); partsByMessage.set(part.messageId, list); }
  const seenSessions = new Set(facts.sessions.map((item) => item.id));
  const seenTurns = new Set(facts.turns.map((item) => item.id));
  const seenPrompts = new Set(facts.prompts.map((item) => item.id));
  const seenTokens = new Set(facts.tokens.map((item) => item.id));
  const seenTools = new Set(facts.tools.map((item) => item.id));
  const seenChanges = new Set(facts.fileChanges.map((item) => item.id));
  const turnByMessage = new Map<string, string>();
  for (const message of messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
    const timestamp = eventTime(message.data, message.timestamp);
    if (!inScope(timestamp, scope)) continue;
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
      if (!seenPrompts.has(id)) { seenPrompts.add(id); facts.prompts.push({ id, sessionId, turnId, occurredAt, cwd: message.cwd, text, modelId: modelId(message.data) }); }
      continue;
    }
    if (role !== "assistant") continue;
    const turnId = turnByMessage.get(String(message.data?.parentID ?? "")) ?? stableId("turn", `${sessionId}:${message.data?.parentID ?? message.id}`);
    turnByMessage.set(message.id, turnId);
    const model = modelId(message.data) ?? "unknown";
    if (!seenTurns.has(turnId)) { seenTurns.add(turnId); facts.turns.push({ id: turnId, sessionId, occurredAt, cwd: message.cwd, modelId: model }); }
    const prompt = facts.prompts.find((item) => item.turnId === turnId);
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

function readSqlite(root: string, sourceId: string, scope: Scope, facts: FactSet): Set<string> {
  const dbPath = join(root, "opencode.db");
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
    return sessionIds;
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

async function readLegacy(root: string, sourceId: string, scope: Scope, facts: FactSet, excluded: Set<string>): Promise<void> {
  const storage = join(root, "storage");
  const sessionFiles = await jsonFiles(join(storage, "session"));
  const sessions = new Map<string, any>();
  const [rangeStart, rangeEnd] = bounds(scope);
  for (const file of sessionFiles) {
    facts.scannedFiles += 1; facts.scannedBytes += (await stat(file)).size;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const id = String(data.id), created = Number(data.time?.created ?? 0), updated = Number(data.time?.updated ?? created);
      if (!excluded.has(id) && created < rangeEnd && updated >= rangeStart) sessions.set(id, data);
    } catch { facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json" }); }
  }
  const messageFiles = (await Promise.all([...sessions.keys()].map((id) => jsonFiles(join(storage, "message", id))))).flat();
  const messages: RawMessage[] = [];
  for (const file of messageFiles) {
    facts.scannedFiles += 1; facts.scannedBytes += (await stat(file)).size;
    try { const data = JSON.parse(await readFile(file, "utf8")); const sessionId = String(data.sessionID ?? ""); const session = sessions.get(sessionId); if (session && inScope(Number(data.time?.created ?? 0), scope)) messages.push({ id: String(data.id), sessionId, timestamp: Number(data.time?.created ?? 0), data, cwd: session.directory }); } catch { facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json" }); }
  }
  const wantedMessages = new Set(messages.map((item) => item.id));
  const partFiles = (await Promise.all([...wantedMessages].map((id) => jsonFiles(join(storage, "part", id))))).flat();
  const parts: RawPart[] = [];
  for (const file of partFiles) {
    facts.scannedFiles += 1; facts.scannedBytes += (await stat(file)).size;
    try { const data = JSON.parse(await readFile(file, "utf8")); const messageId = String(data.messageID ?? ""); if (wantedMessages.has(messageId)) parts.push({ id: String(data.id), messageId, sessionId: String(data.sessionID), timestamp: eventTime(data, 0), data }); } catch { facts.diagnostics.push({ sourceId, file: basename(file), code: "invalid_json" }); }
  }
  consume(sourceId, messages, parts, scope, facts);
}

export async function readOpenCodeFacts(roots: string[], scope: Scope, onProgress?: (message: string) => void): Promise<FactSet> {
  const facts = emptyFacts();
  for (const inputRoot of roots) {
    const root = resolve(inputRoot), sourceId = stableId("source", root);
    facts.sources.push({ id: sourceId, agentType: "opencode", root });
    let sqliteSessions = new Set<string>();
    try { const info = await stat(join(root, "opencode.db")); facts.scannedFiles += 1; facts.scannedBytes += info.size; sqliteSessions = readSqlite(root, sourceId, scope, facts); onProgress?.(`Read ${sqliteSessions.size} OpenCode SQLite sessions from ${root}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") facts.diagnostics.push({ sourceId, file: "opencode.db", code: "sqlite_read_error" }); }
    await readLegacy(root, sourceId, scope, facts, sqliteSessions);
  }
  return facts;
}
