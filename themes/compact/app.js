import { loadI18n } from "./i18n.js";

const files = ["manifest", "overview", "activity", "prompts", "projects", "tools", "code", "models", "tokens", "git", "records", "provenance"];
const i18n = await loadI18n();
const { t } = i18n;
document.querySelector(".loading").textContent = t("common.loading");
const compactNumber = new Intl.NumberFormat(i18n.locale, { notation: "compact", maximumFractionDigits: 1 });
const preciseNumber = new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 });
const tokenDecimal = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });

function value(metric, fallback = undefined) { return metric?.availability === "available" ? metric.value : fallback; }
function el(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = String(text); return item; }
function append(parent, ...children) { children.flat().filter(Boolean).forEach((child) => parent.append(child)); return parent; }
function format(input) { return typeof input === "number" ? compactNumber.format(input) : input ?? "--"; }
function percent(input) { return `${preciseNumber.format((input || 0) * 100)}%`; }
function tokenAmount(input) { const amount = Number(input) || 0; const root = el("div", "token-amount"); const secondary = i18n.language === "en" ? `≈ ${tokenDecimal.format(amount / 1_000_000_000)}B` : `≈ ${tokenDecimal.format(amount / 100_000_000)} ${t("unit.hundredMillion")}`; append(root, el("strong", "", `${tokenDecimal.format(amount / 1_000_000)}M`), el("small", "", secondary)); return root; }
function section(kicker, titleKey) { const root = el("section", "report-section"); append(root, el("p", "eyebrow", kicker), el("h2", "", t(titleKey))); return root; }
function stats(items) { const root = el("div", "stats"); items.forEach(([labelKey, result, kind]) => { const item = el("div", "stat"); append(item, kind === "token" ? tokenAmount(result) : el("strong", "", format(result)), el("span", "", t(labelKey))); root.append(item); }); return root; }
function column(titleKey, content) { const root = el("div"); append(root, el("h3", "", t(titleKey)), content); return root; }
function scrollChart(content, labelKey) { const root = el("div", "chart-scroll"); root.tabIndex = 0; root.setAttribute("role", "region"); root.setAttribute("aria-label", t("chart.scrollable", { label: t(labelKey) })); root.append(content); return root; }
function rankList(items, nameKey, valueKey, limit = 7) { const root = el("div", "rank-list"); items.slice(0, limit).forEach((item, index) => { const row = el("div", "rank"); append(row, el("span", "", String(index + 1).padStart(2, "0")), el("span", "data-name", item[nameKey]), el("span", "", format(item[valueKey]))); root.append(row); }); return root; }
function promptSource(record) { return t("source.directoryModel", { project: record?.projectName || t("common.unknown"), model: record?.modelId && record.modelId !== "unknown" ? record.modelId : t("common.unknown") }); }
function quote(labelKey, record) { if (!record) return null; const root = el("article", "quote"); append(root, el("small", "", t(labelKey)), el("blockquote", "", record.excerpt || t("prompt.fallback", { count: record.charCount || 0 })), el("small", "quote-source", `${record.localDateTime || t("common.unknownTime")} · ${promptSource(record)}`)); return root; }

function tooltipFor(target, text) {
  const tooltip = document.querySelector("#tooltip"); tooltip.textContent = text; tooltip.hidden = false;
  const box = target.getBoundingClientRect(); const own = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(innerWidth - own.width - 12, box.left + box.width / 2 - own.width / 2))}px`;
  tooltip.style.top = `${Math.max(12, box.top - own.height - 8)}px`;
}
function hideTooltip() { document.querySelector("#tooltip").hidden = true; }
function interactiveTooltip(target, text) { target.tabIndex = 0; if (!target.hasAttribute("aria-label")) target.setAttribute("aria-label", text); if (["I", "SPAN"].includes(target.tagName)) target.setAttribute("role", "img"); target.addEventListener("pointerenter", () => tooltipFor(target, text)); target.addEventListener("pointerleave", hideTooltip); target.addEventListener("focus", () => tooltipFor(target, text)); target.addEventListener("blur", hideTooltip); }

function renderHeader(bundle) {
  const totals = value(bundle.overview.totals, {}); const root = el("header", "report-head");
  append(root, el("p", "eyebrow", "VIBE CODING WRAPPED · LOCAL AGENTS"), el("h1", "", bundle.manifest.report.period.value), el("p", "lede", t("compact.lede")), stats([["metric.prompts", totals.prompts], ["metric.activeDays", totals.activeDays], ["metric.toolCalls", totals.toolCalls], ["metric.tokens", totals.totalTokens, "token"], ["metric.codeLinesAdded", totals.addedLines]]));
  return root;
}

function renderRhythm(bundle) {
  const root = section("TIME", "section.time"); const days = value(bundle.activity.calendar.days, []).sort((a, b) => a.codingDay.localeCompare(b.codingDay)); const maxDay = Math.max(1, ...days.map((day) => day.prompts)); const calendar = el("div", "calendar");
  const sizeClass = days.length < 100 ? "calendar-short" : "calendar-long"; calendar.classList.add(sizeClass);
  const offset = days.length ? (new Date(`${days[0].codingDay}T00:00:00Z`).getUTCDay() + 6) % 7 : 0; const monthFormatter = new Intl.DateTimeFormat(i18n.locale, { month: "short", timeZone: "UTC" }); const monthTotals = new Map(); const months = el("div", `calendar-months ${sizeClass}`);
  days.forEach((day, index) => { const monthKey = day.codingDay.slice(0, 7); monthTotals.set(monthKey, (monthTotals.get(monthKey) || 0) + day.prompts); if (index === 0 || monthKey !== days[index - 1].codingDay.slice(0, 7)) { const label = el("span", "calendar-month", monthFormatter.format(new Date(`${day.codingDay}T00:00:00Z`))); label.style.gridColumn = String(Math.floor((offset + index) / 7) + 1); months.append(label); } });
  for (let index = 0; index < offset; index += 1) { const pad = el("i", "calendar-pad"); pad.setAttribute("aria-hidden", "true"); calendar.append(pad); }
  days.forEach((day) => { const cell = el("i"); const label = t("calendar.dayTooltip", { day: day.codingDay, count: day.prompts }); cell.style.setProperty("--level", String(Math.ceil(day.prompts / maxDay * 8))); interactiveTooltip(cell, label); calendar.append(cell); });
  const weekdays = el("div", "calendar-weekdays"); weekdays.setAttribute("aria-hidden", "true"); ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((weekday) => weekdays.append(el("span", "", t(`weekday.${weekday}`)))); const calendarMain = el("div", "calendar-main"); append(calendarMain, months, calendar); const calendarPanel = el("div", `calendar-panel ${sizeClass}`); append(calendarPanel, weekdays, calendarMain); const calendarScroll = scrollChart(calendarPanel, "compact.calendar");
  const firstMonth = days.length ? new Date(`${days[0].codingDay.slice(0, 7)}-01T00:00:00Z`) : undefined; const lastMonth = days.length ? new Date(`${days.at(-1).codingDay.slice(0, 7)}-01T00:00:00Z`) : undefined; const monthly = [];
  if (firstMonth && lastMonth) for (const date = new Date(firstMonth); date <= lastMonth; date.setUTCMonth(date.getUTCMonth() + 1)) { const key = date.toISOString().slice(0, 7); monthly.push({ date: new Date(date), prompts: monthTotals.get(key) || 0 }); }
  const maxMonth = Math.max(1, ...monthly.map((item) => item.prompts)); const bars = el("div", "month-chart"); monthly.forEach((item) => { const bar = el("button", "month-bar"); bar.style.setProperty("--value", String(item.prompts / maxMonth * 100)); interactiveTooltip(bar, t("chart.monthPrompts", { month: monthFormatter.format(item.date), prompts: item.prompts })); const column = el("div", "month-column"); append(column, bar, el("small", "month-count", format(item.prompts)), el("span", "month-label", monthFormatter.format(item.date))); bars.append(column); });
  const records = el("div", "quotes"); append(records, quote("record.firstInPeriod", value(bundle.prompts.firstInPeriod)), quote("record.earliestStart", value(bundle.records.earliestActivity)), quote("record.latestActivity", value(bundle.records.latestActivity)));
  const layout = el("div", "two-col calendar-layout"); append(layout, column("compact.calendar", calendarScroll), column("calendar.monthlyPrompts", bars)); append(root, layout, records); return root;
}

function renderPrompts(bundle) {
  const root = section("PROMPTS", "section.prompts"); const length = value(bundle.prompts.length, {}); const structure = value(bundle.prompts.structure, {});
  root.append(stats([["metric.medianChars", length.median], ["metric.p90Chars", length.p90], ["metric.containsLists", percent(structure.list?.rate)], ["metric.containsCodeBlocks", percent(structure.codeBlock?.rate)]]));
  const cloud = el("div", "word-cloud"); const detail = el("div", "word-detail", t("words.detailPlaceholder")); const contexts = new Map(value(bundle.prompts.terms.keywordContexts, []).map((item) => [item.term, item])); const terms = value(bundle.prompts.terms.frequent, []).slice(0, 30); const max = Math.max(1, ...terms.map((item) => item.count));
  const showWord = (term) => { const context = contexts.get(term); detail.replaceChildren(el("strong", "", t("words.count", { term, count: context?.count || 0 })), el("span", context?.representative ? "prompt-excerpt" : "", context?.representative?.excerpt || t("common.promptUnavailable")), el("small", "quote-source", context?.representative ? promptSource(context.representative) : t("common.unknownSource"))); };
  terms.forEach((item, index) => { const button = el("button", "word", item.term); button.style.setProperty("--weight", String(Math.max(1, Math.ceil(item.count / max * 7)))); interactiveTooltip(button, t("words.tooltip", { term: item.term, count: item.count, prompts: item.promptCount })); button.addEventListener("click", () => showWord(item.term)); cloud.append(button); if (index === 0) showWord(item.term); });
  const notable = el("div", "quotes"); const labels = { longest: "notable.longest", most_structured: "notable.structured", most_context_rich: "notable.context", keyword_dense: "notable.keywordDense" }; value(bundle.prompts.notable, []).forEach((item) => append(notable, quote(labels[item.kind] || item.kind, item)));
  const layout = el("div", "two-col"); append(layout, column("words.frequent", cloud), column("words.context", detail)); append(root, layout, notable); return root;
}

function renderWork(bundle) {
  const root = section("WORK", "section.work"); const projects = value(bundle.projects.items, []); const tools = value(bundle.tools.items, []); const layout = el("div", "two-col"); append(layout, column("compact.activeProjects", rankList(projects, "displayName", "prompts")), column("title.tools", rankList(tools, "tool", "count"))); root.append(layout); return root;
}

function languageList(items) { const root = el("div", "language-bars"); items.slice(0, 8).forEach((item) => { const row = el("div", "language-row"); const track = el("span", "language-track"); const bar = el("i"); const label = t("language.tooltip", { language: item.language, lines: format(item.addedLines), share: percent(item.share) }); bar.style.setProperty("--share", String(item.share)); interactiveTooltip(bar, label); track.append(bar); append(row, el("span", "", item.language), track, el("span", "", format(item.addedLines))); root.append(row); }); return root; }

function modelHeatmap(bundle) {
  const models = value(bundle.models.items, []).slice(0, 7); const hours = value(bundle.models.byHour, []); const lookup = new Map(hours.map((item) => [item.hour, item.values])); const maximum = Math.max(1, ...hours.flatMap((item) => Object.values(item.values))); const outer = el("div"); const map = el("div", "model-heatmap"); const detail = el("div", "heat-detail", t("model.detailHint")); let locked;
  const head = el("div", "heat-head"); head.append(el("span", "model-name", t("model.header"))); for (let hour = 0; hour < 24; hour += 1) head.append(el("span", "heat-hour", hour % 2 ? "" : String(hour).padStart(2, "0"))); map.append(head);
  const show = (model, hour, count) => { const modelShare = model.turns ? count / model.turns : 0; detail.replaceChildren(el("strong", "", `${model.displayName} · ${String(hour).padStart(2, "0")}:00`), document.createTextNode(t("model.detail", { count, share: percent(modelShare) }))); };
  models.forEach((model) => { const row = el("div", "heat-row"); row.append(el("span", "model-name", model.displayName)); for (let hour = 0; hour < 24; hour += 1) { const count = lookup.get(hour)?.[model.modelId] || 0; const cell = el("button", "heat-cell"); const label = t("model.tooltip", { model: model.displayName, hour: String(hour).padStart(2, "0"), count }); cell.style.setProperty("--level", String(count / maximum)); cell.setAttribute("aria-label", label); cell.setAttribute("aria-pressed", "false"); cell.addEventListener("pointerenter", () => { if (!locked) show(model, hour, count); tooltipFor(cell, label); }); cell.addEventListener("pointerleave", hideTooltip); cell.addEventListener("focus", () => { if (!locked) show(model, hour, count); tooltipFor(cell, label); }); cell.addEventListener("blur", hideTooltip); cell.addEventListener("click", () => { if (locked) locked.setAttribute("aria-pressed", "false"); locked = locked === cell ? undefined : cell; if (locked) { locked.setAttribute("aria-pressed", "true"); show(model, hour, count); } }); row.append(cell); } map.append(row); });
  append(outer, scrollChart(map, "title.modelMap"), detail); return outer;
}

function renderCreation(bundle) {
  const root = section("CREATION", "section.creation"); const totals = value(bundle.code.totals, {}); root.append(stats([["metric.linesAdded", totals.addedLines], ["metric.linesDeleted", totals.deletedLines], ["metric.filesChanged", totals.files], ["metric.models", value(bundle.models.items, []).length]]));
  const layout = el("div", "two-col"); append(layout, column("language.share", languageList(value(bundle.code.languages, []))), column("title.modelMap", modelHeatmap(bundle))); root.append(layout); return root;
}

function renderDelivery(bundle) {
  const root = section("DELIVERY", "section.delivery"); const tokens = value(bundle.tokens.totals, {}); const git = value(bundle.git.commitStats); root.append(stats([["metric.totalTokens", tokens.total, "token"], ["metric.input", tokens.input, "token"], ["metric.output", tokens.output, "token"], ["metric.reasoning", tokens.reasoning, "token"], ["metric.gitCommits", git?.commits ?? "--"]]));
  const finalPrompt = value(bundle.records.memoryMoments, []).find((item) => item.kind === "period_last"); const quotes = el("div", "quotes"); append(quotes, quote("record.periodLast", finalPrompt)); root.append(quotes); return root;
}

async function loadBundle() { const entries = await Promise.all(files.map(async (name) => { const response = await fetch(`./data/${name}.json`); if (!response.ok) throw new Error(`${name}.json: ${response.status}`); return [name, await response.json()]; })); return Object.fromEntries(entries); }

const bundle = await loadBundle(); const app = document.querySelector("#app"); app.replaceChildren(renderHeader(bundle), renderRhythm(bundle), renderPrompts(bundle), renderWork(bundle), renderCreation(bundle), renderDelivery(bundle));
const footer = el("footer", "report-foot", `${bundle.manifest.report.timezone} · ${t("footer.codingDay", { hour: String(bundle.manifest.report.dayStartHour).padStart(2, "0") })} · ${bundle.manifest.privacy.mode} privacy`); app.append(footer);
