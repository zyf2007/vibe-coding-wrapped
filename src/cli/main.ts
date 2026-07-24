#!/usr/bin/env node
import { access, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../analysis/analyze.js";
import { detectAgentInputs, readAgentFacts, selectAgentInputPaths } from "../input/agents.js";
import { writeBundle } from "../report/bundle.js";
import { completionScript } from "./completion.js";
import { renderBundle } from "../report/render.js";
import { startStaticServer } from "../http/server.js";
import { createPeriod, createRangePeriod } from "../domain/time.js";
import type { Scope } from "../domain/types.js";

type Options = {
  year?: string;
  month?: string;
  range?: string;
  timezone: string;
  dayStart: number;
  privacy: Scope["privacy"];
  inputs: string[];
  excludedInputs: string[];
  excludedWords: string[];
  theme: string;
  out?: string;
  git: boolean;
  clean: boolean;
  host: string;
  port: number;
};

const usageText = `Usage:
  vibe-wrapped build  (--year YYYY | --month YYYY-MM | --range YYYY.M-YYYY.M) [-i PATH]... --out REPORT_DIR
  vibe-wrapped render [--year YYYY | --month YYYY-MM | --range YYYY.M-YYYY.M] [-i PATH]... [--clean] [--theme official|compact|PATH] --out REPORT_DIR
  vibe-wrapped serve  [--year YYYY | --month YYYY-MM | --range YYYY.M-YYYY.M] [-i PATH]... [--clean] [--theme official|compact|PATH] [--host HOST] [--port PORT] [--out REPORT_DIR]

Commands:
  build   Generate JSON only. Existing output is replaced with a Report Bundle.
  render  Reuse JSON in REPORT_DIR or REPORT_DIR/data; generate it only when missing or --clean is used.
  serve   Render with the same reuse rules, then start a local static preview server.

Options:
  -i PATH                    Agent data directory; repeatable and auto-detected
  --exclude-input PATH       Exclude an Agent data directory; repeatable
  --year YYYY                Calendar year report
  --month YYYY-MM            Calendar month report
  --range YYYY.M-YYYY.M      Inclusive calendar-month range
  --out DIR                  Report directory
  --theme NAME|PATH          official, compact, or a trusted local theme path
  --clean                    Ignore existing JSON and the local fact cache
  --timezone IANA            Report timezone (default: system timezone)
  --day-start HOUR           Coding day boundary, 0..23 (default: 4)
  --privacy MODE             full, redacted, or metrics-only (default: redacted)
  --exclude-word WORD        Exclude a keyword; repeatable
  --git on|off               Git analysis (default: on)
  --host HOST                serve bind address (default: 127.0.0.1)
  --port PORT                serve port (default: 4173)
  -h, --help                 Show this help
  -v, --version              Show the package version`;

function fail(message?: string): never {
  if (message) console.error(message);
  console.error(usageText);
  process.exit(2);
}

function parse(argv: string[]): { command: "build" | "render" | "serve"; options: Options } {
  const command = argv[0];
  if (!command || !["build", "render", "serve"].includes(command)) fail();
  const options: Options = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dayStart: 4,
    privacy: "redacted",
    inputs: [],
    excludedInputs: [],
    excludedWords: [],
    theme: "official",
    git: true,
    clean: false,
    host: "127.0.0.1",
    port: 4173,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? fail(`${arg} requires a value`);
    if (arg === "--year") options.year = next();
    else if (arg === "--month") options.month = next();
    else if (arg === "--range") options.range = next();
    else if (arg === "--timezone") options.timezone = next();
    else if (arg === "--day-start") options.dayStart = Number(next());
    else if (arg === "--privacy") options.privacy = next() as Scope["privacy"];
    else if (arg === "-i") options.inputs.push(resolve(next()));
    else if (arg === "--exclude-input") options.excludedInputs.push(resolve(next()));
    else if (arg === "--exclude-word") options.excludedWords.push(next().normalize("NFKC").toLowerCase());
    else if (arg === "--theme") {
      if (command === "build") fail("--theme is only valid for render and serve");
      options.theme = next();
    }
    else if (arg === "--out") options.out = resolve(next());
    else if (arg === "--git") {
      const mode = next();
      if (!["on", "off"].includes(mode)) fail("--git must be on or off");
      options.git = mode === "on";
    }
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--host") {
      if (command !== "serve") fail("--host is only valid for serve");
      options.host = next();
    }
    else if (arg === "--port") {
      if (command !== "serve") fail("--port is only valid for serve");
      options.port = Number(next());
    }
    else fail(`Unknown option: ${arg}`);
  }
  return { command: command as "build" | "render" | "serve", options };
}

function validateGenerationOptions(options: Options): void {
  if ([options.year, options.month, options.range].filter(Boolean).length !== 1) fail("Generation requires exactly one of --year, --month, or --range");
  if (!Number.isInteger(options.dayStart) || options.dayStart < 0 || options.dayStart > 23) fail("--day-start must be an integer from 0 to 23");
  if (!["full", "redacted", "metrics-only"].includes(options.privacy)) fail("--privacy must be full, redacted, or metrics-only");
}

async function generate(options: Options, output: string): Promise<void> {
  validateGenerationOptions(options);
  const period = options.year ? createPeriod("year", options.year) : options.month ? createPeriod("month", options.month) : createRangePeriod(options.range!);
  const scope: Scope = { period, timezone: options.timezone, dayStartHour: options.dayStart, privacy: options.privacy, excludedWords: [...new Set(options.excludedWords)].sort() };
  const paths = selectAgentInputPaths(options.inputs, options.excludedInputs);
  const inputs = await detectAgentInputs(paths, (message) => { if (options.inputs.length) console.error(message); });
  if (!inputs.length) throw new Error("No supported agent data directories were detected");
  const facts = await readAgentFacts(inputs, scope, (message) => console.error(message), { bypassCache: options.clean });
  console.error(`Parsed ${facts.prompts.length} prompts, ${facts.turns.length} turns, ${facts.tools.length} tool calls and ${facts.tokens.length} token events.`);
  const bundle = await analyze(facts, scope, options.git);
  await writeBundle(bundle, output);
  console.error(`JSON bundle written to ${output}`);
}

async function validBundle(directory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    if (!manifest || !Array.isArray(manifest.files)) return false;
    await Promise.all(manifest.files.map((file: unknown) => {
      if (!file || typeof file !== "object" || typeof (file as { path?: unknown }).path !== "string") throw new Error("Invalid manifest file entry");
      return access(join(directory, (file as { path: string }).path));
    }));
    return true;
  } catch {
    return false;
  }
}

async function findBundle(output: string): Promise<string | undefined> {
  if (await validBundle(output)) return output;
  const data = join(output, "data");
  if (await validBundle(data)) return data;
  return undefined;
}

async function ensureRendered(options: Options): Promise<void> {
  const output = options.out!;
  let bundle = options.clean ? undefined : await findBundle(output);
  let temporary: string | undefined;
  if (!bundle) {
    temporary = join(dirname(output), `.${basename(output)}.json-${process.pid}`);
    await rm(temporary, { recursive: true, force: true });
    await generate(options, temporary);
    bundle = temporary;
  } else {
    console.error(`Reusing JSON bundle from ${bundle}`);
  }
  try {
    await renderBundle(bundle, output, options.theme);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  console.error(`Static report written to ${output}; JSON retained at ${join(output, "data")}`);
}

async function packageVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
    return String(packageJson.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--completion") {
    console.log(completionScript(argv[1] ?? ""));
    return;
  }
  if (argv.some((arg) => ["-h", "--help"].includes(arg))) {
    console.log(usageText);
    return;
  }
  if (argv.some((arg) => ["-v", "--version"].includes(arg))) {
    console.log(await packageVersion());
    return;
  }
  const { command, options } = parse(argv);
  if (command === "serve" && !options.year && !options.month && !options.range) options.year = String(new Date().getFullYear());
  if (!options.out && command === "serve") {
    const label = options.year ?? options.month ?? options.range!.replace(/[^\d]+/g, "-").replace(/-$/, "");
    options.out = resolve(`vibe-wrapped-${label}`);
  }
  if (!options.out) fail("--out is required for build and render");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) fail("--port must be an integer from 0 to 65535");
  if (command === "build") {
    await generate(options, options.out);
    return;
  }
  const existing = options.clean ? undefined : await findBundle(options.out);
  if (!existing) validateGenerationOptions(options);
  await ensureRendered(options);
  if (command === "serve") {
    const preview = await startStaticServer(options.out, options.host, options.port);
    console.error(`Serving static report at ${preview.url}`);
  }
}
