# Vibe Coding Wrapped

Local-first CLI for generating a versioned JSON report bundle and a static, hostable Codex activity report.

## Quick start

```bash
npm install
npm run build
node dist/cli.js build --month 2026-07 --codex-home ~/.codex --out ./output/july
```

The CLI writes the machine-readable bundle to the selected bundle directory. `render` turns an existing bundle into a static site that does not need a backend.

```bash
node dist/cli.js generate --month 2026-07 --out ./output/july-json
node dist/cli.js render ./output/july-json --out ./output/july-site
```

The built-in Chinese/English stopword list removes conversational filler from keyword statistics. Add personal exclusions with repeated options such as `--exclude-word 然后 --exclude-word 应该`.

Use repeated `--codex-home PATH` arguments to merge logs copied from multiple devices. Events are deduplicated by stable content identity.

Parsed report facts are cached under the platform cache directory using source file size/mtime fingerprints. An unchanged snapshot is reused without reopening JSONL contents; any changed session invalidates that snapshot.

## Privacy

Prompt excerpts are redacted by default. The generated HTML and JSON may still contain private project names and short prompt excerpts, so review the output before publishing it.

See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for metric definitions and architecture.
