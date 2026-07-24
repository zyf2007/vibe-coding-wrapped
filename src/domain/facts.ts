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
    output.diagnostics.push(...set.diagnostics);
    output.sources.push(...set.sources);
    output.sessions.push(...set.sessions);
    output.turns.push(...set.turns);
    output.prompts.push(...set.prompts);
    output.tokens.push(...set.tokens);
    output.tools.push(...set.tools);
    output.fileChanges.push(...set.fileChanges);
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
