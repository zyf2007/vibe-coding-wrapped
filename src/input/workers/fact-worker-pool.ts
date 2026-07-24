import { Worker } from "node:worker_threads";
import type { FactSet, Scope } from "../../domain/types.js";
import { inputWorkerCount } from "../concurrency.js";

export type JsonlWorkerKind = "codex" | "claude-code";

export type JsonlWorkerTask = {
  file: string;
  fileSize: number;
  root: string;
  sourceId: string;
  scope: Scope;
};

type WorkerResult = { ready?: true; index?: number; facts?: FactSet; error?: string };

function workerModuleUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./fact-worker.${extension}`, import.meta.url);
}

function createFactWorker(kind: JsonlWorkerKind): Worker {
  const data = { kind };
  if (!import.meta.url.endsWith(".ts")) return new Worker(workerModuleUrl(), { workerData: data });
  const bootstrap = `
    const { workerData } = require("node:worker_threads");
    import("tsx/esm/api")
      .then(({ register }) => { register(); return import(workerData.moduleUrl); })
      .catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Worker(bootstrap, {
    eval: true,
    workerData: { ...data, moduleUrl: workerModuleUrl().href },
  });
}

export async function parseJsonlWithWorkers(
  kind: JsonlWorkerKind,
  tasks: JsonlWorkerTask[],
  onParsed?: (completed: number, total: number) => void,
): Promise<{ facts: FactSet[]; workerCount: number }> {
  const workerCount = inputWorkerCount(tasks.length);
  if (!workerCount) return { facts: [], workerCount: 0 };
  const facts = new Array<FactSet>(tasks.length);
  let completed = 0;
  let nextIndex = 0;
  const workers: Worker[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      for (const worker of workers) void worker.terminate();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };
    const dispatch = (worker: Worker) => {
      if (nextIndex >= tasks.length) return;
      const index = nextIndex++;
      worker.postMessage({ index, task: tasks[index] });
    };
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      const worker = createFactWorker(kind);
      workers.push(worker);
      worker.on("message", (message: WorkerResult) => {
        if (message.ready) {
          dispatch(worker);
          return;
        }
      if (message.error) {
          finish(new Error(message.error));
        return;
      }
        if (message.index === undefined || !message.facts) {
          finish(new Error(`The ${kind} parser worker returned no facts`));
        return;
      }
      facts[message.index] = message.facts;
      completed += 1;
      onParsed?.(completed, tasks.length);
        if (completed === tasks.length) finish();
        else dispatch(worker);
      });
      worker.on("error", finish);
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(new Error(`The ${kind} parser worker exited with code ${code}`));
      });
    }
  });
  return { facts, workerCount };
}
