import type { FactSet } from "./types.js";

export function emptyFacts(): FactSet {
  return { sessions: [], turns: [], prompts: [], tokens: [], tools: [], fileChanges: [], diagnostics: [], scannedFiles: 0, scannedBytes: 0, sources: [] };
}

function deduplicate<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export function mergeFactSets(sets: FactSet[]): FactSet {
  const output = emptyFacts();
  for (const set of sets) {
    output.scannedFiles += set.scannedFiles;
    output.scannedBytes += set.scannedBytes;
    for (const diagnostic of set.diagnostics) output.diagnostics.push(diagnostic);
    for (const source of set.sources) output.sources.push(source);
    for (const session of set.sessions) output.sessions.push(session);
    for (const turn of set.turns) output.turns.push(turn);
    for (const prompt of set.prompts) output.prompts.push(prompt);
    for (const token of set.tokens) output.tokens.push(token);
    for (const tool of set.tools) output.tools.push(tool);
    for (const change of set.fileChanges) output.fileChanges.push(change);
  }
  output.sessions = deduplicate(output.sessions);
  output.turns = deduplicate(output.turns);
  output.prompts = deduplicate(output.prompts);
  output.tokens = deduplicate(output.tokens);
  output.tools = deduplicate(output.tools);
  output.fileChanges = deduplicate(output.fileChanges);
  output.sources = [...new Map(output.sources.map((source) => [source.id, source])).values()].sort((a, b) => a.id.localeCompare(b.id));
  output.prompts.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  output.turns.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return output;
}
