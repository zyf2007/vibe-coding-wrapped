# Agent adapters

The analyzer has one boundary between source-specific logs and report logic:

```text
Agent directories -> adapters -> normalized FactSet -> combined analysis -> JSON bundle -> themes
```

Adapters may parse different storage formats, but they must emit the facts in `src/domain/types.ts`. `readAgentFacts()` merges and deduplicates every input before `analyze()` runs. Consequently, report metrics are never split by Agent. `manifest.report.agentScope` and `provenance.sources` describe input coverage only.

## Detection and storage

| Agent | Detection | Primary storage |
| --- | --- | --- |
| Codex | `sessions/` | rollout JSONL files |
| Claude Code | `projects/` | project session JSONL files; `agent-*` subagent transcripts are excluded |
| OpenCode | `opencode.db` or `storage/` | read-only SQLite, plus legacy JSON; SQLite wins on duplicate session IDs |

Prompt-like synthetic records, local command output, tool results, and system metadata are excluded. Token fields retain input, cached input, output, reasoning, and total counts where the source supplies them. Missing fields remain zero rather than being inferred.

## Parsing and cache contract

Source timestamps remain UTC instants. At the start of a read, the configured coding-day boundaries are projected to UTC once and events are filtered with numeric epoch comparisons. The unified analysis layer performs the local-day, hour, and weekday projection needed by JSON metrics; themes do not reinterpret report time semantics. Boundary projection supports IANA timezone offset changes such as daylight saving time.

Codex and Claude Code cache one normalized `FactSet` fragment per session file. Fingerprints include parser version, report scope, path, size, and modification time, so only changed sessions are parsed again. Cold JSONL misses use a bounded worker pool; cache metadata and writes use bounded asynchronous concurrency. OpenCode uses a period-bounded SQLite query and snapshot cache, while legacy JSON uses per-session fragments. `--clean` bypasses reads from all of these caches and refreshes them.

## Canonical tool names

The stable report vocabulary is defined in `src/domain/tools.ts`. `ToolFact.name` is canonical and `ToolFact.rawName` retains the source value.

| Canonical name | Representative source names |
| --- | --- |
| `file.patch` | `apply_patch` |
| `file.edit` | `Edit`, `MultiEdit`, `edit` |
| `file.write` | `Write`, `write` |
| `file.read` | `Read`, `read` |
| `file.search` | `Grep`, `Glob`, `grep`, `glob` |
| `file.list` | `list` |
| `shell.run` | `exec_command`, `Bash`, `bash` |
| `shell.input` | `write_stdin` |
| `web.search` | `WebSearch`, `web_search` |
| `web.fetch` | `WebFetch`, `webfetch` |
| `agent.delegate` | `spawn_agent`, `Task`, `task` |
| `agent.message` | `send_message`, `followup_task` |
| `agent.wait` | `wait_agent` |
| `task.manage` | `update_plan`, `TodoWrite` |
| `user.question` | `AskUserQuestion`, `question` |
| `media.inspect` | `view_image` |
| `mcp.call` | Claude or Codex `mcp__*` calls |
| `code.inspect` | OpenCode `lsp` |
| `other` | unsupported or unknown tools |

Broad categories are derived from the prefix (`file`, `shell`, `web`, and so on). Both canonical-name and category rankings are emitted in `tools.json`.

## Conservative code changes

Structured patches and edits can contribute file paths and changed-line counts. Full-file writes do not claim line additions unless the source explicitly provides a diff. This avoids inflating language shares with ambiguous rewrites. OpenCode prefers `state.metadata.filediff`; Claude Code edit counts use the explicit old and new fragments; Codex parses `apply_patch` sections.

## Adding an adapter

1. Add the parser under `src/input/adapters/` and register its detector and reader in `src/input/agents.ts`.
2. Parse the source into a `FactSet` without adding Agent-specific report fields.
3. Normalize tools through `normalizeTool()` and retain `rawName`.
4. Namespace session IDs with the Agent type and raw session ID, not the input path, so copied logs deduplicate across roots. Keep the root only in source provenance.
5. Keep event timestamps as UTC instants and filter them through the precomputed configured coding-day boundaries.
6. Add fixtures for prompts, models, tokens, tools, tool outcomes, and structured file changes.
7. Verify a combined report proves equivalent tools share one canonical ranking.
