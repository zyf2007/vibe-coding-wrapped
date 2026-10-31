import { loadI18n } from "./i18n.js";

const files = ["manifest", "overview", "activity", "prompts", "projects", "tools", "code", "models", "tokens", "git", "records", "provenance"];
const i18n = await loadI18n();
const { t } = i18n;
document.querySelector(".loading").textContent = t("common.loading");
const navigation = document.querySelector(".rail");
navigation.setAttribute("aria-label", t("nav.reportPages"));
for (const [id, key] of [["previous", "nav.previous"], ["next", "nav.next"]]) {
  const button = document.querySelector(`#${id}`); button.title = t(key); button.setAttribute("aria-label", t(key));
}
const number = new Intl.NumberFormat(i18n.locale, { notation: "compact", maximumFractionDigits: 1 });
const precise = new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 });
const tokenDecimal = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
const colors = ["#ef5b42", "#167d68", "#e5b52d", "#4b64b5", "#aa4d79", "#6d6b64", "#1f988b", "#d27d2d"];

function value(metric, fallback = undefined) { return metric?.availability === "available" ? metric.value : fallback; }
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; }
function append(parent, ...children) { for (const child of children.flat()) if (child) parent.append(child); return parent; }
function format(value) { return typeof value === "number" ? number.format(value) : value ?? "--"; }
function percent(value) { return `${precise.format((value || 0) * 100)}%`; }
function tokenAmount(value, total = false) {
  const amount = Number(value) || 0; const root = node("div", `token-amount${total ? " token-total" : ""}`);
  const secondary = i18n.language === "en" ? `≈ ${tokenDecimal.format(amount / 1_000_000_000)}B` : `≈ ${tokenDecimal.format(amount / 100_000_000)} ${t("unit.hundredMillion")}`;
  append(root, node(total ? "div" : "strong", total ? "hero-number" : "", `${tokenDecimal.format(amount / 1_000_000)}M`), node("small", "token-yi", secondary));
  return root;
}
function dateText(value) { if (!value) return "--"; const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(.*))?$/); if (!match) return value; const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))); return `${new Intl.DateTimeFormat(i18n.locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(date)} ${match[4] || ""}`; }
function promptSource(record) { return t("source.directoryModel", { project: record?.projectName || t("common.unknown"), model: record?.modelId && record.modelId !== "unknown" ? record.modelId : t("common.unknown") }); }
function tooltipFor(target, text) {
  const tooltip = document.querySelector("#tooltip"); tooltip.textContent = t(text); tooltip.hidden = false;
  const box = target.getBoundingClientRect(); const own = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(innerWidth - own.width - 12, box.left + box.width / 2 - own.width / 2))}px`;
  tooltip.style.top = `${Math.max(12, box.top - own.height - 8)}px`;
}
function hideTooltip() { document.querySelector("#tooltip").hidden = true; }
function interactiveTooltip(target, text) {
  target.tabIndex = 0; target.setAttribute("aria-label", t(text));
  if (["I", "SPAN"].includes(target.tagName)) target.setAttribute("role", "img");
  target.addEventListener("pointerenter", () => tooltipFor(target, text)); target.addEventListener("pointerleave", hideTooltip);
  target.addEventListener("focus", () => tooltipFor(target, text)); target.addEventListener("blur", hideTooltip);
}

function page(id, kicker, titleKey, tone = "") {
  const root = node("section", `page ${tone}`.trim());
  root.dataset.pageId = id;
  const head = node("header");
  append(head, node("p", "kicker", kicker), node("h2", "", t(titleKey)));
  root.append(head);
  return root;
}

function foot(root, text, bundle) {
  const meta = node("footer", "foot");
  append(meta, node("span", "", text), node("span", "", `${bundle.manifest.report.timezone} · ${t("footer.codingDay", { hour: String(bundle.manifest.report.dayStartHour).padStart(2, "0") })}`));
  root.append(meta);
}

function metricRow(items) {
  const row = node("div", "metric-row");
  for (const [labelKey, result, kind] of items) {
    const item = node("div", `metric${kind ? ` metric-${kind}` : ""}`);
    append(item, kind === "token" ? tokenAmount(result) : node("strong", "", format(result)), node("span", "", t(labelKey)));
    row.append(item);
  }
  return row;
}

function hourAxis(step = 1) {
  const axis = node("div", "bar-axis");
  for (let hour = 0; hour < 24; hour += 1) axis.append(node("small", "", hour % step === 0 ? `${String(hour).padStart(2, "0")}:00` : ""));
  return axis;
}

function tokenMetricRow(items) {
  const row = node("div", "metric-row token-metrics");
  for (const [labelKey, result] of items) {
    const item = node("div", "metric");
    append(item, tokenAmount(result), node("span", "", t(labelKey)));
    row.append(item);
  }
  return row;
}

function memoryQuotes(items) {
  const quotes = node("div", "memory-quotes");
  items.filter((item) => item?.record).forEach((item) => {
    const quote = node("article");
    append(quote, node("p", "kicker", t(item.labelKey, item.parameters)), node("blockquote", "", item.record.excerpt || t("prompt.fallback", { count: item.record.charCount })), node("small", "", `${dateText(item.record.localDateTime)} · ${promptSource(item.record)}`));
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
  append(head, node("p", "kicker", "VIBE CODING WRAPPED · LOCAL AGENTS"), node("h1", "", bundle.manifest.report.period.value));
  const totals = value(bundle.overview.totals, {});
  const body = node("div"); append(body, node("p", "lede", t("cover.lede")), metricRow([["metric.promptCount", totals.prompts], ["metric.activeDayCount", totals.activeDays], ["metric.toolCallCount", totals.toolCalls]]));
  root.append(head, body);
  foot(root, t(bundle.manifest.report.period.kind === "month" ? "period.month" : bundle.manifest.report.period.kind === "range" ? "period.range" : "period.year"), bundle);
  return root;
}

function origin(bundle) {
  const root = page("origin", "ORIGIN", "title.origin", "red");
  const first = value(bundle.prompts.firstInPeriod);
  root.append(first ? node("blockquote", "quote", first.excerpt || t("prompt.firstFallback", { count: first.charCount })) : node("p", "empty", t("common.promptUnavailable")));
  foot(root, first ? `${dateText(first.localDateTime)} · ${t("prompt.characters", { count: first.charCount })} · ${promptSource(first)}` : t("common.insufficientData"), bundle);
  return root;
}

function scale(bundle) {
  const root = page("scale", "SCALE", "title.scale", "dark"); const totals = value(bundle.overview.totals, {});
  const body = node("div"); append(body, node("div", "hero-number", format(totals.prompts || 0)), node("div", "hero-label", t("label.realPrompts")));
  root.append(body, metricRow([["metric.turns", totals.turns], ["metric.sessions", totals.sessions], ["metric.tokens", totals.totalTokens, "token"], ["metric.linesAdded", totals.addedLines]]));
  return root;
}

function calendar(bundle) {
  const root = page("calendar", "TIME / 01", "title.calendar", "green"); const days = value(bundle.activity.calendar.days, []).sort((a, b) => a.codingDay.localeCompare(b.codingDay)); const max = Math.max(1, ...days.map((item) => item.prompts));
  const layout = node("div", "calendar-layout"); const scroll = node("div", "calendar-scroll"); scroll.classList.add(days.length < 100 ? "calendar-short" : "calendar-long");
  const weekdayAxis = node("div", "calendar-weekdays"); weekdayAxis.setAttribute("aria-hidden", "true");
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((weekday) => weekdayAxis.append(node("span", "", t(`weekday.${weekday}`))));
  const main = node("div", "calendar-main"); const grid = node("div", "calendar"); const months = node("div", "calendar-months");
  grid.classList.add(days.length < 100 ? "calendar-short" : "calendar-long"); months.classList.add(days.length < 100 ? "calendar-short" : "calendar-long");
  const offset = days.length ? (new Date(`${days[0].codingDay}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const monthFormatter = new Intl.DateTimeFormat(i18n.locale, { month: "short", timeZone: "UTC" });
  const monthTotals = new Map();
  days.forEach((day, index) => {
    const monthKey = day.codingDay.slice(0, 7); monthTotals.set(monthKey, (monthTotals.get(monthKey) || 0) + day.prompts);
    if (index === 0 || monthKey !== days[index - 1].codingDay.slice(0, 7)) { const date = new Date(`${day.codingDay}T00:00:00Z`); const label = node("span", "calendar-month", monthFormatter.format(date)); label.style.gridColumn = String(Math.floor((offset + index) / 7) + 1); months.append(label); }
  });
  for (let index = 0; index < offset; index += 1) { const pad = node("i", "calendar-pad"); pad.setAttribute("aria-hidden", "true"); grid.append(pad); }
  days.forEach((day) => { const cell = node("i", "day"); const label = t("calendar.dayTooltip", { day: day.codingDay, count: day.prompts }); cell.style.setProperty("--level", String(Math.ceil((day.prompts / max) * 8))); interactiveTooltip(cell, label); grid.append(cell); });
  const firstMonth = days.length ? new Date(`${days[0].codingDay.slice(0, 7)}-01T00:00:00Z`) : undefined; const lastMonth = days.length ? new Date(`${days.at(-1).codingDay.slice(0, 7)}-01T00:00:00Z`) : undefined;
  const monthly = [];
  if (firstMonth && lastMonth) for (const date = new Date(firstMonth); date <= lastMonth; date.setUTCMonth(date.getUTCMonth() + 1)) { const key = date.toISOString().slice(0, 7); monthly.push({ key, date: new Date(date), prompts: monthTotals.get(key) || 0 }); }
  const maxMonth = Math.max(1, ...monthly.map((item) => item.prompts)); const chart = node("div", "month-chart");
  monthly.forEach((item) => { const column = node("div", "month-column"); const bar = node("i", "month-bar"); bar.style.setProperty("--value", String(item.prompts / maxMonth * 100)); interactiveTooltip(bar, t("chart.monthPrompts", { month: monthFormatter.format(item.date), prompts: item.prompts })); append(column, bar, node("small", "month-count", format(item.prompts)), node("span", "month-label", monthFormatter.format(item.date))); chart.append(column); });
  main.append(months, grid); scroll.append(weekdayAxis, main); append(layout, scroll, append(node("div", "month-chart-panel"), node("h3", "", t("calendar.monthlyPrompts")), chart)); root.append(layout); const streak = value(bundle.records.longestStreak, {}); foot(root, t("calendar.summary", { activeDays: days.filter((item) => item.prompts).length, streak: streak.days || 0 }), bundle); return root;
}

function peakDay(bundle) {
  const root = page("peak-day", "TIME / 02", "title.peakDay"); const busiest = value(bundle.records.busiestDay); if (!busiest) { root.append(node("p", "empty", t("common.insufficientData"))); return root; }
  const events = bundle.activity.dayTimelines[busiest.codingDay] || []; const hours = Array.from({ length: 24 }, () => 0); events.forEach((event) => { const hour = Number(event.at.split("T")[1]?.slice(0, 2)); if (Number.isFinite(hour)) hours[hour] += 1; }); const max = Math.max(1, ...hours);
  const timeline = node("div", "timeline"); hours.forEach((count, hour) => { const bar = node("i"); bar.style.setProperty("--value", String(Math.max(1, count / max * 100))); interactiveTooltip(bar, t("chart.hourEvents", { hour: String(hour).padStart(2, "0"), count })); timeline.append(bar); }); const timelineChart = node("div", "bar-chart"); append(timelineChart, timeline, hourAxis());
  const dayPrompts = value(bundle.records.busiestDayPrompts, {});
  root.append(timelineChart, metricRow([["metric.date", busiest.codingDay, "short"], ["metric.prompts", busiest.prompts], ["metric.toolCalls", busiest.toolCalls], ["metric.tokens", busiest.totalTokens, "token"]]), memoryQuotes([{ labelKey: "record.dayStarted", record: dayPrompts.first }, { labelKey: "record.dayEnded", record: dayPrompts.last }])); return root;
}

function clock(bundle) {
  const root = page("clock", "TIME / 03", "title.clock", "dark"); const hours = value(bundle.activity.byHour, []); const max = Math.max(1, ...hours.map((item) => item.prompts)); const bars = node("div", "bars");
  hours.forEach((item) => { const wrap = node("div"); const bar = node("i"); bar.style.setProperty("--value", String(Math.max(1, item.prompts / max * 100))); interactiveTooltip(bar, t("chart.hourActivity", { hour: String(item.hour).padStart(2, "0"), prompts: item.prompts, turns: item.turns, tools: item.toolCalls })); wrap.append(bar); bars.append(wrap); });
  const barsChart = node("div", "bar-chart"); append(barsChart, bars, hourAxis()); const earliest = value(bundle.records.earliestActivity); const latest = value(bundle.records.latestActivity); root.append(barsChart, memoryQuotes([{ labelKey: "record.earliestStart", record: earliest }, { labelKey: "record.latestActivity", record: latest }])); foot(root, t("record.earliestLatest", { earliest: dateText(earliest?.localDateTime), latest: dateText(latest?.localDateTime) }), bundle); return root;
}

function rhythm(bundle) {
  const root = page("rhythm", "TIME / 04", "title.rhythm", "yellow"); const weekdays = value(bundle.activity.byWeekday, []).map((item) => ({ ...item, displayWeekday: t(`weekday.${item.weekday}`) })); root.append(ranked(weekdays.sort((a,b) => b.prompts-a.prompts), "displayWeekday", "prompts", 7)); const streak = value(bundle.records.longestStreak, {}); const gap = value(bundle.records.longestGap); if (gap) root.append(memoryQuotes([{ labelKey: "record.returnAfterGap", parameters: { days: gap.days }, record: gap.returnPrompt }])); foot(root, t("record.longestStreak", { days: streak.days || 0, start: streak.start || "--", end: streak.end || "--" }), bundle); return root;
}

function promptStyle(bundle) {
  const root = page("prompt-style", "EXPRESSION / 01", "title.promptStyle"); const length = value(bundle.prompts.length, {}); const structure = value(bundle.prompts.structure, {}); const languages = value(bundle.prompts.languageMix, {});
  root.append(metricRow([["metric.medianChars", length.median], ["metric.p90Chars", length.p90], ["metric.withLists", percent(structure.list?.rate)], ["metric.withCodeBlocks", percent(structure.codeBlock?.rate)], ["metric.mixedLanguages", languages.mixed]]));
  const labels = { longest: "notable.longest", most_structured: "notable.structured", most_context_rich: "notable.context", keyword_dense: "notable.keywordDense" };
  const records = node("div", "prompt-records");
  value(bundle.prompts.notable, []).forEach((item) => { const record = node("article", "prompt-record"); append(record, node("p", "kicker", t(labels[item.kind] || item.kind)), node("p", "prompt-excerpt", item.excerpt || t("prompt.characters", { count: item.charCount })), node("small", "", `${dateText(item.localDateTime)} · ${t("prompt.characters", { count: item.charCount })} · ${promptSource(item)}`)); records.append(record); });
  root.append(records);
  foot(root, t("prompt.methodology"), bundle); return root;
}

function words(bundle) {
  const root = page("words", "EXPRESSION / 02", "title.words", "yellow"); const terms = value(bundle.prompts.terms.frequent, []).slice(0, 32); const contexts = value(bundle.prompts.terms.keywordContexts, []); const contextByTerm = new Map(contexts.map((item) => [item.term, item])); const max = Math.max(1, ...terms.map((item) => item.count));
  const stage = node("div", "word-stage"); const cloud = node("div", "words"); const detail = node("aside", "word-context");
  const showContext = (term) => { const item = contextByTerm.get(term); detail.replaceChildren(); append(detail, node("p", "kicker", t("words.contextTitle", { term })), node("blockquote", "", item?.representative?.excerpt || t("common.promptUnavailable")), node("small", "", item ? t("words.contextMeta", { count: item.count, prompts: item.promptCount, date: dateText(item.representative.localDateTime), source: promptSource(item.representative) }) : t("common.noExcerpt"))); };
  terms.forEach((item, index) => { const word = node("button", "", item.term); word.style.setProperty("--weight", String(Math.max(1, Math.round(item.count / max * 8)))); interactiveTooltip(word, t("words.tooltip", { term: item.term, count: item.count, prompts: item.promptCount })); word.addEventListener("click", () => showContext(item.term)); cloud.append(word); if (index === 0) showContext(item.term); });
  append(stage, cloud, detail); root.append(stage);
  const sentences = value(bundle.prompts.keySentences, []).slice(0, 3); if (sentences.length) { const repeated = node("div", "sentence-strip"); sentences.forEach((item) => append(repeated, node("span", "prompt-sentence", `“${item.sentence || t("prompt.sentenceFallback", { count: item.charCount })}” × ${item.promptCount}`))); root.append(repeated); }
  const customExcludedCount = (bundle.prompts.terms.customExcludedWords || []).length; const custom = customExcludedCount ? t("words.customExcluded", { count: customExcludedCount }) : ""; foot(root, t("words.footer", { count: terms.length, version: bundle.prompts.terms.stopwordVersion, custom }), bundle); return root;
}

function projects(bundle) {
  const root = page("projects", "WORKSPACE / 01", "title.projects", "dark"); const items = value(bundle.projects.items, []); root.append(ranked(items, "displayName", "prompts", 10)); foot(root, t("projects.footer", { count: items.length }), bundle); return root;
}

function tools(bundle) {
  const root = page("tools", "WORKSPACE / 02", "title.tools", "green"); const categories = value(bundle.tools.categories, []); const linked = value(bundle.tools.linkedPrompt, {}); const checks = value(bundle.tools.postChangeChecks, {}); const outcomes = value(bundle.tools.outcomes, {});
  root.append(ranked(value(bundle.tools.items, categories), "tool", "count", 8), metricRow([["metric.promptLinkage", percent(bundle.tools.linkedPrompt.coverage)], ["metric.toolsPerPrompt", linked.medianCallsPerLinkedPrompt], ["metric.postChangeChecks", percent(checks.rate)], ["metric.outcomeCoverage", percent(bundle.tools.outcomes.coverage)]])); foot(root, t("tools.disclaimer"), bundle); return root;
}

function codeFootprint(bundle) {
  const root = page("code-footprint", "CREATION / 01", "title.code"); const totals = value(bundle.code.totals, {}); root.append(node("div", "hero-number", format(totals.addedLines || 0)), node("div", "hero-label", t("label.attributableLines")), metricRow([["metric.linesDeleted", totals.deletedLines], ["metric.files", totals.files], ["metric.structuredChanges", totals.changes], ["metric.detectionCoverage", percent(bundle.code.languages.coverage)]])); return root;
}

function languages(bundle) {
  const root = page("languages", "CREATION / 02", "title.languages", "dark"); const items = value(bundle.code.languages, []); const spectrum = node("div", "spectrum"); items.slice(0, 12).forEach((item, index) => { const band = node("span"); const label = t("language.tooltip", { language: item.language, lines: format(item.addedLines), share: percent(item.share) }); band.style.setProperty("--share", String(item.share)); band.style.setProperty("--color", colors[index % colors.length]); interactiveTooltip(band, label); spectrum.append(band); }); root.append(spectrum, ranked(items, "language", "addedLines", 8)); return root;
}

function modelMap(bundle) {
  const root = page("model-map", "CREATION / 03", "title.modelMap", "red"); const models = value(bundle.models.items, []); const hours = value(bundle.models.byHour, []); const matrix = node("div", "matrix"); const hourLookup = new Map(hours.map((item) => [item.hour, item.values])); const max = Math.max(1, ...hours.flatMap((item) => Object.values(item.values)));
  const head = node("div", "matrix-head"); head.append(node("span", "model-name", t("model.header")));
  for (let hour = 0; hour < 24; hour += 1) head.append(node("span", `matrix-hour${hour % 2 ? " odd-hour" : ""}`, hour % 2 ? "" : String(hour).padStart(2, "0")));
  matrix.append(head);
  models.slice(0, 6).forEach((model) => {
    const row = node("div", "matrix-row"); row.append(node("span", "model-name", model.displayName));
    for (let hour = 0; hour < 24; hour += 1) {
      const count = hourLookup.get(hour)?.[model.modelId] || 0; const cell = node("i", hour % 2 ? "odd-hour" : "");
      cell.style.setProperty("--level", String(Math.ceil((count / max) * 7))); interactiveTooltip(cell, t("model.tooltip", { model: model.displayName, hour: String(hour).padStart(2,"0"), count })); row.append(cell);
    }
    matrix.append(row);
  });
  root.append(matrix); const transitions = value(bundle.models.transitions, []); foot(root, t("model.footer", { models: models.length, transitions: transitions.reduce((sum,item)=>sum+item.count,0) }), bundle); return root;
}

function tokenJourney(bundle) {
  const root = page("tokens", "CREATION / 04", "title.tokens", "green"); const totals = value(bundle.tokens.totals, {});
  root.append(tokenAmount(totals.total, true), node("div", "hero-label", t("label.totalTokens")), tokenMetricRow([["metric.input", totals.input], ["metric.cachedInput", totals.cachedInput], ["metric.cacheWrite", totals.cacheWrite], ["metric.output", totals.output], ["metric.reasoning", totals.reasoning]]));
  foot(root, t("tokens.cacheRatio", { ratio: percent(value(bundle.tokens.cacheRatio, 0)) }), bundle); return root;
}

function gitPulse(bundle) {
  const root = page("git-pulse", "DELIVERY", "title.git", "dark"); const stats = value(bundle.git.commitStats, {}); const promptDays = new Map(value(bundle.activity.calendar.days, []).map((item) => [item.codingDay, item.prompts])); const tokenDays = new Map(value(bundle.tokens.trend, []).map((item) => [item.codingDay, item.total])); const commits = value(bundle.git.commitTrend, []); const maxCommit = Math.max(1, ...commits.map((item) => item.commits)); const maxPrompt = Math.max(1, ...promptDays.values()); const maxToken = Math.max(1, ...tokenDays.values()); const timeline = node("div", "timeline"); timeline.style.gridTemplateColumns = `repeat(${Math.max(1, commits.length)}, minmax(0, 1fr))`; const axis = node("div", "bar-axis timeline-axis"); axis.style.gridTemplateColumns = `repeat(${Math.max(1, commits.length)}, minmax(0, 1fr))`; const labelStep = Math.max(1, Math.ceil(commits.length / 12)); commits.forEach((item, index) => { const prompts = promptDays.get(item.codingDay) || 0; const tokens = tokenDays.get(item.codingDay) || 0; const combined = item.commits / maxCommit * 45 + prompts / maxPrompt * 30 + tokens / maxToken * 25; const bar = node("i", ""); bar.style.setProperty("--value", String(Math.max(2,combined))); interactiveTooltip(bar, t("git.tooltip", { day: item.codingDay, commits: item.commits, prompts, tokens: tokenDecimal.format(tokens / 1_000_000) })); timeline.append(bar); axis.append(node("small", "", index % labelStep === 0 ? item.codingDay.slice(5) : "")); }); const timelineChart = node("div", "bar-chart"); append(timelineChart, timeline, axis); root.append(timelineChart, metricRow([["metric.commits", stats.commits], ["metric.commitDays", stats.activeDays], ["metric.gitLinesAdded", stats.linesAdded], ["metric.repositories", bundle.git.repositories.length]])); foot(root, t("git.disclaimer"), bundle); return root;
}

function closing(bundle) {
  const root = page("closing", "CLOSING", "title.closing", "yellow"); const totals = value(bundle.overview.totals, {}); const streak = value(bundle.records.longestStreak, {}); const topLanguage = value(bundle.code.languages, [])[0]; const latest = value(bundle.records.latestActivity); const tags = node("div", "fact-tags");
  [ t("closing.activeDays", { count: totals.activeDays || 0 }), t("closing.streak", { count: streak.days || 0 }), topLanguage ? t("closing.topLanguage", { language: topLanguage.language }) : null, latest ? t("closing.latest", { time: latest.localDateTime.slice(11) }) : null ].filter(Boolean).forEach((text) => tags.append(node("span", "", text))); const lastPrompt = value(bundle.records.memoryMoments, []).find((item) => item.kind === "period_last"); root.append(tags, memoryQuotes([{ labelKey: "record.periodLast", record: lastPrompt }])); foot(root, t("closing.footer", { files: bundle.provenance.coverage.scannedFiles, privacy: bundle.manifest.privacy.mode }), bundle); return root;
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
pages.forEach((item) => {
  const head = [...item.children].find((child) => child.tagName === "HEADER");
  const footer = [...item.children].find((child) => child.tagName === "FOOTER");
  const content = node("div", "page-content");
  [...item.children].filter((child) => child !== head && child !== footer).forEach((child) => content.append(child));
  if (head) head.after(content); else item.prepend(content);
});
let current = Math.max(0, pages.findIndex((item) => item.dataset.pageId === location.hash.replace("#/page/", "")));
const app = document.querySelector("#app"); const previous = document.querySelector("#previous"); const next = document.querySelector("#next"); const counter = document.querySelector("#counter"); const progress = document.querySelector("#progress i");
function show(index, updateHash = true) {
  hideTooltip(); current = Math.max(0, Math.min(pages.length - 1, index)); app.replaceChildren(pages[current]); counter.textContent = `${String(current + 1).padStart(2, "0")} / ${String(pages.length).padStart(2, "0")}`; progress.style.setProperty("--progress", `${(current + 1) / pages.length * 100}%`); previous.disabled = current === 0; next.disabled = current === pages.length - 1; if (updateHash) history.replaceState(null, "", `#/page/${pages[current].dataset.pageId}`);
}
previous.addEventListener("click", () => show(current - 1)); next.addEventListener("click", () => show(current + 1));
window.addEventListener("keydown", (event) => { if (["ArrowDown", "PageDown", " "].includes(event.key)) { event.preventDefault(); show(current + 1); } if (["ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); show(current - 1); } });
let wheelLocked = false; window.addEventListener("wheel", (event) => { if (wheelLocked || Math.abs(event.deltaY) < 20) return; wheelLocked = true; show(current + (event.deltaY > 0 ? 1 : -1)); setTimeout(() => { wheelLocked = false; }, 450); }, { passive: true });
let touchY = 0; window.addEventListener("touchstart", (event) => { touchY = event.touches[0].clientY; }, { passive: true }); window.addEventListener("touchend", (event) => { const delta = touchY - event.changedTouches[0].clientY; if (Math.abs(delta) > 45) show(current + (delta > 0 ? 1 : -1)); }, { passive: true });
window.addEventListener("hashchange", () => { const found = pages.findIndex((item) => item.dataset.pageId === location.hash.replace("#/page/", "")); if (found >= 0) show(found, false); });
show(current);
