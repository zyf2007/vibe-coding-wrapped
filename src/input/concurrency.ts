import { availableParallelism } from "node:os";

export function inputWorkerCount(taskCount: number): number {
  if (taskCount <= 0) return 0;
  return Math.min(taskCount, Math.max(1, Math.min(availableParallelism() - 1, 4)));
}

export async function mapConcurrent<T, R>(items: T[], concurrency: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      output[index] = await map(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, run));
  return output;
}
