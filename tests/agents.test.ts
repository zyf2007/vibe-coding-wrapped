import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgentInputs } from "../src/agents.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("detectAgentInputs", () => {
  it("detects Codex homes and skips unsupported inputs with path-first errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-agents-"));
    temporaryDirectories.push(root);
    const codex = join(root, "copied-codex");
    const unknown = join(root, "unknown-agent");
    await mkdir(join(codex, "sessions"), { recursive: true });
    await mkdir(unknown);
    const errors: string[] = [];

    const inputs = await detectAgentInputs([unknown, codex], (message) => errors.push(message));

    expect(inputs).toEqual([{ type: "codex", root: codex }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`${unknown}:`)).toBe(true);
  });
});
