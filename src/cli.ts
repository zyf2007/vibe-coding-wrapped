#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { analyze } from "./analyze.js";
import { writeBundle } from "./bundle.js";
import { readCodexFacts } from "./codex.js";
import { renderBundle } from "./render.js";
import { createPeriod } from "./time.js";
import type { Scope } from "./types.js";

type Options = { year?: string; month?: string; timezone: string; dayStart: number; privacy: Scope["privacy"]; codexHomes: string[]; excludedWords: string[]; theme: string; out?: string; git: boolean; positional: string[] };

function usage(): never {
  console.error(`Usage:
  vibe-wrapped generate (--year YYYY | --month YYYY-MM) [--codex-home PATH]... --out DIR
  vibe-wrapped render BUNDLE_DIR [--theme official|compact|PATH] --out DIR
  vibe-wrapped build (--year YYYY | --month YYYY-MM) [--codex-home PATH]... [--theme official|compact|PATH] --out DIR

Options: --timezone IANA --day-start 0..23 --privacy full|redacted|metrics-only --exclude-word WORD --theme NAME|PATH --git off`);
  process.exit(2);
}

function parse(argv: string[]): { command: string; options: Options } {
  const command = argv[0];
  if (!command || !["generate", "render", "build"].includes(command)) usage();
  const options: Options = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", dayStart: 4, privacy: "redacted", codexHomes: [], excludedWords: [], theme: "official", git: true, positional: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? usage();
    if (arg === "--year") options.year = next();
    else if (arg === "--month") options.month = next();
    else if (arg === "--timezone") options.timezone = next();
    else if (arg === "--day-start") options.dayStart = Number(next());
    else if (arg === "--privacy") options.privacy = next() as Scope["privacy"];
    else if (arg === "--codex-home") options.codexHomes.push(resolve(next()));
    else if (arg === "--exclude-word") options.excludedWords.push(next().normalize("NFKC").toLowerCase());
    else if (arg === "--theme") options.theme = next();
    else if (arg === "--out") options.out = resolve(next());
    else if (arg === "--git") options.git = next() !== "off";
    else if (arg.startsWith("-")) usage();
    else options.positional.push(resolve(arg));
  }
  return { command, options };
}

async function generate(options: Options, output: string): Promise<void> {
  if (Boolean(options.year) === Boolean(options.month)) usage();
  if (!Number.isInteger(options.dayStart) || options.dayStart < 0 || options.dayStart > 23) usage();
  if (!["full", "redacted", "metrics-only"].includes(options.privacy)) usage();
  const period = options.year ? createPeriod("year", options.year) : createPeriod("month", options.month!);
  const scope: Scope = { period, timezone: options.timezone, dayStartHour: options.dayStart, privacy: options.privacy, excludedWords: [...new Set(options.excludedWords)].sort() };
  const roots = options.codexHomes.length ? options.codexHomes : [process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex")];
  const facts = await readCodexFacts(roots, scope, (message) => console.error(message));
  console.error(`Parsed ${facts.prompts.length} prompts, ${facts.turns.length} turns, ${facts.tools.length} tool calls and ${facts.tokens.length} token events.`);
  const bundle = await analyze(facts, scope, options.git);
  await writeBundle(bundle, output);
  console.error(`JSON bundle written to ${output}`);
}

async function main(): Promise<void> {
  const { command, options } = parse(process.argv.slice(2));
  if (!options.out) usage();
  if (command === "generate") return generate(options, options.out);
  if (command === "render") {
    if (options.positional.length !== 1) usage();
    await renderBundle(options.positional[0], options.out, options.theme);
    console.error(`Static report written to ${options.out}`);
    return;
  }
  const bundleOutput = `${options.out}-json`;
  await generate(options, bundleOutput);
  await renderBundle(bundleOutput, options.out, options.theme);
  console.error(`Static report written to ${options.out}; JSON retained at ${bundleOutput}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
