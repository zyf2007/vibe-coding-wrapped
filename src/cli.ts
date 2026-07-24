#!/usr/bin/env node
import { runCli } from "./cli/main.js";

runCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
