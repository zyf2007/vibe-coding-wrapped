import path from "node:path";

type PathOperations = Pick<typeof path, "basename" | "dirname" | "join">;

export function temporarySiblingPath(target: string, pid = process.pid, paths: PathOperations = path): string {
  return paths.join(paths.dirname(target), `.${paths.basename(target)}.tmp-${pid}`);
}
