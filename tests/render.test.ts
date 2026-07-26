import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectReportLocale, renderBundle } from "../src/report/render.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("renderBundle", () => {
  it("selects supported report languages from shell locale variables", () => {
    expect(detectReportLocale({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(detectReportLocale({ LANG: "zh_CN.UTF-8", LC_MESSAGES: "ja_JP.UTF-8" })).toBe("ja");
    expect(detectReportLocale({ LC_ALL: "C.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(detectReportLocale({ LANG: "fr_FR.UTF-8" })).toBe("zh-CN");
  });

  it("renders a selected built-in theme and copies report data", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-render-"));
    temporaryDirectories.push(root);
    const bundle = join(root, "bundle");
    const output = join(root, "site");
    await mkdir(bundle);
    await writeFile(join(bundle, "manifest.json"), '{"report":"fixture"}');

    await renderBundle(bundle, output, "compact");

    await expect(readFile(join(output, "index.html"), "utf8")).resolves.toContain("compact coding report");
    await expect(readFile(join(output, "app.js"), "utf8")).resolves.toContain("model-heatmap");
    await expect(readFile(join(output, "theme-config.json"), "utf8")).resolves.toContain('"locale"');
    await expect(readFile(join(output, "i18n.js"), "utf8")).resolves.toContain("loadI18n");
    await expect(readFile(join(output, "locales", "en.json"), "utf8")).resolves.toContain("compact.lede");
    await expect(readFile(join(output, "data", "manifest.json"), "utf8")).resolves.toContain("fixture");
  });

  it("leaves custom theme assets under the custom theme's ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-render-")); temporaryDirectories.push(root);
    const bundle = join(root, "bundle"); const theme = join(root, "theme"); const output = join(root, "site");
    await Promise.all([mkdir(bundle), mkdir(theme)]);
    await writeFile(join(bundle, "manifest.json"), "{}");
    await writeFile(join(theme, "index.html"), "custom");
    await writeFile(join(theme, "app.js"), "custom-app");
    await writeFile(join(theme, "style.css"), "custom-style");

    await renderBundle(bundle, output, theme);

    await expect(readFile(join(output, "app.js"), "utf8")).resolves.toBe("custom-app");
    await expect(readFile(join(output, "theme-config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(output, "i18n.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unknown theme", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-render-"));
    temporaryDirectories.push(root);
    await expect(renderBundle(root, join(root, "site"), "missing-theme-for-test")).rejects.toThrow("was not found");
  });
});
