import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { Evidence, Metric } from "./types.js";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${hash(value).slice(0, 16)}`;
}

export function metric<T>(definitionId: string, value: T, sampleSize: number, coverage = 1, evidence: Evidence = "structural_derived"): Metric<T> {
  return { availability: "available", value, sampleSize, coverage, evidence, methodVersion: "v1.0.0", definitionId };
}

export function unavailable<T>(definitionId: string, availability: "unsupported" | "insufficient_data" | "error", reasonCode: string, sampleSize = 0, coverage = 0): Metric<T> {
  return { availability, reasonCode, sampleSize, coverage, evidence: "structural_derived", methodVersion: "v1.0.0", definitionId };
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

export function redactText(value: string): string {
  return value
    .replace(/(?:sk|gh[oprsu]|xox[baprs])-[-A-Za-z0-9_]{16,}/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z]:?[/\\](?:[^\s/\\]+[/\\]){2,}[^\s]*/g, "[PATH]")
    .replace(/\/(?:home|Users)\/[^\s/]+\//g, "/~/")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayProject(cwd?: string): string {
  return cwd ? basename(cwd) || "root" : "unknown";
}

const languageByExtension: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin",
  ".c": "C", ".h": "C/C++ Header", ".cc": "C++", ".cpp": "C++", ".cs": "C#",
  ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".scala": "Scala", ".lua": "Lua",
  ".sh": "Shell", ".zsh": "Shell", ".fish": "Shell", ".sql": "SQL", ".html": "HTML",
  ".css": "CSS", ".scss": "SCSS", ".vue": "Vue", ".svelte": "Svelte", ".md": "Markdown",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".xml": "XML",
};

export function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "Dockerfile";
  if (name === "makefile") return "Makefile";
  return languageByExtension[extname(name)] ?? "Unknown";
}

export function sortObject<T extends Record<string, number>>(value: T): Array<{ id: string; count: number }> {
  return Object.entries(value)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
