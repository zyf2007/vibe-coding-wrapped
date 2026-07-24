import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

if (process.env.npm_config_global === "true" && process.env.VIBE_WRAPPED_SKIP_COMPLETION !== "1") {
  const shell = process.env.VIBE_WRAPPED_COMPLETION_SHELL || basename(process.env.SHELL || "");
  const rc = process.env.VIBE_WRAPPED_COMPLETION_RC || (shell === "zsh" ? join(homedir(), ".zshrc") : shell === "bash" ? join(homedir(), ".bashrc") : "");
  if (rc && ["zsh", "bash"].includes(shell)) {
    const marker = "# >>> vibe-wrapped completion >>>";
    let existing = "";
    try {
      existing = await readFile(rc, "utf8");
    } catch {
      // A missing shell rc file will be created below.
    }
    if (!existing.includes(marker)) {
      const block = `\n${marker}\nif command -v vibe-wrapped >/dev/null 2>&1; then\n  source <(vibe-wrapped --completion ${shell})\nfi\n# <<< vibe-wrapped completion <<<\n`;
      await appendFile(rc, block, "utf8");
      console.log(`vibe-wrapped: installed ${shell} completion in ${rc}`);
    }
  }
}
