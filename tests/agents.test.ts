import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgentInputs, selectAgentInputPaths } from "../src/input/agents.js";

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

  it("detects Claude Code and OpenCode roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-agents-"));
    temporaryDirectories.push(root);
    const claude = join(root, "claude");
    const opencode = join(root, "opencode");
    await mkdir(join(claude, "projects"), { recursive: true });
    await mkdir(join(claude, "sessions"));
    await mkdir(opencode);
    await writeFile(join(opencode, "opencode.db"), "");
    expect(await detectAgentInputs([claude, opencode], () => {})).toEqual([
      { type: "claude-code", root: claude },
      { type: "opencode", root: opencode },
    ]);
  });

  it("detects Pi roots before the generic sessions-based Codex adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-agents-")); temporaryDirectories.push(root);
    const pi = join(root, "pi-agent");
    await mkdir(join(pi, "sessions", "--work-demo--"), { recursive: true });
    await writeFile(join(pi, "settings.json"), "{}");
    expect(await detectAgentInputs([pi], () => {})).toEqual([{ type: "pi", root: pi }]);
  });

  it("detects DSH roots before other sessions-based adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-agents-")); temporaryDirectories.push(root);
    const dsh = join(root, "dsh");
    await mkdir(join(dsh, "sessions", "session-1"), { recursive: true });
    await writeFile(join(dsh, "settings.yaml"), "version: test\n");
    expect(await detectAgentInputs([dsh], () => {})).toEqual([{ type: "dsh", root: dsh }]);
  });

  it("deduplicates explicit inputs and applies exact root exclusions", () => {
    expect(selectAgentInputPaths(["/tmp/a", "/tmp/a", "/tmp/b"], ["/tmp/a"])).toEqual(["/tmp/b"]);
  });
});
