import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Bundle } from "./types.js";

const artifactNames = ["overview", "activity", "prompts", "projects", "tools", "code", "models", "tokens", "git", "records", "provenance"] as const;

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeBundle(bundle: Bundle, output: string): Promise<void> {
  const target = resolve(output);
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.tmp-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const files: Array<{ path: string; sha256: string; producer: string }> = [];
  for (const name of artifactNames) {
    const content = serialize(bundle[name]);
    const path = `${name}.json`;
    await writeFile(join(temporary, path), content, "utf8");
    files.push({ path, sha256: sha256(content), producer: `${name}@1.0.0` });
  }
  bundle.manifest.files = files;
  await writeFile(join(temporary, "manifest.json"), serialize(bundle.manifest), "utf8");
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
}
