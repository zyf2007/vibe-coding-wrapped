import { access, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { temporarySiblingPath } from "./temporary.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type ReportLocale = "zh-CN" | "en" | "ja";

export function detectReportLocale(environment: NodeJS.ProcessEnv = process.env): ReportLocale {
  const raw = environment.LC_ALL || environment.LC_MESSAGES || environment.LANG || "zh-CN";
  const normalized = raw.toLowerCase().replace("_", "-");
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("en") || normalized === "c" || normalized.startsWith("c.")) return "en";
  return "zh-CN";
}

type ResolvedTheme = { directory: string; builtin: boolean };

async function resolveTheme(selection: string): Promise<ResolvedTheme> {
  const builtin = join(sourceRoot, "themes", selection);
  try {
    await access(join(builtin, "index.html"));
    return { directory: builtin, builtin: true };
  } catch {
    const custom = resolve(selection);
    try {
      await Promise.all(["index.html", "app.js", "style.css"].map((file) => access(join(custom, file))));
      return { directory: custom, builtin: false };
    } catch {
      throw new Error(`Theme "${selection}" was not found or is missing index.html, app.js, or style.css`);
    }
  }
}

export async function renderBundle(bundleDirectory: string, output: string, themeSelection = "official"): Promise<void> {
  const bundle = resolve(bundleDirectory);
  const target = resolve(output);
  const temporary = temporarySiblingPath(target);
  const theme = await resolveTheme(themeSelection);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  await cp(theme.directory, temporary, { recursive: true });
  if (theme.builtin) {
    const shared = join(sourceRoot, "themes", "shared");
    await cp(join(shared, "i18n.js"), join(temporary, "i18n.js"));
    await cp(join(shared, "locales"), join(temporary, "locales"), { recursive: true });
    await writeFile(join(temporary, "theme-config.json"), `${JSON.stringify({ locale: detectReportLocale() }, null, 2)}\n`, "utf8");
  }
  await mkdir(join(temporary, "data"), { recursive: true });
  await cp(bundle, join(temporary, "data"), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
}
