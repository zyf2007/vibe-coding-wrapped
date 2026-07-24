import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type AgentInput = {
  type: "codex";
  root: string;
};

type Detector = {
  type: AgentInput["type"];
  detect(root: string): Promise<boolean>;
};

const detectors: Detector[] = [
  {
    type: "codex",
    async detect(root) {
      try {
        const info = await stat(root);
        if (!info.isDirectory()) return false;
        return (await stat(join(root, "sessions"))).isDirectory();
      } catch {
        return false;
      }
    },
  },
];

export async function detectAgentInputs(paths: string[], onError: (message: string) => void): Promise<AgentInput[]> {
  const inputs: AgentInput[] = [];
  for (const path of [...new Set(paths.map((item) => resolve(item)))]) {
    let detected: AgentInput["type"] | undefined;
    for (const detector of detectors) {
      if (await detector.detect(path)) {
        detected = detector.type;
        break;
      }
    }
    if (detected) inputs.push({ type: detected, root: path });
    else onError(`${path}: unable to detect a supported agent data directory; skipped`);
  }
  return inputs;
}
