import type { Bundle, FactSet, Scope } from "./types.js";
import { activeMinute, codingDay, enumerateDays, localDateTime, zonedParts } from "./time.js";
import { analyzeGit } from "./git.js";
import { displayProject, median, metric, percentile, redactText, sortObject, stableId, unavailable } from "./utils.js";

const stopwords = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "then", "请", "一下", "这个", "一个", "可以", "需要", "现在", "还是", "什么", "怎么", "我们", "你", "我", "的", "了", "是", "在", "把", "有", "要", "不", "就", "吗", "吧", "呢"]);
const segmenters = new Map<string, Intl.Segmenter>();

function tokensOf(text: string): string[] {
  let segmenter = segmenters.get("words");
  if (!segmenter) {
    segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    segmenters.set("words", segmenter);
  }
  const result: string[] = [];
  for (const part of segmenter.segment(text.normalize("NFKC"))) {
    const token = part.segment.toLowerCase().trim();
    if (!part.isWordLike || token.length < 2 || token.length > 40 || stopwords.has(token) || /^\d+$/.test(token) || /^(?:https?:|[/\\])/.test(token)) continue;
    result.push(token);
  }
  return result;
}

function projectId(cwd?: string): string {
  return stableId("project", cwd ?? "unknown");
}

function modelId(value?: string): string {
  return value || "unknown";
}

function excerpt(text: string, scope: Scope): string | undefined {
  if (scope.privacy === "metrics-only") return undefined;
  const safe = scope.privacy === "redacted" ? redactText(text) : text.replace(/\s+/g, " ").trim();
  return safe.length > 180 ? `${safe.slice(0, 177)}...` : safe;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
  return result;
}

export async function analyze(facts: FactSet, scope: Scope, gitEnabled: boolean): Promise<Bundle> {
  facts.prompts.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  facts.turns.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  facts.tools.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));

  const dayRows = new Map<string, { prompts: number; turns: number; toolCalls: number; totalTokens: number; fileChanges: number; projects: Set<string>; events: Array<{ at: string; type: string }> }>();
  for (const day of enumerateDays(scope.period)) dayRows.set(day, { prompts: 0, turns: 0, toolCalls: 0, totalTokens: 0, fileChanges: 0, projects: new Set(), events: [] });
  const addDay = (at: string, type: string, cwd?: string, amount = 1) => {
    const day = codingDay(at, scope.timezone, scope.dayStartHour);
    const row = dayRows.get(day);
    if (!row) return;
    if (type === "prompt") row.prompts += amount;
    if (type === "turn") row.turns += amount;
    if (type === "tool") row.toolCalls += amount;
    if (type === "token") row.totalTokens += amount;
    if (type === "change") row.fileChanges += amount;
    if (cwd) row.projects.add(projectId(cwd));
    if (type !== "token") row.events.push({ at: localDateTime(at, scope.timezone), type });
  };
  facts.prompts.forEach((item) => addDay(item.occurredAt, "prompt", item.cwd));
  facts.turns.forEach((item) => addDay(item.occurredAt, "turn", item.cwd));
  facts.tools.forEach((item) => addDay(item.occurredAt, "tool", item.cwd));
  facts.tokens.forEach((item) => addDay(item.occurredAt, "token", undefined, item.total));
  facts.fileChanges.forEach((item) => addDay(item.occurredAt, "change"));
  const calendarDays = [...dayRows.entries()].map(([day, row]) => ({ codingDay: day, prompts: row.prompts, turns: row.turns, toolCalls: row.toolCalls, totalTokens: row.totalTokens, fileChanges: row.fileChanges, projectIds: [...row.projects].sort() }));
  const activeDays = calendarDays.filter((item) => item.prompts > 0);

  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, prompts: 0, turns: 0, toolCalls: 0 }));
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => ({ weekday, prompts: 0, turns: 0, toolCalls: 0 }));
  const weekdayIndex = new Map(weekdays.map((item, index) => [item.weekday, index]));
  const addTime = (at: string, field: "prompts" | "turns" | "toolCalls") => {
    const parts = zonedParts(at, scope.timezone);
    hourly[parts.hour][field] += 1;
    const index = weekdayIndex.get(parts.weekday);
    if (index !== undefined) weekdays[index][field] += 1;
  };
  facts.prompts.forEach((item) => addTime(item.occurredAt, "prompts"));
  facts.turns.forEach((item) => addTime(item.occurredAt, "turns"));
  facts.tools.forEach((item) => addTime(item.occurredAt, "toolCalls"));

  const periodCount = countBy(activeDays, (item) => scope.period.kind === "year" ? item.codingDay.slice(0, 7) : `week-${Math.ceil(Number(item.codingDay.slice(8, 10)) / 7)}`);
  const activity = {
    calendar: { days: metric("activity.calendar", calendarDays, facts.prompts.length, 1, "direct") },
    byHour: metric("activity.by_hour", hourly, facts.prompts.length, 1),
    byWeekday: metric("activity.by_weekday", weekdays, facts.prompts.length, 1),
    periodBuckets: metric("activity.period_buckets", sortObject(periodCount), activeDays.length, 1),
    dayTimelines: Object.fromEntries([...dayRows.entries()].filter(([, row]) => row.events.length).map(([day, row]) => [day, row.events.sort((a, b) => a.at.localeCompare(b.at))])),
  };

  const lengths = facts.prompts.map((item) => [...item.text].length);
  const promptTerms = new Map<string, { count: number; prompts: Set<string> }>();
  const structureCounts: Record<string, number> = { list: 0, codeBlock: 0, path: 0, log: 0, attachment: 0 };
  const languageCounts: Record<string, number> = { zh: 0, en: 0, mixed: 0 };
  for (const prompt of facts.prompts) {
    const flags = { list: /(?:^|\n)\s*(?:[-*]|\d+[.)])\s/m.test(prompt.text), codeBlock: /```/.test(prompt.text), path: /(?:^|\s)(?:\.?\.?\/|~\/|[A-Za-z]:\\)[^\s]+/.test(prompt.text), log: /(?:error|exception|traceback|报错|日志)/i.test(prompt.text), attachment: /<image|attachment|截图|图片/i.test(prompt.text) };
    for (const [key, value] of Object.entries(flags)) if (value) structureCounts[key] += 1;
    const hasZh = /\p{Script=Han}/u.test(prompt.text);
    const hasEn = /[A-Za-z]{2}/.test(prompt.text);
    languageCounts[hasZh && hasEn ? "mixed" : hasZh ? "zh" : "en"] += 1;
    for (const term of new Set(tokensOf(prompt.text))) {
      const value = promptTerms.get(term) ?? { count: 0, prompts: new Set<string>() };
      value.count += tokensOf(prompt.text).filter((item) => item === term).length;
      value.prompts.add(prompt.id);
      promptTerms.set(term, value);
    }
  }
  const frequentTerms = [...promptTerms.entries()].map(([term, value]) => ({ term, count: value.count, promptCount: value.prompts.size })).sort((a, b) => b.count - a.count || b.promptCount - a.promptCount || a.term.localeCompare(b.term)).slice(0, 100).map((item, rank) => ({ rank: rank + 1, ...item }));
  const promptsByModel = Object.entries(countBy(facts.prompts, (item) => modelId(item.modelId))).map(([id, count]) => ({ modelId: id, prompts: count, medianChars: median(facts.prompts.filter((item) => modelId(item.modelId) === id).map((item) => [...item.text].length)) })).sort((a, b) => b.prompts - a.prompts || a.modelId.localeCompare(b.modelId));
  const firstPrompt = facts.prompts[0];
  const prompts = {
    firstInPeriod: firstPrompt ? metric("prompts.first_in_period", { occurredAt: firstPrompt.occurredAt, localDateTime: localDateTime(firstPrompt.occurredAt, scope.timezone), codingDay: codingDay(firstPrompt.occurredAt, scope.timezone, scope.dayStartHour), excerpt: excerpt(firstPrompt.text, scope), charCount: [...firstPrompt.text].length, projectId: projectId(firstPrompt.cwd) }, 1, 1, "direct") : unavailable("prompts.first_in_period", "insufficient_data", "no_prompts"),
    length: metric("prompts.length", { median: median(lengths), p90: percentile(lengths, 0.9), max: Math.max(0, ...lengths) }, lengths.length, 1),
    structure: metric("prompts.structure", Object.fromEntries(Object.entries(structureCounts).map(([key, count]) => [key, { count, rate: facts.prompts.length ? count / facts.prompts.length : 0 }])), facts.prompts.length, 1),
    contextSignals: metric("prompts.context_signals", { path: structureCounts.path, log: structureCounts.log, attachment: structureCounts.attachment }, facts.prompts.length, 1),
    languageMix: metric("prompts.language_mix", languageCounts, facts.prompts.length, 1),
    terms: { frequent: metric("prompts.frequent_terms", frequentTerms, facts.prompts.length, 1), languageGroups: ["all"], stopwordVersion: "v1" },
    sessionDepth: metric("prompts.session_depth", { median: median(Object.values(countBy(facts.prompts, (item) => item.sessionId))), p90: percentile(Object.values(countBy(facts.prompts, (item) => item.sessionId)), 0.9) }, facts.sessions.length, 1),
    byModel: promptsByModel,
  };

  const projectMap = new Map<string, { projectId: string; displayName: string; prompts: number; turns: number; toolCalls: number; totalTokens: number; filesChanged: number; firstAt: string; lastAt: string }>();
  const ensureProject = (cwd: string | undefined, at: string) => {
    const id = projectId(cwd);
    let item = projectMap.get(id);
    if (!item) {
      item = { projectId: id, displayName: displayProject(cwd), prompts: 0, turns: 0, toolCalls: 0, totalTokens: 0, filesChanged: 0, firstAt: at, lastAt: at };
      projectMap.set(id, item);
    }
    if (at < item.firstAt) item.firstAt = at;
    if (at > item.lastAt) item.lastAt = at;
    return item;
  };
  facts.prompts.forEach((item) => ensureProject(item.cwd, item.occurredAt).prompts += 1);
  facts.turns.forEach((item) => ensureProject(item.cwd, item.occurredAt).turns += 1);
  facts.tools.forEach((item) => ensureProject(item.cwd, item.occurredAt).toolCalls += 1);
  const turnCwd = new Map(facts.turns.map((item) => [`${item.sessionId}:${item.id}`, item.cwd]));
  facts.tokens.forEach((item) => ensureProject(turnCwd.get(`${item.sessionId}:${stableId("turn", `${item.sessionId}:${item.turnId}`)}`), item.occurredAt).totalTokens += item.total);
  facts.fileChanges.forEach((item) => ensureProject(facts.tools.find((tool) => tool.callId === item.callId)?.cwd, item.occurredAt).filesChanged += 1);
  const projectItems = [...projectMap.values()].sort((a, b) => b.prompts - a.prompts || b.totalTokens - a.totalTokens || a.projectId.localeCompare(b.projectId)).map((item, rank) => ({ rank: rank + 1, ...item }));
  const projects = { items: metric("projects.items", projectItems, projectItems.length, 1), timeline: projectItems.map((item) => ({ projectId: item.projectId, firstAt: item.firstAt, lastAt: item.lastAt, prompts: item.prompts })), byDay: Object.fromEntries(calendarDays.map((day) => [day.codingDay, day.projectIds])), crossSourceMerges: metric("projects.cross_source_merges", 0, projectItems.length, 1, "direct") };

  const linkedToolCount = facts.tools.filter((item) => item.turnId && facts.prompts.some((prompt) => prompt.turnId === item.turnId)).length;
  const toolsByTurn = new Map<string, typeof facts.tools>();
  for (const tool of facts.tools) {
    if (!tool.turnId) continue;
    const list = toolsByTurn.get(tool.turnId) ?? [];
    list.push(tool);
    toolsByTurn.set(tool.turnId, list);
  }
  const motifs = countBy([...toolsByTurn.values()].filter((items) => items.length >= 2), (items) => items.map((item) => item.category).join(" -> "));
  const mutationTurns = [...toolsByTurn.values()].filter((items) => items.some((item) => item.isMutation));
  const checkedMutationTurns = mutationTurns.filter((items) => {
    const firstMutation = items.findIndex((item) => item.isMutation);
    return items.slice(firstMutation + 1).some((item) => item.isCheckInvocation);
  }).length;
  const outcomeTools = facts.tools.filter((item) => item.exitCode !== undefined);
  const toolsByModel = Object.entries(countBy(facts.tools, (item) => modelId(item.modelId))).map(([id, count]) => ({ modelId: id, toolCalls: count, checkInvocations: facts.tools.filter((item) => modelId(item.modelId) === id && item.isCheckInvocation).length })).sort((a, b) => b.toolCalls - a.toolCalls || a.modelId.localeCompare(b.modelId));
  const tools = {
    totals: metric("tools.totals", { calls: facts.tools.length, turnsWithTools: toolsByTurn.size, checkInvocations: facts.tools.filter((item) => item.isCheckInvocation).length }, facts.tools.length, 1, "direct"),
    categories: metric("tools.categories", sortObject(countBy(facts.tools, (item) => item.category)).map((item, rank) => ({ rank: rank + 1, category: item.id, count: item.count })), facts.tools.length, 1),
    linkedPrompt: metric("tools.linked_prompt", { linkedCalls: linkedToolCount, totalCalls: facts.tools.length, medianCallsPerLinkedPrompt: median([...toolsByTurn.values()].map((items) => items.length)) }, facts.tools.length, facts.tools.length ? linkedToolCount / facts.tools.length : 0),
    sequenceMotifs: metric("tools.sequence_motifs", sortObject(motifs).slice(0, 20).map((item, rank) => ({ rank: rank + 1, sequence: item.id.split(" -> "), count: item.count })), toolsByTurn.size, facts.tools.length ? linkedToolCount / facts.tools.length : 0),
    postChangeChecks: metric("tools.post_change_checks", { checkedTurns: checkedMutationTurns, mutationTurns: mutationTurns.length, rate: mutationTurns.length ? checkedMutationTurns / mutationTurns.length : 0 }, mutationTurns.length, linkedToolCount / Math.max(1, facts.tools.length)),
    outcomes: metric("tools.outcomes", { exitCodes: sortObject(countBy(outcomeTools, (item) => String(item.exitCode))), observed: outcomeTools.length, total: facts.tools.length }, facts.tools.length, facts.tools.length ? outcomeTools.length / facts.tools.length : 0, "direct"),
    subagents: metric("tools.subagents", { spawnCalls: facts.tools.filter((item) => /spawn_agent/.test(item.name)).length, waitCalls: facts.tools.filter((item) => /wait_agent/.test(item.name)).length }, facts.tools.length, 1, "direct"),
    byModel: toolsByModel,
  };

  const languageMap = new Map<string, { added: number; deleted: number; files: Set<string> }>();
  for (const change of facts.fileChanges) {
    const value = languageMap.get(change.language) ?? { added: 0, deleted: 0, files: new Set<string>() };
    value.added += change.added;
    value.deleted += change.deleted;
    value.files.add(change.path);
    languageMap.set(change.language, value);
  }
  const totalAdded = facts.fileChanges.reduce((sum, item) => sum + item.added, 0);
  const totalDeleted = facts.fileChanges.reduce((sum, item) => sum + item.deleted, 0);
  const languages = [...languageMap.entries()].map(([language, value]) => ({ languageId: language, language, addedLines: value.added, deletedLines: value.deleted, files: value.files.size, share: totalAdded ? value.added / totalAdded : 0 })).sort((a, b) => b.addedLines - a.addedLines || a.language.localeCompare(b.language)).map((item, rank) => ({ rank: rank + 1, ...item }));
  const changeTrend = Object.entries(countBy(facts.fileChanges, (item) => codingDay(item.occurredAt, scope.timezone, scope.dayStartHour))).map(([day, count]) => ({ codingDay: day, changes: count, addedLines: facts.fileChanges.filter((item) => codingDay(item.occurredAt, scope.timezone, scope.dayStartHour) === day).reduce((sum, item) => sum + item.added, 0) })).sort((a, b) => a.codingDay.localeCompare(b.codingDay));
  const code = {
    totals: metric("code.totals", { changes: facts.fileChanges.length, files: new Set(facts.fileChanges.map((item) => item.path)).size, addedLines: totalAdded, deletedLines: totalDeleted }, facts.fileChanges.length, 1, "direct"),
    trend: metric("code.trend", changeTrend, facts.fileChanges.length, 1),
    attributionCoverage: metric("code.attribution_coverage", { structuredChanges: facts.fileChanges.length, toolCalls: facts.tools.length, rate: facts.tools.length ? facts.fileChanges.length / facts.tools.length : 0 }, facts.tools.length, 1),
    changeRadius: metric("code.change_radius", { medianFilesPerMutationTurn: median(mutationTurns.map((items) => new Set(facts.fileChanges.filter((change) => items.some((item) => item.callId === change.callId)).map((item) => item.path)).size)) }, mutationTurns.length, 1),
    languages: metric("code.languages", languages, totalAdded, totalAdded ? (totalAdded - (languageMap.get("Unknown")?.added ?? 0)) / totalAdded : 0),
    languageByProject: [],
    byModel: Object.entries(countBy(facts.fileChanges, (item) => modelId(item.modelId))).map(([id, count]) => ({ modelId: id, changes: count, addedLines: facts.fileChanges.filter((item) => modelId(item.modelId) === id).reduce((sum, item) => sum + item.added, 0) })).sort((a, b) => b.addedLines - a.addedLines),
  };

  const modelCounts = countBy(facts.turns, (item) => modelId(item.modelId));
  const modelItems = Object.entries(modelCounts).map(([id, count]) => ({ modelId: id, displayName: id, turns: count, sessions: new Set(facts.turns.filter((item) => modelId(item.modelId) === id).map((item) => item.sessionId)).size })).sort((a, b) => b.turns - a.turns || a.modelId.localeCompare(b.modelId)).map((item, rank) => ({ rank: rank + 1, ...item }));
  const transitions: Record<string, number> = {};
  const turnsBySession = new Map<string, typeof facts.turns>();
  for (const turn of facts.turns) { const list = turnsBySession.get(turn.sessionId) ?? []; list.push(turn); turnsBySession.set(turn.sessionId, list); }
  for (const list of turnsBySession.values()) for (let index = 1; index < list.length; index += 1) if (list[index - 1].modelId !== list[index].modelId) { const key = `${list[index - 1].modelId} -> ${list[index].modelId}`; transitions[key] = (transitions[key] ?? 0) + 1; }
  const modelByHour = new Map<string, Record<string, number>>();
  const modelByWeekday = new Map<string, Record<string, number>>();
  for (const turn of facts.turns) {
    const parts = zonedParts(turn.occurredAt, scope.timezone);
    const hour = String(parts.hour).padStart(2, "0");
    const hourRow = modelByHour.get(hour) ?? {}; hourRow[turn.modelId] = (hourRow[turn.modelId] ?? 0) + 1; modelByHour.set(hour, hourRow);
    const weekRow = modelByWeekday.get(parts.weekday) ?? {}; weekRow[turn.modelId] = (weekRow[turn.modelId] ?? 0) + 1; modelByWeekday.set(parts.weekday, weekRow);
  }
  const models = {
    items: metric("models.items", modelItems, facts.turns.length, 1, "direct"),
    byHour: metric("models.by_hour", [...modelByHour.entries()].map(([hour, values]) => ({ hour: Number(hour), values })), facts.turns.length, 1),
    byWeekday: metric("models.by_weekday", [...modelByWeekday.entries()].map(([weekday, values]) => ({ weekday, values })), facts.turns.length, 1),
    byProject: [],
    efforts: metric("models.efforts", sortObject(countBy(facts.turns, (item) => item.effort ?? "unknown")), facts.turns.length, 1, "direct"),
    transitions: metric("models.transitions", sortObject(transitions).map((item) => { const [from, to] = item.id.split(" -> "); return { from, to, count: item.count }; }), facts.turns.length, 1),
  };

  const tokenTotals = facts.tokens.reduce((sum, item) => ({ input: sum.input + item.input, cachedInput: sum.cachedInput + item.cachedInput, output: sum.output + item.output, reasoning: sum.reasoning + item.reasoning, total: sum.total + item.total }), { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 });
  const tokenDays = new Map<string, typeof tokenTotals>();
  for (const item of facts.tokens) { const day = codingDay(item.occurredAt, scope.timezone, scope.dayStartHour); const row = tokenDays.get(day) ?? { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }; row.input += item.input; row.cachedInput += item.cachedInput; row.output += item.output; row.reasoning += item.reasoning; row.total += item.total; tokenDays.set(day, row); }
  const byModelTokens = new Map<string, typeof tokenTotals>();
  for (const item of facts.tokens) { const id = modelId(item.modelId); const row = byModelTokens.get(id) ?? { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }; row.input += item.input; row.cachedInput += item.cachedInput; row.output += item.output; row.reasoning += item.reasoning; row.total += item.total; byModelTokens.set(id, row); }
  const tokens = {
    totals: metric("tokens.totals", tokenTotals, facts.tokens.length, 1, "direct"),
    trend: metric("tokens.trend", [...tokenDays.entries()].map(([day, values]) => ({ codingDay: day, ...values })).sort((a, b) => a.codingDay.localeCompare(b.codingDay)), facts.tokens.length, 1),
    byModel: metric("tokens.by_model", [...byModelTokens.entries()].map(([id, values]) => ({ modelId: id, ...values })).sort((a, b) => b.total - a.total), facts.tokens.length, 1),
    byProject: [],
    cacheRatio: metric("tokens.cache_ratio", tokenTotals.input ? tokenTotals.cachedInput / tokenTotals.input : 0, facts.tokens.length, 1),
    costEstimate: unavailable("tokens.cost_estimate", "unsupported", "no_versioned_price_table"),
  };

  const promptMinutes = facts.prompts.map((item) => ({ item, minute: activeMinute(item.occurredAt, scope.timezone, scope.dayStartHour) }));
  const earliest = [...promptMinutes].sort((a, b) => a.minute - b.minute || a.item.occurredAt.localeCompare(b.item.occurredAt))[0];
  const latest = [...promptMinutes].sort((a, b) => b.minute - a.minute || a.item.occurredAt.localeCompare(b.item.occurredAt))[0];
  const busiest = [...calendarDays].sort((a, b) => b.prompts - a.prompts || b.totalTokens - a.totalTokens || a.codingDay.localeCompare(b.codingDay))[0];
  let longestStreak = { days: 0, start: "", end: "" }; let currentStreak = { days: 0, start: "", end: "" };
  for (const day of calendarDays) { if (day.prompts > 0) { if (!currentStreak.days) currentStreak.start = day.codingDay; currentStreak.days += 1; currentStreak.end = day.codingDay; if (currentStreak.days > longestStreak.days) longestStreak = { ...currentStreak }; } else currentStreak = { days: 0, start: "", end: "" }; }
  const records = {
    earliestActivity: earliest ? metric("records.earliest_activity", { occurredAt: earliest.item.occurredAt, localDateTime: localDateTime(earliest.item.occurredAt, scope.timezone), codingDay: codingDay(earliest.item.occurredAt, scope.timezone, scope.dayStartHour), activeMinute: earliest.minute, excerpt: excerpt(earliest.item.text, scope) }, facts.prompts.length, 1, "direct") : unavailable("records.earliest_activity", "insufficient_data", "no_prompts"),
    latestActivity: latest ? metric("records.latest_activity", { occurredAt: latest.item.occurredAt, localDateTime: localDateTime(latest.item.occurredAt, scope.timezone), codingDay: codingDay(latest.item.occurredAt, scope.timezone, scope.dayStartHour), activeMinute: latest.minute, excerpt: excerpt(latest.item.text, scope) }, facts.prompts.length, 1, "direct") : unavailable("records.latest_activity", "insufficient_data", "no_prompts"),
    busiestDay: busiest ? metric("records.busiest_day", busiest, activeDays.length, 1) : unavailable("records.busiest_day", "insufficient_data", "no_active_days"),
    longestStreak: metric("records.longest_streak", longestStreak, activeDays.length, 1),
    longestGap: unavailable("records.longest_gap", "unsupported", "not_implemented_v1"),
    longestSession: unavailable("records.longest_session", "unsupported", "not_implemented_v1"),
  };

  const git = await analyzeGit(facts, scope, gitEnabled);
  const featuredFacts = [
    { id: "active-days", metricRef: "overview.totals.activeDays", factKind: "count", value: metric("overview.active_days", activeDays.length, facts.prompts.length, 1), messageKey: "active_days" },
    { id: "longest-streak", metricRef: "records.longestStreak", factKind: "record", value: records.longestStreak, messageKey: "longest_streak" },
    ...(languages[0] ? [{ id: "top-language", metricRef: "code.languages.0", factKind: "top_item", subjectId: languages[0].languageId, value: metric("overview.top_language", languages[0].language, totalAdded, code.languages.coverage), messageKey: "top_language" }] : []),
  ];
  const overview = {
    totals: metric("overview.totals", { prompts: facts.prompts.length, turns: facts.turns.length, sessions: new Set(facts.prompts.map((item) => item.sessionId)).size, activeDays: activeDays.length, toolCalls: facts.tools.length, totalTokens: tokenTotals.total, filesChanged: new Set(facts.fileChanges.map((item) => item.path)).size, addedLines: totalAdded }, facts.prompts.length, 1, "direct"),
    averages: { promptsPerActiveDay: metric("overview.prompts_per_active_day", activeDays.length ? facts.prompts.length / activeDays.length : 0, activeDays.length, 1) },
    featuredFacts,
    availableSections: ["activity", "prompts", "projects", "tools", "code", "models", "tokens", ...(git.availability === "available" ? ["git"] : [])],
  };

  const definitions = Object.fromEntries(["overview.totals", "activity.calendar", "prompts.first_in_period", "prompts.frequent_terms", "tools.linked_prompt", "tools.post_change_checks", "code.languages", "models.transitions", "tokens.totals", "git.commit_trend", "records.longest_streak"].map((id) => [id, { id, methodVersion: "v1.0.0", evidence: id.includes("totals") ? "direct" : "structural_derived" }]));
  const provenance = {
    sources: facts.sourceIds.map((id) => ({ sourceId: id, adapterId: "codex" })),
    coverage: { scannedFiles: facts.scannedFiles, scannedBytes: facts.scannedBytes, firstEventAt: facts.prompts[0]?.occurredAt, lastEventAt: facts.prompts.at(-1)?.occurredAt },
    diagnostics: { count: facts.diagnostics.length, byCode: sortObject(countBy(facts.diagnostics, (item) => item.code)) },
    producers: { activity: { version: "1.0.0" }, prompts: { version: "1.0.0", tokenizer: "Intl.Segmenter" }, tools: { version: "1.0.0" }, code: { version: "1.0.0", languageMap: "builtin-v1" }, models: { version: "1.0.0" }, tokens: { version: "1.0.0" }, git: { version: "1.0.0" } },
    definitions,
    nodeStatus: { activity: "ok", prompts: "ok", projects: "ok", tools: "ok", code: "ok", models: "ok", tokens: "ok", git: git.availability },
  };

  const manifest = {
    $schema: "https://vibe-wrapped.dev/schemas/bundle-manifest-1.0.json",
    bundleSchemaVersion: "1.0.0",
    generator: { name: "vibe-coding-wrapped", version: "0.1.0", analyzerVersion: "1.0.0" },
    report: { period: scope.period, timezone: scope.timezone, dayStartHour: scope.dayStartHour, agentScope: ["codex"], sourceScope: { count: facts.sourceIds.length }, generatedAt: new Date().toISOString() },
    privacy: { mode: scope.privacy, containsPromptExcerpts: scope.privacy !== "metrics-only" },
    capabilities: { prompts: true, tokenUsage: facts.tokens.length > 0, toolCalls: facts.tools.length > 0, codeChanges: facts.fileChanges.length > 0, gitHistory: git.availability === "available" },
    files: [],
  };
  return { manifest, overview, activity, prompts, projects, tools, code, models, tokens, git, records, provenance };
}
