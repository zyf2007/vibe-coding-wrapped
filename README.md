# Vibe Coding Wrapped

Local-first CLI that turns Codex, Claude Code, and OpenCode session logs into a versioned JSON report and optional static HTML. Reports support calendar years and months, multiple copied Agent data directories, prompt highlights, tools, models, tokens, code changes, and optional Git activity.

## Install

```bash
npm install -g vibe-coding-wrapped
vibe-wrapped --help
```

After installation, the shortest way to generate and preview the current year's report is:

```bash
vibe-wrapped serve
```

The global installer registers zsh or bash completion when it can identify the current shell. Open a new shell, then type `vibe-wrapped -` and press Tab to browse options with descriptions. Manual activation is also available:

```bash
source <(vibe-wrapped --completion zsh)
# or
source <(vibe-wrapped --completion bash)
```

Set `VIBE_WRAPPED_SKIP_COMPLETION=1` while installing to disable automatic shell configuration.

## Commands

All commands use one report directory. This keeps cached JSON and rendered files together.

```bash
# Generate only REPORT_DIR/*.json
vibe-wrapped build --month 2026-07 -i ~/.codex --out ./wrapped-2026-07

# Reuse those JSON files and turn the same directory into a static site.
# JSON is retained under REPORT_DIR/data/ after rendering.
vibe-wrapped render --theme official --out ./wrapped-2026-07

# Re-render an existing report and start a local preview server.
vibe-wrapped serve --theme compact --port 4173 --out ./wrapped-2026-07

# Bind to a LAN-accessible address with one option
vibe-wrapped serve --bind 0.0.0.0:5173 --out ./wrapped-2026-07
```

For the shortest path to a report, run `vibe-wrapped serve`. It discovers all existing standard Agent directories, reports the current calendar year, writes to `./vibe-wrapped-YYYY`, and starts the static preview. Use `--exclude-input ~/.claude` (repeatable) to omit a detected root.

`render` and `serve` look for a valid bundle in `REPORT_DIR/manifest.json`, then `REPORT_DIR/data/manifest.json`. If neither exists, `render` requires `--year`, `--month`, or `--range`; bare `serve` defaults to the current year:

```bash
vibe-wrapped render --month 2026-07 -i ~/.codex --theme compact --out ./wrapped-2026-07

# Inclusive January through July range
vibe-wrapped render --range 2026.1-2026.7 --out ./wrapped-2026-01-07
```

Use `--clean` when the source logs must be read and analyzed again instead of reusing rendered JSON or the local fact cache:

```bash
vibe-wrapped render --clean --month 2026-07 -i ~/.codex --out ./wrapped-2026-07
```

`serve` is only a local preview convenience. The exported site remains fully static and can be hosted by Nginx, GitHub Pages, Cloudflare Pages, object storage, or any other static host without Node.js or a backend service.

## Inputs

Use repeatable `-i PATH` arguments to combine Agent logs copied from several devices:

```bash
vibe-wrapped build --year 2026 \
  -i ~/.codex \
  -i ~/.claude \
  -i ~/.local/share/opencode \
  -i ./copied-from-laptop/.codex \
  --out ./wrapped-2026
```

The CLI detects the Agent type from each directory. It recognizes Codex homes containing `sessions/`, Claude Code homes containing `projects/`, and OpenCode data directories containing `opencode.db` or `storage/`. An unsupported or missing explicit input prints one path-first error line and is skipped; processing continues with other valid inputs.

Without `-i`, the CLI checks the standard locations for all three Agents: `$CODEX_HOME` or `~/.codex`, `$CLAUDE_CONFIG_DIR` or `~/.claude`, and `$OPENCODE_DB` or `$XDG_DATA_HOME/opencode` (falling back to `~/.local/share/opencode`). Missing default locations are ignored silently.

Events from multiple inputs are deduplicated by stable content identity.

Tool calls are normalized before analysis. For example, Codex `apply_patch`, Claude Code editing tools, and OpenCode tools are represented by stable names such as `file.patch`, `file.edit`, `shell.run`, and `web.fetch`. Reports aggregate these meanings across Agents; Agent type appears only in provenance. See [AGENT_ADAPTERS.md](./AGENT_ADAPTERS.md) for the data contract and mapping table.

## Themes

- `official`: full-screen page-by-page report
- `compact`: continuous, responsive single page for blog embeds
- `--theme PATH`: trusted custom directory containing `index.html`, `app.js`, and `style.css`

Both built-in themes consume the same JSON and use only relative assets. Changing a theme never changes statistical results.

## Privacy

Prompt excerpts are redacted by default. Generated HTML and JSON can still contain private project names and short prompt excerpts, so review a report before publishing it. Use `--privacy metrics-only` to omit prompt text entirely.

## Development

The source tree follows the runtime data flow:

```text
src/cli.ts              executable entrypoint
src/cli/                command parsing and shell completion
src/input/              Agent discovery and adapter registry
src/input/adapters/     source-specific JSONL/SQLite parsers
src/storage/            local cache and persistence concerns
src/domain/             normalized facts, time, IDs, tool semantics
src/analysis/           report calculations, tokenization, Git analysis
src/report/             JSON bundle writing and static theme rendering
src/http/               optional static preview server
```

Dependencies point inward: adapters and analysis consume `domain`; CLI composes the layers; themes consume only the generated JSON bundle. The HTTP server does not participate in analysis or rendering.

```bash
npm install
npm run check
npm run build
```

Requires Node.js 20 or newer.
