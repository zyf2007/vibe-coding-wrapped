import { basename } from "node:path";

export type CanonicalTool = {
  name: string;
  category: string;
  isMutation: boolean;
};

const exact: Record<string, string> = {
  apply_patch: "file.patch", edit: "file.edit", multiedit: "file.edit", write: "file.write",
  read: "file.read", grep: "file.search", glob: "file.search", list: "file.list", lsp: "code.inspect",
  bash: "shell.run", exec_command: "shell.run", write_stdin: "shell.input",
  websearch: "web.search", web_search: "web.search", webfetch: "web.fetch", web_fetch: "web.fetch",
  task: "agent.delegate", spawn_agent: "agent.delegate", send_message: "agent.message", followup_task: "agent.message", wait_agent: "agent.wait",
  todowrite: "task.manage", update_plan: "task.manage", create_goal: "task.manage", update_goal: "task.manage",
  askuserquestion: "user.question", question: "user.question", view_image: "media.inspect",
};

export function normalizeTool(rawName: string): CanonicalTool {
  const raw = rawName.trim();
  const key = raw.toLowerCase().replace(/[\s-]/g, "");
  let name = exact[raw.toLowerCase()] ?? exact[key];
  if (!name && /^(mcp__|mcp\.)/i.test(raw)) name = "mcp.call";
  if (!name && /patch/i.test(raw)) name = "file.patch";
  if (!name && /(?:edit|replace)/i.test(raw)) name = "file.edit";
  if (!name && /(?:read|cat)/i.test(raw)) name = "file.read";
  if (!name && /(?:search|grep|glob|find)/i.test(raw)) name = "file.search";
  if (!name && /(?:exec|shell|command|bash)/i.test(raw)) name = "shell.run";
  name ??= "other";
  const category = name === "other" ? "other" : name.split(".")[0];
  return { name, category, isMutation: ["file.patch", "file.edit", "file.write"].includes(name) };
}

export function isCheckCommand(value: string): boolean {
  return /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)|(?:cargo|go)\s+test|pytest|vitest|jest|tsc(?:\s|$)|gradle\w*\s+(?:test|check|build)|mvn\s+(?:test|verify)|dotnet\s+(?:test|build)|swift\s+test/i.test(value);
}

export function commandFamily(value: string): string | undefined {
  const match = value.trim().match(/^(?:\{[\s\S]*?cmd["']?\s*:\s*["'])?([\w./-]+)/);
  return match?.[1] ? basename(match[1]) : undefined;
}

export function parseExitCode(output: unknown): number | undefined {
  if (output && typeof output === "object") {
    const direct = (output as Record<string, unknown>).exit_code;
    if (typeof direct === "number") return direct;
  }
  const serialized = String(typeof output === "string" ? output : JSON.stringify(output ?? ""));
  const match = serialized.match(/["']?exit_code["']?\s*[:=]\s*(-?\d+)/) ?? serialized.match(/Process exited with code\s+(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}
