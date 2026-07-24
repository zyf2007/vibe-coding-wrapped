import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStaticServer, type StaticServer } from "../src/server.js";

const temporaryDirectories: string[] = [];
const servers: StaticServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("startStaticServer", () => {
  it("serves a static report and returns 404 for missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-server-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "data"));
    await writeFile(join(root, "index.html"), "<h1>wrapped</h1>");
    await writeFile(join(root, "data", "overview.json"), '{"ok":true}');
    const preview = await startStaticServer(root, "127.0.0.1", 0);
    servers.push(preview);

    expect(await fetch(preview.url).then((response) => response.text())).toContain("wrapped");
    expect(await fetch(`${preview.url}data/overview.json`).then((response) => response.json())).toEqual({ ok: true });
    expect((await fetch(`${preview.url}missing`)).status).toBe(404);
  });
});
