import type { FactSet, FileChangeFact, PromptFact, ToolFact, TurnFact } from "../domain/types.js";
import { stableId } from "../domain/utils.js";

export function factReference(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const items = map.get(key) ?? [];
  items.push(value);
  map.set(key, items);
}

export type AnalysisContext = {
  promptTurnKeys: Set<string>;
  toolsByTurn: Map<string, ToolFact[]>;
  toolByCall: Map<string, ToolFact>;
  changesByCall: Map<string, FileChangeFact[]>;
  promptsByModel: Map<string, PromptFact[]>;
  toolsByModel: Map<string, ToolFact[]>;
  changesByModel: Map<string, FileChangeFact[]>;
  turnsByModel: Map<string, TurnFact[]>;
  turnsBySession: Map<string, TurnFact[]>;
  turnCwd: Map<string, string | undefined>;
};

export function normalizedModelId(value?: string): string {
  return value || "unknown";
}

export function createAnalysisContext(facts: FactSet): AnalysisContext {
  const context: AnalysisContext = {
    promptTurnKeys: new Set(), toolsByTurn: new Map(), toolByCall: new Map(), changesByCall: new Map(),
    promptsByModel: new Map(), toolsByModel: new Map(), changesByModel: new Map(), turnsByModel: new Map(),
    turnsBySession: new Map(), turnCwd: new Map(),
  };
  for (const prompt of facts.prompts) {
    if (prompt.turnId) context.promptTurnKeys.add(factReference(prompt.sessionId, prompt.turnId));
    append(context.promptsByModel, normalizedModelId(prompt.modelId), prompt);
  }
  for (const turn of facts.turns) {
    append(context.turnsByModel, normalizedModelId(turn.modelId), turn);
    append(context.turnsBySession, turn.sessionId, turn);
    context.turnCwd.set(factReference(turn.sessionId, turn.id), turn.cwd);
  }
  for (const tool of facts.tools) {
    if (tool.turnId) append(context.toolsByTurn, factReference(tool.sessionId, tool.turnId), tool);
    context.toolByCall.set(factReference(tool.sessionId, tool.callId), tool);
    append(context.toolsByModel, normalizedModelId(tool.modelId), tool);
  }
  for (const change of facts.fileChanges) {
    append(context.changesByCall, factReference(change.sessionId, change.callId), change);
    append(context.changesByModel, normalizedModelId(change.modelId), change);
  }
  return context;
}

export function cwdForTurn(context: AnalysisContext, sessionId: string, turnId?: string): string | undefined {
  if (!turnId) return undefined;
  return context.turnCwd.get(factReference(sessionId, turnId))
    ?? context.turnCwd.get(factReference(sessionId, stableId("turn", `${sessionId}:${turnId}`)));
}
