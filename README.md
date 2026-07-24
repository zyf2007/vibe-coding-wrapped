# Vibe Coding Wrapped

Local-first CLI that turns Codex session logs into a versioned JSON report and optional static HTML. Reports support calendar years and months, multiple copied Agent data directories, prompt highlights, tools, models, tokens, code changes, and optional Git activity.

## Run with npx

```bash
npx vibe-coding-wrapped build \
  --month 2026-07 \
  -i ~/.codex \
  --out ./wrapped-2026-07
```

`build` produces JSON only. Install globally to use the shorter command and shell completion:

```bash
npm install -g vibe-coding-wrapped
vibe-wrapped --help
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
```

`render` and `serve` look for a valid bundle in `REPORT_DIR/manifest.json`, then `REPORT_DIR/data/manifest.json`. If neither exists, they generate JSON first and therefore require `--year` or `--month`:

```bash
vibe-wrapped render --month 2026-07 -i ~/.codex --theme compact --out ./wrapped-2026-07
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
  -i ./copied-from-laptop/.codex \
  --out ./wrapped-2026
```

The CLI detects the Agent type from each directory. V1 recognizes Codex homes containing a `sessions/` directory. An unsupported or missing input prints one path-first error line and is skipped; processing continues with other valid inputs. Without `-i`, the CLI checks `$CODEX_HOME` and then `~/.codex`.

Events from multiple inputs are deduplicated by stable content identity.

## Themes

- `official`: full-screen page-by-page report
- `compact`: continuous, responsive single page for blog embeds
- `--theme PATH`: trusted custom directory containing `index.html`, `app.js`, and `style.css`

Both built-in themes consume the same JSON and use only relative assets. Changing a theme never changes statistical results.

## Privacy

Prompt excerpts are redacted by default. Generated HTML and JSON can still contain private project names and short prompt excerpts, so review a report before publishing it. Use `--privacy metrics-only` to omit prompt text entirely.

## Development

```bash
npm install
npm run check
npm run build
```

Requires Node.js 20 or newer.
