import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FactSet, Scope } from "../domain/types.js";
import { hash } from "../domain/utils.js";

function cacheDirectory(): string {
  const base = process.env.XDG_CACHE_HOME ? resolve(process.env.XDG_CACHE_HOME) : join(homedir(), ".cache");
  return join(base, "vibe-coding-wrapped");
}

function validFactSet(value: unknown): value is FactSet {
  if (!value || typeof value !== "object") return false;
  const facts = value as Partial<FactSet>;
  return Array.isArray(facts.prompts) && Array.isArray(facts.tools) && Array.isArray(facts.sources);
}

export type FileFingerprint = { path: string; size: number; mtimeMs: number };

export function factCacheKey(adapter: string, version: number, scope: Scope, unit: string, fingerprints: FileFingerprint[]): string {
  return hash(JSON.stringify({ adapter, version, period: scope.period, timezone: scope.timezone, dayStartHour: scope.dayStartHour, unit, fingerprints }));
}

export async function readJsonCache<T>(key: string, validate: (value: unknown) => value is T): Promise<T | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(cacheDirectory(), `${key}.json`), "utf8"));
    return validate(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeJsonCache(key: string, value: unknown): Promise<void> {
  const directory = cacheDirectory();
  const path = join(directory, `${key}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readFactCache(key: string): Promise<FactSet | undefined> {
  return readJsonCache(key, validFactSet);
}

export async function writeFactCache(key: string, facts: FactSet): Promise<void> {
  await writeJsonCache(key, facts);
}
