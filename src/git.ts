import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { FactSet, Scope } from "./types.js";
import { codingDay, inPeriod } from "./time.js";
import { displayProject, hash, metric, stableId, unavailable } from "./utils.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

export async function analyzeGit(facts: FactSet, scope: Scope, enabled: boolean): Promise<Record<string, unknown>> {
  if (!enabled) return { availability: "unsupported", repositories: [], commitTrend: unavailable("git.commit_trend", "unsupported", "disabled"), observedCommitCalls: [] };
  const cwdCandidates = [...new Set([...facts.sessions.map((item) => item.cwd), ...facts.turns.map((item) => item.cwd)].filter(Boolean) as string[])];
  const roots = new Map<string, string>();
  for (const cwd of cwdCandidates) {
    try {
      await access(cwd);
      const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
      let identity: string;
      try {
        identity = `remote:${(await git(root, ["remote", "get-url", "origin"])).trim().replace(/\.git$/, "").toLowerCase()}`;
      } catch {
        identity = `root:${(await git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n").sort().join(":")}`;
      }
      if (!roots.has(identity)) roots.set(identity, root);
    } catch {
      // Sessions copied from another device commonly point to unavailable paths.
    }
  }
  if (!roots.size) return { availability: "unsupported", repositories: [], commitTrend: unavailable("git.commit_trend", "unsupported", "no_local_repositories"), observedCommitCalls: [] };

  const repositories: Array<Record<string, unknown>> = [];
  const byDay = new Map<string, { commits: number; linesAdded: number; linesDeleted: number }>();
  let totalCommits = 0;
  let totalAdded = 0;
  let totalDeleted = 0;

  for (const [identity, root] of [...roots.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const email = (await git(root, ["config", "user.email"])).trim();
      const args = ["log", "--all", "--no-merges", `--since=${scope.period.startCodingDay}T00:00:00`, `--until=${scope.period.endCodingDay}T23:59:59`, "--format=@@%H%x09%cI", "--numstat"];
      if (email) args.splice(4, 0, `--author=${email}`);
      const output = await git(root, args);
      let currentDay: string | undefined;
      let repoCommits = 0;
      let repoAdded = 0;
      let repoDeleted = 0;
      for (const line of output.split("\n")) {
        if (line.startsWith("@@")) {
          const [, timestamp] = line.slice(2).split("\t");
          if (!timestamp) continue;
          const day = codingDay(timestamp, scope.timezone, scope.dayStartHour);
          currentDay = inPeriod(day, scope.period) ? day : undefined;
          if (currentDay) {
            repoCommits += 1;
            totalCommits += 1;
            const item = byDay.get(currentDay) ?? { commits: 0, linesAdded: 0, linesDeleted: 0 };
            item.commits += 1;
            byDay.set(currentDay, item);
          }
          continue;
        }
        if (!currentDay) continue;
        const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
        if (!match) continue;
        const added = match[1] === "-" ? 0 : Number(match[1]);
        const deleted = match[2] === "-" ? 0 : Number(match[2]);
        repoAdded += added;
        repoDeleted += deleted;
        totalAdded += added;
        totalDeleted += deleted;
        const item = byDay.get(currentDay)!;
        item.linesAdded += added;
        item.linesDeleted += deleted;
      }
      repositories.push({
        repositoryId: stableId("repo", identity),
        displayName: displayProject(root),
        identityHash: hash(identity).slice(0, 16),
        commits: repoCommits,
        linesAdded: repoAdded,
        linesDeleted: repoDeleted,
      });
    } catch {
      repositories.push({ repositoryId: stableId("repo", identity), displayName: displayProject(root), availability: "error" });
    }
  }

  const trend = [...byDay.entries()].map(([day, value]) => ({ codingDay: day, ...value })).sort((a, b) => a.codingDay.localeCompare(b.codingDay));
  return {
    availability: repositories.some((item) => item.commits !== undefined) ? "available" : "error",
    repositories,
    commitTrend: metric("git.commit_trend", trend, totalCommits, roots.size ? repositories.length / roots.size : 0, "direct"),
    commitStats: metric("git.commit_stats", { commits: totalCommits, linesAdded: totalAdded, linesDeleted: totalDeleted, activeDays: byDay.size }, totalCommits, 1, "direct"),
    languageStats: unavailable("git.language_stats", "unsupported", "v1_git_scan_does_not_read_patches"),
    observedCommitCalls: [],
  };
}
