import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function renderBundle(bundleDirectory: string, output: string): Promise<void> {
  const bundle = resolve(bundleDirectory);
  const target = resolve(output);
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.tmp-${process.pid}`);
  const theme = join(sourceRoot, "themes", "official");
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, "data"), { recursive: true });
  await cp(bundle, join(temporary, "data"), { recursive: true });
  await cp(join(theme, "app.js"), join(temporary, "app.js"));
  await cp(join(theme, "style.css"), join(temporary, "style.css"));
  const template = await readFile(join(theme, "index.html"), "utf8");
  await writeFile(join(temporary, "index.html"), template, "utf8");
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
}
