const files = ["manifest", "overview", "activity", "prompts", "projects", "tools", "code", "models", "tokens", "git", "records", "provenance"];
const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const preciseNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

function value(metric, fallback = undefined) { return metric?.availability === "available" ? metric.value : fallback; }
function el(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = String(text); return item; }
function append(parent, ...children) { children.flat().filter(Boolean).forEach((child) => parent.append(child)); return parent; }
function format(input) { return typeof input === "number" ? compactNumber.format(input) : input ?? "--"; }
function percent(input) { return `${preciseNumber.format((input || 0) * 100)}%`; }
function section(kicker, title) { const root = el("section", "report-section"); append(root, el("p", "eyebrow", kicker), el("h2", "", title)); return root; }
function stats(items) { const root = el("div", "stats"); items.forEach(([label, result]) => { const item = el("div", "stat"); append(item, el("strong", "", format(result)), el("span", "", label)); root.append(item); }); return root; }
function column(title, content) { const root = el("div"); append(root, el("h3", "", title), content); return root; }
function scrollChart(content, label) { const root = el("div", "chart-scroll"); root.tabIndex = 0; root.setAttribute("role", "region"); root.setAttribute("aria-label", `${label}，可横向滚动`); root.append(content); return root; }
function rankList(items, nameKey, valueKey, limit = 7) { const root = el("div", "rank-list"); items.slice(0, limit).forEach((item, index) => { const row = el("div", "rank"); append(row, el("span", "", String(index + 1).padStart(2, "0")), el("span", "", item[nameKey]), el("span", "", format(item[valueKey]))); root.append(row); }); return root; }
function quote(label, record) { if (!record) return null; const root = el("article", "quote"); append(root, el("small", "", label), el("blockquote", "", record.excerpt || `${record.charCount || 0} 字 Prompt`)); return root; }

function tooltipFor(target, text) {
  const tooltip = document.querySelector("#tooltip"); tooltip.textContent = text; tooltip.hidden = false;
  const box = target.getBoundingClientRect(); const own = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(innerWidth - own.width - 12, box.left + box.width / 2 - own.width / 2))}px`;
  tooltip.style.top = `${Math.max(12, box.top - own.height - 8)}px`;
}
function hideTooltip() { document.querySelector("#tooltip").hidden = true; }
function interactiveTooltip(target, text) { target.addEventListener("pointerenter", () => tooltipFor(target, text)); target.addEventListener("pointerleave", hideTooltip); target.addEventListener("focus", () => tooltipFor(target, text)); target.addEventListener("blur", hideTooltip); }

function renderHeader(bundle) {
  const totals = value(bundle.overview.totals, {}); const root = el("header", "report-head");
  append(root, el("p", "eyebrow", "VIBE CODING WRAPPED · LOCAL AGENTS"), el("h1", "", bundle.manifest.report.period.value), el("p", "lede", "一份适合嵌入博客的紧凑活动记录。所有数字来自本地 Agent 日志，可独立静态托管。"), stats([["提示词", totals.prompts], ["活跃日", totals.activeDays], ["工具调用", totals.toolCalls], ["Token", totals.totalTokens], ["新增代码行", totals.addedLines]]));
  return root;
}

function renderRhythm(bundle) {
  const root = section("TIME", "时间与节奏"); const days = value(bundle.activity.calendar.days, []); const maxDay = Math.max(1, ...days.map((day) => day.prompts)); const calendar = el("div", "calendar"); calendar.style.setProperty("--columns", bundle.manifest.report.period.kind === "year" ? "53" : "31");
  days.forEach((day) => { const cell = el("i"); cell.style.setProperty("--level", String(Math.ceil(day.prompts / maxDay * 8))); cell.title = `${day.codingDay} · ${day.prompts} prompts`; calendar.append(cell); });
  const hours = value(bundle.activity.byHour, []); const maxHour = Math.max(1, ...hours.map((hour) => hour.prompts)); const bars = el("div", "hour-bars");
  hours.forEach((hour) => { const bar = el("button"); const label = `${String(hour.hour).padStart(2, "0")}:00 · ${hour.prompts} prompts`; bar.style.setProperty("--level", String(hour.prompts / maxHour)); bar.setAttribute("aria-label", label); interactiveTooltip(bar, label); bars.append(bar); });
  const records = el("div", "quotes"); append(records, quote("周期第一句话", value(bundle.prompts.firstInPeriod)), quote("最早开始", value(bundle.records.earliestActivity)), quote("最晚仍在输入", value(bundle.records.latestActivity)));
  calendar.style.setProperty("--chart-width", bundle.manifest.report.period.kind === "year" ? "860px" : "620px");
  const layout = el("div", "two-col"); append(layout, column("编程日历", scrollChart(calendar, "编程日历")), column("24 小时分布", scrollChart(bars, "24 小时分布"))); append(root, layout, records); return root;
}

function renderPrompts(bundle) {
  const root = section("PROMPTS", "你如何表达"); const length = value(bundle.prompts.length, {}); const structure = value(bundle.prompts.structure, {});
  root.append(stats([["中位字数", length.median], ["P90 字数", length.p90], ["包含列表", percent(structure.list?.rate)], ["包含代码块", percent(structure.codeBlock?.rate)]]));
  const cloud = el("div", "word-cloud"); const detail = el("div", "word-detail", "点击关键词查看对应 Prompt 原文"); const contexts = new Map(value(bundle.prompts.terms.keywordContexts, []).map((item) => [item.term, item])); const terms = value(bundle.prompts.terms.frequent, []).slice(0, 30); const max = Math.max(1, ...terms.map((item) => item.count));
  const showWord = (term) => { const context = contexts.get(term); detail.replaceChildren(el("strong", "", `${term} · ${context?.count || 0} 次`), document.createTextNode(context?.representative?.excerpt || "当前隐私模式不包含原文")); };
  terms.forEach((item, index) => { const button = el("button", "word", item.term); button.style.setProperty("--weight", String(Math.max(1, Math.ceil(item.count / max * 7)))); button.addEventListener("click", () => showWord(item.term)); cloud.append(button); if (index === 0) showWord(item.term); });
  const notable = el("div", "quotes"); const labels = { longest: "最长 Prompt", most_structured: "结构最丰富", most_context_rich: "上下文最丰富", keyword_dense: "高频词最集中" }; value(bundle.prompts.notable, []).forEach((item) => append(notable, quote(labels[item.kind] || item.kind, item)));
  const layout = el("div", "two-col"); append(layout, column("高频词", cloud), column("关键词原文", detail)); append(root, layout, notable); return root;
}

function renderWork(bundle) {
  const root = section("WORK", "项目与工具"); const projects = value(bundle.projects.items, []); const tools = value(bundle.tools.items, []); const layout = el("div", "two-col"); append(layout, column("活跃项目", rankList(projects, "displayName", "prompts")), column("工具足迹", rankList(tools, "tool", "count"))); root.append(layout); return root;
}

function languageList(items) { const root = el("div", "language-bars"); items.slice(0, 8).forEach((item) => { const row = el("div", "language-row"); const track = el("span", "language-track"); const bar = el("i"); bar.style.setProperty("--share", String(item.share)); track.append(bar); append(row, el("span", "", item.language), track, el("span", "", format(item.addedLines))); root.append(row); }); return root; }

function modelHeatmap(bundle) {
  const models = value(bundle.models.items, []).slice(0, 7); const hours = value(bundle.models.byHour, []); const lookup = new Map(hours.map((item) => [item.hour, item.values])); const maximum = Math.max(1, ...hours.flatMap((item) => Object.values(item.values))); const outer = el("div"); const map = el("div", "model-heatmap"); const detail = el("div", "heat-detail", "悬浮或点击格子查看模型在对应小时的使用量"); let locked;
  const head = el("div", "heat-head"); head.append(el("span", "model-name", "模型 / 小时")); for (let hour = 0; hour < 24; hour += 1) head.append(el("span", "heat-hour", hour % 2 ? "" : String(hour).padStart(2, "0"))); map.append(head);
  const show = (model, hour, count) => { const modelShare = model.turns ? count / model.turns : 0; detail.replaceChildren(el("strong", "", `${model.displayName} · ${String(hour).padStart(2, "0")}:00`), document.createTextNode(`${count} turns · 占该模型本周期使用量 ${percent(modelShare)}`)); };
  models.forEach((model) => { const row = el("div", "heat-row"); row.append(el("span", "model-name", model.displayName)); for (let hour = 0; hour < 24; hour += 1) { const count = lookup.get(hour)?.[model.modelId] || 0; const cell = el("button", "heat-cell"); const label = `${model.displayName} · ${String(hour).padStart(2, "0")}:00 · ${count} turns`; cell.style.setProperty("--level", String(count / maximum)); cell.setAttribute("aria-label", label); cell.setAttribute("aria-pressed", "false"); cell.addEventListener("pointerenter", () => { if (!locked) show(model, hour, count); tooltipFor(cell, label); }); cell.addEventListener("pointerleave", hideTooltip); cell.addEventListener("focus", () => { if (!locked) show(model, hour, count); tooltipFor(cell, label); }); cell.addEventListener("blur", hideTooltip); cell.addEventListener("click", () => { if (locked) locked.setAttribute("aria-pressed", "false"); locked = locked === cell ? undefined : cell; if (locked) { locked.setAttribute("aria-pressed", "true"); show(model, hour, count); } }); row.append(cell); } map.append(row); });
  append(outer, scrollChart(map, "模型使用地图"), detail); return outer;
}

function renderCreation(bundle) {
  const root = section("CREATION", "代码与模型"); const totals = value(bundle.code.totals, {}); root.append(stats([["新增行", totals.addedLines], ["删除行", totals.deletedLines], ["涉及文件", totals.files], ["模型数", value(bundle.models.items, []).length]]));
  const layout = el("div", "two-col"); append(layout, column("语言占比", languageList(value(bundle.code.languages, []))), column("模型使用地图", modelHeatmap(bundle))); root.append(layout); return root;
}

function renderDelivery(bundle) {
  const root = section("DELIVERY", "Token 与提交"); const tokens = value(bundle.tokens.totals, {}); const git = value(bundle.git.commitStats); root.append(stats([["总 Token", tokens.total], ["输入", tokens.input], ["输出", tokens.output], ["推理", tokens.reasoning], ["Git 提交", git?.commits ?? "--"]]));
  const finalPrompt = value(bundle.records.memoryMoments, []).find((item) => item.kind === "period_last"); const quotes = el("div", "quotes"); append(quotes, quote("这个周期最后停在这里", finalPrompt)); root.append(quotes); return root;
}

async function load() { const entries = await Promise.all(files.map(async (name) => { const response = await fetch(`./data/${name}.json`); if (!response.ok) throw new Error(`${name}.json: ${response.status}`); return [name, await response.json()]; })); return Object.fromEntries(entries); }

const bundle = await load(); const app = document.querySelector("#app"); app.replaceChildren(renderHeader(bundle), renderRhythm(bundle), renderPrompts(bundle), renderWork(bundle), renderCreation(bundle), renderDelivery(bundle));
const footer = el("footer", "report-foot", `${bundle.manifest.report.timezone} · 统计日 ${String(bundle.manifest.report.dayStartHour).padStart(2, "0")}:00 开始 · ${bundle.manifest.privacy.mode} privacy`); app.append(footer);
