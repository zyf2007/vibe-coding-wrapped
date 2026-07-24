export type Period = {
  kind: "year" | "month";
  value: string;
  startCodingDay: string;
  endCodingDay: string;
};

export type Scope = {
  period: Period;
  timezone: string;
  dayStartHour: number;
  privacy: "full" | "redacted" | "metrics-only";
  excludedWords?: string[];
};

export type Evidence = "direct" | "structural_derived";

export type Metric<T> = {
  availability: "available" | "unsupported" | "insufficient_data" | "error";
  value?: T;
  reasonCode?: string;
  sampleSize: number;
  coverage: number;
  evidence: Evidence;
  methodVersion: string;
  definitionId: string;
};

export type PromptFact = {
  id: string;
  sessionId: string;
  turnId?: string;
  occurredAt: string;
  cwd?: string;
  text: string;
  modelId?: string;
};

export type TokenFact = {
  id: string;
  sessionId: string;
  turnId?: string;
  occurredAt: string;
  modelId?: string;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  total: number;
};

export type ToolFact = {
  id: string;
  callId: string;
  sessionId: string;
  turnId?: string;
  occurredAt: string;
  name: string;
  category: string;
  cwd?: string;
  modelId?: string;
  commandFamily?: string;
  isMutation: boolean;
  isCheckInvocation: boolean;
  exitCode?: number;
};

export type FileChangeFact = {
  id: string;
  callId: string;
  sessionId: string;
  turnId?: string;
  occurredAt: string;
  path: string;
  added: number;
  deleted: number;
  language: string;
  modelId?: string;
};

export type TurnFact = {
  id: string;
  sessionId: string;
  occurredAt: string;
  cwd?: string;
  modelId: string;
  effort?: string;
};

export type SessionFact = {
  id: string;
  occurredAt: string;
  cwd?: string;
  sourceId: string;
};

export type Diagnostic = {
  sourceId: string;
  file: string;
  code: string;
  line?: number;
};

export type FactSet = {
  sessions: SessionFact[];
  turns: TurnFact[];
  prompts: PromptFact[];
  tokens: TokenFact[];
  tools: ToolFact[];
  fileChanges: FileChangeFact[];
  diagnostics: Diagnostic[];
  scannedFiles: number;
  scannedBytes: number;
  sourceIds: string[];
};

export type Bundle = Record<string, unknown> & {
  manifest: Record<string, unknown>;
  overview: Record<string, unknown>;
  activity: Record<string, unknown>;
  prompts: Record<string, unknown>;
  projects: Record<string, unknown>;
  tools: Record<string, unknown>;
  code: Record<string, unknown>;
  models: Record<string, unknown>;
  tokens: Record<string, unknown>;
  git: Record<string, unknown>;
  records: Record<string, unknown>;
  provenance: Record<string, unknown>;
};
