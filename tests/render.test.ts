import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderBundle } from "../src/render.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("renderBundle", () => {
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
    await expect(readFile(join(output, "data", "manifest.json"), "utf8")).resolves.toContain("fixture");
  });

  it("rejects an unknown theme", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-render-"));
    temporaryDirectories.push(root);
    await expect(renderBundle(root, join(root, "site"), "missing-theme-for-test")).rejects.toThrow("was not found");
  });
});
