import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readClaudeFacts } from "./adapters/claude.js";
import { readCodexFacts } from "./adapters/codex.js";
import { mergeFactSets } from "../domain/facts.js";
import { readOpenCodeFacts } from "./adapters/opencode.js";
import { readPiFacts } from "./adapters/pi.js";
import { readDshFacts } from "./adapters/dsh.js";
import type { AgentType, FactSet, Scope } from "../domain/types.js";

export type AgentInput = {
  type: AgentType;
  root: string;
};

export type AgentReadOptions = { bypassCache?: boolean };

export type AgentDataSourceAdapter = {
  id: AgentType;
  detect(root: string): Promise<boolean>;
  read(roots: string[], scope: Scope, onProgress?: (message: string) => void, options?: AgentReadOptions): Promise<FactSet>;
};

export const agentAdapters: AgentDataSourceAdapter[] = [
  {
    id: "dsh",
    async detect(root) {
      try {
        if (!(await stat(join(root, "settings.yaml"))).isFile()) return false;
        const sessions = join(root, "sessions");
        if (!(await stat(sessions)).isDirectory()) return false;
        const entries = await readdir(sessions, { withFileTypes: true });
        return entries.some((entry) => entry.isDirectory());
      } catch { return false; }
    },
    read: readDshFacts,
  },
  {
    id: "pi",
    async detect(root) {
      try {
        if ((await stat(join(root, "settings.json"))).isFile() && (await stat(join(root, "sessions"))).isDirectory()) return true;
      } catch {}
      try {
        const sessions = (await stat(join(root, "sessions"))).isDirectory() ? join(root, "sessions") : root;
        const entries = await readdir(sessions, { withFileTypes: true });
        return entries.some((entry) => entry.isDirectory() && /^--.*--$/.test(entry.name));
      } catch { return false; }
    },
    read: readPiFacts,
  },
  {
    id: "claude-code",
    async detect(root) {
      try { return (await stat(join(root, "projects"))).isDirectory(); } catch { return false; }
    },
    read: readClaudeFacts,
  },
  {
    id: "codex",
    async detect(root) {
      try {
        const info = await stat(root);
        if (!info.isDirectory()) return false;
        return (await stat(join(root, "sessions"))).isDirectory();
      } catch {
        return false;
      }
    },
    read: readCodexFacts,
  },
  {
    id: "opencode",
    async detect(root) {
      try { return (await stat(join(root, "opencode.db"))).isFile(); } catch {
        try { return (await stat(join(root, "storage"))).isDirectory(); } catch { return false; }
      }
    },
    read: readOpenCodeFacts,
  },
];

export async function detectAgentInputs(paths: string[], onError: (message: string) => void): Promise<AgentInput[]> {
  const inputs: AgentInput[] = [];
  for (const path of [...new Set(paths.map((item) => resolve(item)))]) {
    let detected: AgentType | undefined;
    for (const adapter of agentAdapters) {
      if (await adapter.detect(path)) {
        detected = adapter.id;
        break;
      }
    }
    if (detected) inputs.push({ type: detected, root: path });
    else onError(`${path}: unable to detect a supported agent data directory; skipped`);
  }
  return inputs;
}

export function defaultAgentPaths(): string[] {
  const xdgData = process.env.XDG_DATA_HOME ? resolve(process.env.XDG_DATA_HOME) : join(homedir(), ".local", "share");
  return [...new Set([
    process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex"),
    process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh"),
    process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude"),
    process.env.OPENCODE_DB ? resolve(process.env.OPENCODE_DB, "..") : join(xdgData, "opencode"),
    process.env.PI_CODING_AGENT_SESSION_DIR
      ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
      : process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent"),
  ])];
}

export function selectAgentInputPaths(inputs: string[], excludedInputs: string[]): string[] {
  const excluded = new Set(excludedInputs.map((path) => resolve(path)));
  const candidates = inputs.length ? inputs : defaultAgentPaths();
  return [...new Set(candidates.map((path) => resolve(path)))].filter((path) => !excluded.has(path));
}

export async function readAgentFacts(inputs: AgentInput[], scope: Scope, onProgress?: (message: string) => void, options: AgentReadOptions = {}): Promise<FactSet> {
  const sets = await Promise.all(agentAdapters.map(async (adapter) => {
    const roots = inputs.filter((input) => input.type === adapter.id).map((input) => input.root);
    return roots.length ? adapter.read(roots, scope, onProgress, options) : undefined;
  }));
  return mergeFactSets(sets.filter((set): set is FactSet => set !== undefined));
}
