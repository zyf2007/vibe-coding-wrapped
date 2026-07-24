const files = ["manifest", "overview", "activity", "prompts", "projects", "tools", "code", "models", "tokens", "git", "records", "provenance"];
const number = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const precise = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const colors = ["#ef5b42", "#167d68", "#e5b52d", "#4b64b5", "#aa4d79", "#6d6b64", "#1f988b", "#d27d2d"];

function value(metric, fallback = undefined) { return metric?.availability === "available" ? metric.value : fallback; }
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; }
function append(parent, ...children) { for (const child of children.flat()) if (child) parent.append(child); return parent; }
function format(value) { return typeof value === "number" ? number.format(value) : value ?? "--"; }
function percent(value) { return `${precise.format((value || 0) * 100)}%`; }
function dateText(value) { if (!value) return "--"; const [date, time] = value.split("T"); return `${date.slice(5).replace("-", "月")}日 ${time || ""}`; }

function page(id, kicker, title, tone = "") {
  const root = node("section", `page ${tone}`.trim());
  root.dataset.pageId = id;
  const head = node("header");
  append(head, node("p", "kicker", kicker), node("h2", "", title));
  root.append(head);
  return root;
}

function foot(root, text, bundle) {
  const meta = node("footer", "foot");
  append(meta, node("span", "", text), node("span", "", `${bundle.manifest.report.timezone} · 统计日 ${String(bundle.manifest.report.dayStartHour).padStart(2, "0")}:00 开始`));
  root.append(meta);
}

function metricRow(items) {
  const row = node("div", "metric-row");
  for (const [label, result] of items) {
    const item = node("div", "metric");
    append(item, node("strong", "", format(result)), node("span", "", label));
    row.append(item);
  }
  return row;
}

function memoryQuotes(items) {
  const quotes = node("div", "memory-quotes");
  items.filter((item) => item?.record).forEach((item) => {
    const quote = node("article");
    append(quote, node("p", "kicker", item.label), node("blockquote", "", item.record.excerpt || `${item.record.charCount} 字 Prompt`), node("small", "", dateText(item.record.localDateTime)));
    quotes.append(quote);
  });
  return quotes;
}

function ranked(items, nameKey, valueKey, limit = 8) {
  const list = node("div", "rank-list");
  items.slice(0, limit).forEach((item, index) => {
    const row = node("div", "rank");
    append(row, node("span", "", String(index + 1).padStart(2, "0")), node("span", "name", item[nameKey]), node("span", "value", format(item[valueKey])));
    list.append(row);
  });
  return list;
}

function cover(bundle) {
  const root = node("section", "page dark"); root.dataset.pageId = "cover";
  const head = node("header");
  append(head, node("p", "kicker", "VIBE CODING WRAPPED · CODEX"), node("h1", "", bundle.manifest.report.period.value));
  const totals = value(bundle.overview.totals, {});
  const body = node("div"); append(body, node("p", "lede", "这一周期，提示词、工具调用与代码变更在本地日志里留下了可复现的轨迹。"), metricRow([["条提示词", totals.prompts], ["个活跃日", totals.activeDays], ["次工具调用", totals.toolCalls]]));
  root.append(head, body);
  foot(root, bundle.manifest.report.period.kind === "month" ? "月度回顾" : "年度回顾", bundle);
  return root;
}

function origin(bundle) {
  const root = page("origin", "ORIGIN", "从第一句话开始", "red");
  const first = value(bundle.prompts.firstInPeriod);
  root.append(first ? node("blockquote", "quote", first.excerpt || `第一条提示词，共 ${first.charCount} 字`) : node("p", "empty", "本周期没有可用提示词"));
  foot(root, first ? `${dateText(first.localDateTime)} · ${first.charCount} 字` : "数据不足", bundle);
  return root;
}

function scale(bundle) {
  const root = page("scale", "SCALE", "这个周期有多大", "dark"); const totals = value(bundle.overview.totals, {});
  const body = node("div"); append(body, node("div", "hero-number", format(totals.prompts || 0)), node("div", "hero-label", "条真实用户提示词"));
  root.append(body, metricRow([["turn", totals.turns], ["session", totals.sessions], ["Token", totals.totalTokens], ["新增行", totals.addedLines]]));
  return root;
}

function calendar(bundle) {
  const root = page("calendar", "TIME / 01", "编程日历", "green"); const days = value(bundle.activity.calendar.days, []); const max = Math.max(1, ...days.map((item) => item.prompts));
  const grid = node("div", "calendar"); grid.style.setProperty("--columns", bundle.manifest.report.period.kind === "year" ? "53" : "31");
  days.forEach((day) => { const cell = node("i", "day"); cell.style.setProperty("--level", String(Math.ceil((day.prompts / max) * 8))); cell.dataset.label = `${day.codingDay} · ${day.prompts} prompts`; grid.append(cell); });
  root.append(grid); const streak = value(bundle.records.longestStreak, {}); foot(root, `${days.filter((item) => item.prompts).length} 个活跃日 · 最长连续 ${streak.days || 0} 天`, bundle); return root;
}

function peakDay(bundle) {
  const root = page("peak-day", "TIME / 02", "最投入的一天"); const busiest = value(bundle.records.busiestDay); if (!busiest) { root.append(node("p", "empty", "数据不足")); return root; }
  const events = bundle.activity.dayTimelines[busiest.codingDay] || []; const hours = Array.from({ length: 24 }, () => 0); events.forEach((event) => { const hour = Number(event.at.split("T")[1]?.slice(0, 2)); if (Number.isFinite(hour)) hours[hour] += 1; }); const max = Math.max(1, ...hours);
  const timeline = node("div", "timeline"); hours.forEach((count) => { const bar = node("i"); bar.style.setProperty("--value", String(Math.max(1, count / max * 100))); timeline.append(bar); });
  const dayPrompts = value(bundle.records.busiestDayPrompts, {});
  root.append(timeline, metricRow([["日期", busiest.codingDay], ["提示词", busiest.prompts], ["工具调用", busiest.toolCalls], ["Token", busiest.totalTokens]]), memoryQuotes([{ label: "这一天从这里开始", record: dayPrompts.first }, { label: "这一天停在这里", record: dayPrompts.last }])); return root;
}

function clock(bundle) {
  const root = page("clock", "TIME / 03", "你的 24 小时", "dark"); const hours = value(bundle.activity.byHour, []); const max = Math.max(1, ...hours.map((item) => item.prompts)); const bars = node("div", "bars");
  hours.forEach((item) => { const wrap = node("div"); const bar = node("i"); bar.style.setProperty("--value", String(Math.max(1, item.prompts / max * 100))); wrap.append(bar); if (item.hour % 4 === 0) wrap.append(node("small", "", String(item.hour).padStart(2, "0"))); bars.append(wrap); });
  const earliest = value(bundle.records.earliestActivity); const latest = value(bundle.records.latestActivity); root.append(bars, memoryQuotes([{ label: `最早 ${earliest?.localDateTime?.slice(11) || "--"} 开始`, record: earliest }, { label: `最晚 ${latest?.localDateTime?.slice(11) || "--"} 还在输入`, record: latest }])); foot(root, `最早 ${dateText(earliest?.localDateTime)} · 最晚 ${dateText(latest?.localDateTime)}`, bundle); return root;
}

function rhythm(bundle) {
  const root = page("rhythm", "TIME / 04", "星期与连续性", "yellow"); const weekdays = value(bundle.activity.byWeekday, []); root.append(ranked(weekdays.sort((a,b) => b.prompts-a.prompts), "weekday", "prompts", 7)); const streak = value(bundle.records.longestStreak, {}); const gap = value(bundle.records.longestGap); if (gap) root.append(memoryQuotes([{ label: `沉寂 ${gap.days} 天后，你从这句话回来`, record: gap.returnPrompt }])); foot(root, `最长连续活跃 ${streak.days || 0} 天 · ${streak.start || "--"} 至 ${streak.end || "--"}`, bundle); return root;
}

function promptStyle(bundle) {
  const root = page("prompt-style", "EXPRESSION / 01", "你如何写 Prompt"); const length = value(bundle.prompts.length, {}); const structure = value(bundle.prompts.structure, {}); const languages = value(bundle.prompts.languageMix, {});
  root.append(metricRow([["中位字数", length.median], ["P90 字数", length.p90], ["含列表", percent(structure.list?.rate)], ["含代码块", percent(structure.codeBlock?.rate)], ["中英混合", languages.mixed]]));
  const labels = { longest: "最长 Prompt", most_structured: "结构最丰富", most_context_rich: "上下文最丰富", keyword_dense: "高频词最集中" };
  const records = node("div", "prompt-records");
  value(bundle.prompts.notable, []).forEach((item) => { const record = node("article", "prompt-record"); append(record, node("p", "kicker", labels[item.kind] || item.kind), node("p", "prompt-excerpt", item.excerpt || `${item.charCount} 字`), node("small", "", `${dateText(item.localDateTime)} · ${item.charCount} 字`)); records.append(record); });
  root.append(records);
  foot(root, "仅统计长度、结构与上下文信号，不评价 Prompt 好坏", bundle); return root;
}

function words(bundle) {
  const root = page("words", "EXPRESSION / 02", "你最常说的话", "yellow"); const terms = value(bundle.prompts.terms.frequent, []).slice(0, 32); const contexts = value(bundle.prompts.terms.keywordContexts, []); const contextByTerm = new Map(contexts.map((item) => [item.term, item])); const max = Math.max(1, ...terms.map((item) => item.count));
  const stage = node("div", "word-stage"); const cloud = node("div", "words"); const detail = node("aside", "word-context");
  const showContext = (term) => { const item = contextByTerm.get(term); detail.replaceChildren(); append(detail, node("p", "kicker", `关键词原文 · ${term}`), node("blockquote", "", item?.representative?.excerpt || "当前隐私模式不包含原文"), node("small", "", item ? `${item.count} 次 · 出现在 ${item.promptCount} 条 Prompt · ${dateText(item.representative.localDateTime)}` : "暂无代表片段")); };
  terms.forEach((item, index) => { const word = node("button", "", item.term); word.style.setProperty("--weight", String(Math.max(1, Math.round(item.count / max * 8)))); word.title = `${item.count} 次 · ${item.promptCount} 条 Prompt`; word.addEventListener("click", () => showContext(item.term)); cloud.append(word); if (index === 0) showContext(item.term); });
  append(stage, cloud, detail); root.append(stage);
  const sentences = value(bundle.prompts.keySentences, []).slice(0, 3); if (sentences.length) { const repeated = node("div", "sentence-strip"); sentences.forEach((item) => append(repeated, node("span", "", `“${item.sentence || `${item.charCount} 字句子`}” × ${item.promptCount}`))); root.append(repeated); }
  const customExcludedCount = (bundle.prompts.terms.customExcludedWords || []).length; foot(root, `${terms.length} 个高频词 · ${bundle.prompts.terms.stopwordVersion}${customExcludedCount ? ` · 自定义排除 ${customExcludedCount} 个` : ""}`, bundle); return root;
}

function projects(bundle) {
  const root = page("projects", "WORKSPACE / 01", "项目宇宙", "dark"); const items = value(bundle.projects.items, []); root.append(ranked(items, "displayName", "prompts", 10)); foot(root, `${items.length} 个可识别项目 · 项目名已移除绝对路径`, bundle); return root;
}

function tools(bundle) {
  const root = page("tools", "WORKSPACE / 02", "工具足迹", "green"); const categories = value(bundle.tools.categories, []); const linked = value(bundle.tools.linkedPrompt, {}); const checks = value(bundle.tools.postChangeChecks, {}); const outcomes = value(bundle.tools.outcomes, {});
  root.append(ranked(categories, "category", "count", 8), metricRow([["Prompt 关联覆盖", percent(bundle.tools.linkedPrompt.coverage)], ["每 Prompt 工具中位数", linked.medianCallsPerLinkedPrompt], ["修改后检查调用", percent(checks.rate)], ["结果状态覆盖", percent(bundle.tools.outcomes.coverage)]])); foot(root, "检查命令调用不等于任务成功", bundle); return root;
}

function codeFootprint(bundle) {
  const root = page("code-footprint", "CREATION / 01", "Codex 写下了什么"); const totals = value(bundle.code.totals, {}); root.append(node("div", "hero-number", format(totals.addedLines || 0)), node("div", "hero-label", "可归因的新增代码行"), metricRow([["删除行", totals.deletedLines], ["文件", totals.files], ["结构化变更", totals.changes], ["识别覆盖", percent(bundle.code.languages.coverage)]])); return root;
}

function languages(bundle) {
  const root = page("languages", "CREATION / 02", "编程语言光谱", "dark"); const items = value(bundle.code.languages, []); const spectrum = node("div", "spectrum"); items.slice(0, 12).forEach((item, index) => { const band = node("span"); band.style.setProperty("--share", String(item.share)); band.style.setProperty("--color", colors[index % colors.length]); band.dataset.label = `${item.language} · ${format(item.addedLines)} 行 · ${percent(item.share)}`; spectrum.append(band); }); root.append(spectrum, ranked(items, "language", "addedLines", 8)); return root;
}

function modelMap(bundle) {
  const root = page("model-map", "CREATION / 03", "模型使用地图", "red"); const models = value(bundle.models.items, []); const hours = value(bundle.models.byHour, []); const matrix = node("div", "matrix"); const hourLookup = new Map(hours.map((item) => [item.hour, item.values])); const max = Math.max(1, ...hours.flatMap((item) => Object.values(item.values)));
  const head = node("div", "matrix-head"); head.append(node("span", "model-name", "模型 / 小时"));
  for (let hour = 0; hour < 24; hour += 1) head.append(node("span", `matrix-hour${hour % 2 ? " odd-hour" : ""}`, hour % 2 ? "" : String(hour).padStart(2, "0")));
  matrix.append(head);
  models.slice(0, 6).forEach((model) => {
    const row = node("div", "matrix-row"); row.append(node("span", "model-name", model.displayName));
    for (let hour = 0; hour < 24; hour += 1) {
      const count = hourLookup.get(hour)?.[model.modelId] || 0; const cell = node("i", hour % 2 ? "odd-hour" : "");
      cell.style.setProperty("--level", String(Math.ceil((count / max) * 7))); cell.title = `${String(hour).padStart(2,"0")}:00 · ${count} turns`; cell.setAttribute("aria-label", cell.title); row.append(cell);
    }
    matrix.append(row);
  });
  root.append(matrix); const transitions = value(bundle.models.transitions, []); foot(root, `${models.length} 个模型 · 色深表示该小时 turn 数 · ${transitions.reduce((sum,item)=>sum+item.count,0)} 次相邻模型变化`, bundle); return root;
}

function tokenJourney(bundle) {
  const root = page("tokens", "CREATION / 04", "Token 旅程", "green"); const totals = value(bundle.tokens.totals, {}); root.append(node("div", "hero-number", format(totals.total || 0)), node("div", "hero-label", "total tokens"), metricRow([["输入", totals.input], ["缓存输入", totals.cachedInput], ["输出", totals.output], ["推理", totals.reasoning], ["缓存比例", percent(value(bundle.tokens.cacheRatio, 0))]])); return root;
}

function gitPulse(bundle) {
  const root = page("git-pulse", "DELIVERY", "提交脉冲", "dark"); const stats = value(bundle.git.commitStats, {}); const promptDays = new Map(value(bundle.activity.calendar.days, []).map((item) => [item.codingDay, item.prompts])); const tokenDays = new Map(value(bundle.tokens.trend, []).map((item) => [item.codingDay, item.total])); const commits = value(bundle.git.commitTrend, []); const maxCommit = Math.max(1, ...commits.map((item) => item.commits)); const maxPrompt = Math.max(1, ...promptDays.values()); const maxToken = Math.max(1, ...tokenDays.values()); const timeline = node("div", "timeline"); commits.forEach((item) => { const combined = item.commits / maxCommit * 45 + (promptDays.get(item.codingDay)||0) / maxPrompt * 30 + (tokenDays.get(item.codingDay)||0) / maxToken * 25; const bar = node("i"); bar.style.setProperty("--value", String(Math.max(2,combined))); bar.title = `${item.codingDay} · ${item.commits} commits`; timeline.append(bar); }); root.append(timeline, metricRow([["提交", stats.commits], ["提交活跃日", stats.activeDays], ["Git 新增行", stats.linesAdded], ["扫描仓库", bundle.git.repositories.length]])); foot(root, "Prompt、Token 与 commit 仅按日期并列，不表示单次归因", bundle); return root;
}

function closing(bundle) {
  const root = page("closing", "CLOSING", "这就是你的周期事实", "yellow"); const totals = value(bundle.overview.totals, {}); const streak = value(bundle.records.longestStreak, {}); const topLanguage = value(bundle.code.languages, [])[0]; const latest = value(bundle.records.latestActivity); const tags = node("div", "fact-tags");
  [ `${totals.activeDays || 0} 个活跃日`, `连续 ${streak.days || 0} 天`, topLanguage ? `${topLanguage.language} 新增行最多` : null, latest ? `最晚 ${latest.localDateTime.slice(11)} 仍在输入` : null ].filter(Boolean).forEach((text) => tags.append(node("span", "", text))); const lastPrompt = value(bundle.records.memoryMoments, []).find((item) => item.kind === "period_last"); root.append(tags, memoryQuotes([{ label: "这个周期最后停在这里", record: lastPrompt }])); foot(root, `${bundle.provenance.coverage.scannedFiles} 个日志文件 · ${bundle.manifest.privacy.mode} privacy`, bundle); return root;
}

async function load() {
  const entries = await Promise.all(files.map(async (name) => { const response = await fetch(`./data/${name}.json`); if (!response.ok) throw new Error(`${name}.json: ${response.status}`); return [name, await response.json()]; }));
  return Object.fromEntries(entries);
}

const bundle = await load();
const builders = [cover, origin, scale, calendar, peakDay, clock, rhythm, promptStyle, words, projects, tools, codeFootprint, languages, modelMap, tokenJourney];
if (bundle.git.availability === "available") builders.push(gitPulse);
builders.push(closing);
const pages = builders.map((builder) => builder(bundle));
let current = Math.max(0, pages.findIndex((item) => item.dataset.pageId === location.hash.replace("#/page/", "")));
const app = document.querySelector("#app"); const previous = document.querySelector("#previous"); const next = document.querySelector("#next"); const counter = document.querySelector("#counter"); const progress = document.querySelector("#progress i");
function show(index, updateHash = true) {
  current = Math.max(0, Math.min(pages.length - 1, index)); app.replaceChildren(pages[current]); counter.textContent = `${String(current + 1).padStart(2, "0")} / ${String(pages.length).padStart(2, "0")}`; progress.style.setProperty("--progress", `${(current + 1) / pages.length * 100}%`); previous.disabled = current === 0; next.disabled = current === pages.length - 1; if (updateHash) history.replaceState(null, "", `#/page/${pages[current].dataset.pageId}`);
}
previous.addEventListener("click", () => show(current - 1)); next.addEventListener("click", () => show(current + 1));
window.addEventListener("keydown", (event) => { if (["ArrowDown", "PageDown", " "].includes(event.key)) { event.preventDefault(); show(current + 1); } if (["ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); show(current - 1); } });
let wheelLocked = false; window.addEventListener("wheel", (event) => { if (wheelLocked || Math.abs(event.deltaY) < 20) return; wheelLocked = true; show(current + (event.deltaY > 0 ? 1 : -1)); setTimeout(() => { wheelLocked = false; }, 450); }, { passive: true });
let touchY = 0; window.addEventListener("touchstart", (event) => { touchY = event.touches[0].clientY; }, { passive: true }); window.addEventListener("touchend", (event) => { const delta = touchY - event.changedTouches[0].clientY; if (Math.abs(delta) > 45) show(current + (delta > 0 ? 1 : -1)); }, { passive: true });
window.addEventListener("hashchange", () => { const found = pages.findIndex((item) => item.dataset.pageId === location.hash.replace("#/page/", "")); if (found >= 0) show(found, false); });
show(current);
