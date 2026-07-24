import { parentPort, workerData } from "node:worker_threads";
import type { FactSet } from "../../domain/types.js";
import type { JsonlWorkerKind, JsonlWorkerTask } from "./fact-worker-pool.js";

const input = workerData as { kind: JsonlWorkerKind };

async function parser(): Promise<(task: JsonlWorkerTask) => Promise<FactSet>> {
  if (input.kind === "codex") {
    const { parseCodexFile } = await import("../adapters/codex.js");
    return (task) => parseCodexFile(task.file, task.root, task.sourceId, task.scope, task.fileSize);
  }
  const { parseClaudeFile } = await import("../adapters/claude.js");
  return (task) => parseClaudeFile(task.file, task.root, task.sourceId, task.scope, task.fileSize);
}

const parse = await parser();
parentPort?.on("message", async ({ index, task }: { index: number; task: JsonlWorkerTask }) => {
  try {
    parentPort?.postMessage({ index, facts: await parse(task) });
  } catch (error) {
    parentPort?.postMessage({ index, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});
parentPort?.postMessage({ ready: true });
