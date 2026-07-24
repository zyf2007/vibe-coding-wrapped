import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function resolveTheme(selection: string): Promise<string> {
  const builtin = join(sourceRoot, "themes", selection);
  try {
    await access(join(builtin, "index.html"));
    return builtin;
  } catch {
    const custom = resolve(selection);
    try {
      await Promise.all(["index.html", "app.js", "style.css"].map((file) => access(join(custom, file))));
      return custom;
    } catch {
      throw new Error(`Theme "${selection}" was not found or is missing index.html, app.js, or style.css`);
    }
  }
}

export async function renderBundle(bundleDirectory: string, output: string, themeSelection = "official"): Promise<void> {
  const bundle = resolve(bundleDirectory);
  const target = resolve(output);
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.tmp-${process.pid}`);
  const theme = await resolveTheme(themeSelection);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  await cp(theme, temporary, { recursive: true });
  await mkdir(join(temporary, "data"), { recursive: true });
  await cp(bundle, join(temporary, "data"), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
}
