# Vibe Coding Wrapped 实现设计（V1：Codex）

> 状态：实现前设计稿
> 目标：从本机 Codex 历史中生成类似网易云音乐年度报告的沉浸式、翻页式年度或月度回顾。
> 核心原则：本地优先、统计可解释、增量计算、Agent 数据源可插拔。

## 1. 产品边界

### 1.1 V1 要做什么

- 同时读取一个或多个 Codex 数据目录，包括从其他设备复制来的 `~/.codex` 备份；支持指定报告年或报告月，周期边界遵循时区与“凌晨 4 点换日”规则。
- 提取用户提示词、会话、项目、模型、Token、工具调用、补丁和写文件行为。
- 对中英文混合提示词分词，生成高频词、技术词和确定性关键词排行。
- 从可归因的补丁/写文件记录推断 Agent 新增代码的语言占比。
- session 对应的 Git 仓库仍可访问时，可选读取本地提交历史；只有从工具调用中解析出并经仓库验证的 commit hash 才记录为精确观察，不做时间邻近归因。
- 按用户时区和可配置的“统计日开始时间”计算作息；默认一天从凌晨 4:00 开始。
- 最终产物是一组有版本、可校验的 JSON 文件（Report Bundle），不依赖任何 HTML/前端框架。
- 内置一套官方主题，将 Report Bundle 渲染成可上下翻页或滚轮切页的周期总结；用户也可编写自己的主题和渲染逻辑。
- 全程本地处理，不上传原始提示词、代码、路径和认证信息。

### 1.2 V1 明确不做什么

- 不扫描当前仓库后宣称其中所有代码均由 Agent 生成。
- 不用 LLM 在线总结提示词；第一版采用确定性的分词、规则和模板，保证离线与可复现。
- 不把删除行算作“生成代码”。删除量可以另做编辑行为指标。
- 不承诺从 shell 命令、编译产物或 Agent 文字回答中百分之百还原代码归属。
- 不读 `auth.json`、shell snapshot、环境变量值或工具输出里的秘密。
- 不支持 Claude Code、OpenCode 等其他 Agent，但架构必须允许后续增加适配器。
- 不把页面编号、CSS 类名、图表配置或 HTML 片段写入统计 JSON。
- V1 不推断任务意图或任务类型，不生成“实现 -> 修复 -> 测试”等需求转换路径。
- V1 不推断用户为什么切换模型；只展示实际模型、时间、项目和原始切换序列。
- V1 不判断任务是否成功。测试/构建命令退出状态只代表命令结果，不代表任务完成质量。
- V1 不推断用户对项目的熟悉程度，也不从读写比变化生成“越来越熟悉”的结论。
- V1 不分析 reasoning summary、思考计划、方案转向或计划与行动一致性。
- V1 不把 Token 精确归因给某个 Git commit，也不推断未关联 commit 的工作是否有产出。

以上内容在 V1 中是**不考虑**，不是“低置信度展示”：不会建立对应事实表或 feature，不会定义 analyzer，不会进入 Report Bundle schema，也不会被官方主题引用。V1 只陈述日志直接记录的事实，以及时间换日、去重、分类计数、相邻事件序列等可复现的结构派生结果。

## 2. 对 TokenDash 与本机数据的调研结论

参考实现位于：

- CLI 入口：`/home/zyf/.nvm/versions/node/v20.19.6/bin/tokendash`
- 实际包：`/home/zyf/.nvm/versions/node/v20.19.6/lib/node_modules/@zhangferry-dev/tokendash`
- Codex 解析器：`dist/server/codexParser.js`
- SQLite 示例：`dist/server/opencodeParser.js`
- 工具调用与代码行统计：`dist/server/analyticsParser.js`

TokenDash 的有效经验：

1. 递归扫描 `~/.codex/sessions/` 下的 JSONL。
2. 逐行 `JSON.parse`，单行损坏时跳过而非使整个导入失败。
3. 用 Zod 对关键事件做宽松校验，未知事件保留兼容性。
4. Codex 的 `token_count` 是累计快照；需对重复快照去重，并正确处理 `last_token_usage`。
5. 从 `session_meta` 读取会话 ID、工作目录和创建时间，从 `turn_context` 读取模型。
6. 其他 Agent 可能使用 SQLite；TokenDash 的 OpenCode 解析器通过 `sqlite3 -json` 查询数据库。

本项目需要改进的地方：

- TokenDash 每次请求同步读取并 `split('\n')` 全量文件。当前机器的 Codex sessions 已约 781 MB、1106 个文件，不适合作为年度报告的请求时计算方式。
- 固定时区小时偏移不能正确处理夏令时；应使用 IANA 时区实现。
- 调用 `sqlite3` CLI 并拼接 SQL/路径不够稳健；应用内使用 SQLite 驱动、参数绑定和只读连接。
- TokenDash 的 Codex 统计主要面向 Token，并未完整提取提示词、补丁和新旧工具事件。
- 仅按文件 `mtime` 做内存缓存不能跨进程复用，也不能支撑可恢复的长时间导入。

本机还存在 Codex 自有数据库：

- `~/.codex/state_5.sqlite`：包含 `threads`、`thread_spawn_edges` 等元数据，可见 `rollout_path`、`cwd`、`model`、`first_user_message` 等字段。
- `~/.codex/logs_2.sqlite`：主要是运行日志，不应作为年度统计数据源。
- `~/.codex/history.jsonl`：提示词快速索引，可用于校验或降级，但信息少于 session JSONL。

**V1 的事实来源仍以 session JSONL 为准。** Codex 自有 SQLite schema 属于内部实现，版本号和字段可能变化；`state_*.sqlite` 只作为可选的只读发现/补充来源，不能成为核心依赖。应用自己的索引数据库必须与 Codex 数据库完全分离。

报告反映的是“当前机器仍保留且可读取的 Codex 历史”，不等于账户服务端完整历史。报告生成前应展示数据覆盖范围、最早/最晚 session 时间、损坏/跳过文件数；如果 Codex 的历史保留策略曾关闭或文件被清理，文案必须说明数据可能不完整。

## 3. 技术选型

### 3.1 推荐语言：TypeScript

导入器、分析器、JSON bundle 生成器和官方渲染器都使用 TypeScript，Node.js 目标版本建议 22 LTS；若必须兼容当前 Node 20.19.6，也可正常实现。

选择 TypeScript 的原因：

- Codex/TokenDash 的 JSONL 数据天然适合 Node 的流式 I/O。
- 共享 `CanonicalEvent`、Report Bundle schema 和生成类型，减少生产者与各渲染器之间的字段漂移。
- `worker_threads` 足以完成 JSON 解析、分词和聚合，无需为了 V1 引入第二语言和进程通信。
- React 动效和可视化生态成熟，生成翻页式报告成本低。
- 后续适配 JSONL、SQLite 或 HTTP 导出的 Agent，都可实现同一个 TypeScript 接口。

暂不推荐 Python 作为主语言。Python 在 NLP 上有优势，但本项目第一版的瓶颈是本地日志流式导入与前端体验，中英文分词已有高性能 Node/Rust binding。若未来需要 embedding、主题聚类或本地模型，可将它们作为独立可选分析器，而不是现在拆成双语言架构。

### 3.2 推荐框架与库

| 领域 | 选择 | 用途 |
|---|---|---|
| 包管理/工程 | `pnpm workspace`、TypeScript | 多 package 单仓库、共享类型 |
| 官方渲染器 | React、Vite | 内置主题的报告 UI 与开发构建，不属于统计核心 |
| 静态导航 | 自有 hash 状态或轻量 router | 静态托管下恢复页码，不依赖服务端 fallback |
| 动效 | Motion for React | 页面切换、数字和图表入场 |
| 图表 | Apache ECharts | 日历热力图、时间分布、语言环图、趋势图 |
| 词云 | `d3-cloud` | 高频词排布；无 Canvas 时降级为关键词列表 |
| 本地数据库 | `better-sqlite3` | 应用索引、增量缓存、聚合快照；只在主线程/专用 DB worker 写入 |
| 数据校验 | Zod | Agent 原始事件、Report Bundle schema |
| JSONL | Node `readline` + `createReadStream` | 按行流式解析，避免整文件驻留内存 |
| 时间 | `@js-temporal/polyfill` | IANA 时区、DST、4 点换日规则 |
| 中文分词 | `@node-rs/jieba` | Rust binding，速度快，支持自定义词典 |
| Patch 解析 | `parse-diff`，外加 Codex 调用解包器 | 提取文件路径、增删行和 hunk |
| 测试 | Vitest、Playwright | 单元/契约/浏览器与截图测试 |
| 日志 | Pino | 结构化导入日志，默认不记录正文 |

语言识别不要依赖模糊猜测作为主路径。构建时固定一个 GitHub Linguist `languages.yml` 版本并生成精简映射，按以下顺序识别：特殊文件名、扩展名、shebang、少量歧义规则、`Text/Unknown`。这样结果可复现，也能记录规则版本。

### 3.3 运行形态

V1 是纯 CLI，不提供常驻服务、桌面应用或图形化配置界面：

```text
vibe-wrapped import      # 仅执行增量导入
vibe-wrapped generate --year 2026 --timezone Asia/Shanghai --day-start 4 --out ./wrapped-2026
vibe-wrapped generate --month 2026-07 --timezone Asia/Shanghai --day-start 4 --out ./wrapped-2026-07
vibe-wrapped render ./wrapped-2026 --theme official --out ./wrapped-2026-site
vibe-wrapped build --year 2026 --theme official --out ./wrapped-2026-site
vibe-wrapped build --month 2026-07 --theme official --out ./wrapped-2026-07-site
vibe-wrapped render ./wrapped-2026 --theme compact --out ./wrapped-2026-blog
```

`--year` 与 `--month` 互斥且必须二选一。`generate` 只生成 Report Bundle；`render` 只消费现有 bundle 并导出静态 HTML；`build` 是 `import + generate + render` 的便捷组合。渲染失败不能破坏已经生成的 JSON。

静态站点输出可直接部署到 Nginx、Caddy、GitHub Pages、Cloudflare Pages、对象存储或任意静态文件服务，不需要 Node.js 后端。默认输出多文件站点以便缓存；额外支持 `--single-file` 将脚本、样式和 JSON 内嵌进一个 `index.html`，便于直接发送和归档。

当前内置 `official` 和 `compact` 两套主题：`official` 是全屏翻页展示；`compact` 是连续滚动的紧凑单页，适合通过静态 URL 或 `iframe` 嵌入博客。两者读取完全相同的 Report Bundle。`--theme PATH` 也可加载包含 `index.html`、`app.js`、`style.css` 的受信任本地主题目录。

## 4. 总体架构

```text
Codex JSONL / 可选 state SQLite
              |
              v
       CodexDataSourceAdapter
       discover -> checkpoint -> stream
              |
              v
       CanonicalEvent 标准事件流
              |
       +------+------------------+
       |                         |
       v                         v
  SQLite 原子事实表          导入诊断/进度
       |
       v
  AnalyzerRegistry
  时间 / 词频 / 项目 / Token / 工具 / 代码语言
       |
       +<---- 可选 GitRepositoryEnricher（只读本地仓库）
       |      commits / numstat / refs / 精确 commit call 观察
       |
       v
  Report Bundle generator（带 schema/算法版本）
       |
       +----------------------+
       |                      |
       v                      v
  一组 JSON 文件          静态 Renderer
                              |
                    官方主题 / 用户自定义主题
                              |
                   index.html + 静态 assets
```

关键边界：

- **Adapter 只负责读取和规范化**，不计算“最晚熬夜”等产品指标。
- **Analyzer 只依赖标准事件**，不认识 Codex JSON 字段。
- **Git enricher 是可选富化层**，只依赖规范化项目/session/turn/file-change 事实；仓库不存在时不影响基础报告。
- **Bundle generator 只组合已计算指标、纪录和来源说明**，不包含 HTML，也不重新扫描日志。
- **Renderer 只消费公开的 Report Bundle**，不连接索引数据库、不读取 Codex 目录，也不依赖运行时 API。
- **主题负责布局、分页、图表和文案表达**；统计值、时间边界和语言占比等业务口径由分析层确定。

### 4.1 Report Bundle：真正的产品输出

Report Bundle 是一个目录，而不是单个面向某套页面的 DTO。建议结构：

```text
wrapped-2026/                         # 月报可命名 wrapped-2026-07
├── manifest.json       # 版本、文件清单、校验和、能力和隐私级别
├── overview.json       # 总量、事实型亮点和报告可用能力
├── activity.json       # coding day、月/周/小时分布、连续纪录
├── prompts.json        # 长度、结构、上下文信号、高频词和安全引用
├── projects.json       # 项目统计，默认只含脱敏展示名和稳定匿名 ID
├── tools.json          # 工具数量、类别、序列和检查命令调用
├── code.json           # 文件变更、语言占比、识别率、归因说明
├── models.json         # 模型/effort 使用、时间/项目分布和原始切换
├── tokens.json         # 输入、缓存、输出、推理 Token 及周期趋势
├── git.json            # 可选精确 Git 历史和明确 commit tool call
├── records.json        # 最早开工、最晚收工、最忙日、最长会话等纪录
└── provenance.json     # 数据覆盖、算法/词典版本、跳过记录、统计口径 ID
```

不默认导出所有提示词或工具调用明细。上述 JSON 只包含渲染周期报告所需的聚合值和少量已脱敏引用；如未来增加明细导出，应使用单独的 `--include-details`，并在 manifest 中标记更高隐私风险。

`manifest.json` 示例：

```json
{
  "$schema": "https://vibe-wrapped.dev/schemas/bundle-manifest-1.0.json",
  "bundleSchemaVersion": "1.0.0",
  "generator": {
    "name": "vibe-coding-wrapped",
    "version": "0.1.0",
    "analyzerVersion": "2026.1"
  },
  "report": {
    "period": {
      "kind": "year",
      "value": "2026",
      "startCodingDay": "2026-01-01",
      "endCodingDay": "2026-12-31"
    },
    "timezone": "Asia/Shanghai",
    "dayStartHour": 4,
    "agentScope": ["codex"],
    "sourceScope": { "count": 2 },
    "generatedAt": "2027-01-01T04:00:00Z"
  },
  "privacy": { "mode": "redacted", "containsPromptExcerpts": true },
  "capabilities": {
    "prompts": true,
    "tokenUsage": true,
    "toolCalls": true,
    "codeChanges": true,
    "gitHistory": true
  },
  "files": [
    { "path": "overview.json", "sha256": "...", "producer": "overview@1" },
    { "path": "activity.json", "sha256": "...", "producer": "activity@1" },
    { "path": "prompts.json", "sha256": "...", "producer": "prompts@1" }
  ]
}
```

公共 schema 使用两种证据等级，不提供含义模糊的 `inferred`：

```ts
type EvidenceKind = "direct" | "structural_derived";

type Metric<T> =
  | {
      availability: "available";
      value: T;
      sampleSize: number;
      coverage: number;       // 0..1；可观察样本 / 目标样本
      evidence: EvidenceKind;
      methodVersion: string;
      definitionId: string;
    }
  | {
      availability: "unsupported" | "insufficient_data" | "error";
      reasonCode: string;
      sampleSize: number;
      coverage: number;
      evidence: EvidenceKind;
      methodVersion: string;
      definitionId: string;
    };
```

直接计数也可使用该信封，以统一说明覆盖范围；所有比率、排行、纪录、分布和跨事件结构计算必须使用它。`coverage` 不是主观置信度，例如 tools-per-prompt 的覆盖率是“能绑定到 prompt 的 tool call / 全部 tool call”。模板不得自行补齐缺失样本或把 `insufficient_data` 格式化成 `0`。

十二个文件的 V1 职责和核心字段固定如下；字段名是 Bundle Schema 1.0 草案，页面只能消费这些公开语义：

| 文件 | 唯一职责 | 核心字段 |
|---|---|---|
| `manifest.json` | Bundle 身份、周期、能力、隐私和文件完整性 | `bundleSchemaVersion`、`report`、`privacy`、`capabilities`、`files[]` |
| `overview.json` | 跨域总量和事实型亮点，不重新保存明细 | `totals`、`averages`、`featuredFacts[]`、`availableSections[]` |
| `activity.json` | 以 coding day 为准的时间分布 | `calendar.days[]`、`byHour[]`、`byWeekday[]`、`periodBuckets[]`、`dayTimelines{}` |
| `prompts.json` | Prompt 自身可观察文本特征 | `firstInPeriod`、`notable[]`、`keySentences[]`、`length`、`structure`、`contextSignals`、`languageMix`、`terms.frequent[]`、`terms.keywordContexts[]`、`sessionDepth`、`byModel[]` |
| `projects.json` | 匿名项目身份及活动聚合 | `items[]`、`timeline[]`、`byDay{}`、`crossSourceMerges` |
| `tools.json` | 工具调用、类别、可观察序列和结果覆盖 | `totals`、`categories[]`、`linkedPrompt`、`sequenceMotifs[]`、`postChangeChecks`、`outcomes`、`subagents`、`byModel[]` |
| `code.json` | 结构化 patch/write 中可归因代码变化 | `totals`、`trend[]`、`attributionCoverage`、`changeRadius`、`languages[]`、`languageByProject[]`、`byModel[]` |
| `models.json` | turn 级实际模型/effort 使用与相邻转换 | `items[]`、`byHour[]`、`byWeekday[]`、`byProject[]`、`efforts[]`、`transitions[]` |
| `tokens.json` | 去重 Token 计量和趋势 | `totals`、`trend[]`、`byModel[]`、`byProject[]`、`cacheRatio`、`costEstimate` |
| `git.json` | 独立 Git 历史与精确观察到的 commit 调用 | `availability`、`repositories[]`、`commitTrend[]`、`commitStats`、`languageStats[]`、`observedCommitCalls[]` |
| `records.json` | 从其他 artifact 选择出的时间/规模纪录和回忆节点 | `earliestActivity`、`latestActivity`、`busiestDay`、`busiestDayPrompts`、`longestStreak`、`longestGap`、`longestSession`、`memoryMoments[]` |
| `provenance.json` | 来源覆盖、诊断、算法和指标定义索引 | `sources[]`、`coverage`、`diagnostics`、`producers{}`、`definitions{}`、`nodeStatus{}` |

跨文件连接只使用稳定、非敏感键：`projectId` 连接项目，`modelId` 连接模型，`codingDay` 连接日历/Prompt/Token/Git 趋势，`definitionId` 连接数据说明。原始 cwd、设备路径、数组下标和页面编号都不能作为 join key。每个 `featuredFacts[]` 项必须是结构化引用，而不是分析器直接写好的宣传文案：

```ts
type FeaturedFact = {
  id: string;
  metricRef: string;       // 例如 "records.longestStreak"
  factKind: "record" | "top_item" | "count" | "distribution_peak";
  subjectId?: string;      // projectId/modelId/languageId
  value: Metric<number | string>;
  messageKey: string;      // 模板可本地化，不能表达因果或人格判断
};
```

`overview.json` 可以引用别处事实并提供首屏所需的小型快照，但不能复制完整排行或时间序列；`records.json` 只能从已完成的基础 artifact 选择纪录，不能再次查数据库。这样官方主题和自定义主题既能一次加载常用概览，也不会出现两个文件各自计算同一指标的双重权威。

明确禁止在 V1 schema 中出现 `taskType`、`taskTransition`、`switchReason`、`taskSuccess`、`projectFamiliarity`、`reasoningPlan`、`attributedCommitTokens` 或同义字段。若未来有可靠新证据，应通过新的 schema major/minor 和独立 analyzer 评审进入，不能借用 `featuredFacts` 偷渡自然语言推断。

契约规则：

- JSON 只保存数据和语义，不保存 HTML、CSS、页面序号、ECharts option 或 React component 名。
- 报告周期统一表示为 `ReportPeriod`：`{ kind: "year", value: "2026" }` 或 `{ kind: "month", value: "2026-07" }`；分析器始终按 `codingDay` 过滤，而非直接截取 UTC 月份。
- 时间点使用 UTC ISO-8601，同时涉及展示归属时提供 `localDateTime` 和 `codingDay`，避免模板自行重算 4 点边界。
- 比率统一使用 `0..1` 小数，并同时提供分子、分母；模板只负责格式化百分比。
- 不支持的数据使用 `{ "availability": "unsupported" }`，数据不足使用 `insufficient_data`，不能用 `0` 混淆。
- 所有排序后的榜单显式包含 `rank` 和稳定 ID；相同输入和算法版本产生确定性顺序。
- schema 遵循语义化版本：增加可选字段发 minor，删除/改义发 major。渲染器必须声明可接受的 major version。
- 仓库内发布 JSON Schema，并由其生成 TypeScript 类型；生成结束和渲染开始时都做校验。
- bundle 先写入同级临时目录，全部文件完成并生成 SHA-256 后再原子替换目标目录，避免留下半份报告。

SQLite 的 `report_snapshots` 是内部缓存，不是公共交换格式。即使以后替换 SQLite，Report Bundle 契约也不应改变。

### 4.2 静态 HTML 与主题契约

官方主题和用户主题使用相同接口。主题目录建议为：

```text
my-theme/
├── theme.json
├── src/
│   ├── entry.tsx
│   └── style.css
└── package.json
```

`theme.json` 至少声明：

```json
{
  "id": "my-theme",
  "name": "My Wrapped Theme",
  "themeApiVersion": "1.0",
  "acceptsBundleSchema": "^1.0.0",
  "entry": "src/entry.tsx"
}
```

CLI 向主题构建入口提供一个只读的 `ReportBundle` loader、输出目录和构建参数。自定义主题可以选择 React、Vue、Svelte 或原生 HTML/JS；核心项目只约束最终静态产物，不强制其 UI 框架。主题不能回调分析器获取额外数据，所需字段应先进入公开 bundle schema。

默认多文件静态产物：

```text
wrapped-2026-site/
├── index.html
├── assets/
│   ├── app-[hash].js
│   ├── app-[hash].css
│   └── ...
└── data/
    ├── manifest.json
    ├── overview.json
    ├── activity.json
    ├── prompts.json
    └── ...
```

静态托管约束：

- HTML、JS、CSS 和 JSON 一律使用 `./` 相对 URL，不能写死 `/assets` 或部署域名，确保可部署在任意子路径。
- 页面状态使用 hash，例如 `index.html#/page/activity`；不能要求服务器把未知路径 fallback 到 `index.html`。
- 构建后不能出现对 `localhost`、`/api/*` 或 Node 内置模块的请求。
- 默认不加载 CDN、远程字体或远程图片，站点可完全离线托管。
- 多文件模式面向静态 host；浏览器通常限制从 `file://` fetch JSON。如需双击本地打开，使用 `--single-file`。
- `--single-file` 生成自包含 HTML，数据放入非执行的 `<script type="application/json">` 中并安全转义 `</script>`、U+2028/U+2029，不能把 JSON 直接字符串拼接进可执行脚本。
- 自定义主题属于受信任代码：它能读取报告中的提示词片段。CLI 安装/运行第三方主题时必须提示风险；官方主题构建产物通过 CSP 禁止外连。

`render` 应在临时目录完成构建，然后检查 `index.html`、相对资源引用、bundle schema 和资源存在性，最后原子发布输出目录。可以增加一个只用于开发主题的 `theme dev` 命令，但它不是最终报告的运行依赖。

## 5. Agent 数据读取抽象层

### 5.1 核心接口

```ts
export interface AgentDataSourceAdapter {
  readonly id: string;                 // "codex"
  readonly schemaVersion: number;
  detect(root: SourceRoot, ctx: DetectContext): Promise<DetectionResult>;
  discover(root: SourceRoot, ctx: DiscoverContext): AsyncIterable<SourceRef>;
  read(source: SourceRef, checkpoint?: Checkpoint): AsyncIterable<CanonicalEvent>;
}

export type SourceRoot = {
  id: string;               // 应用内稳定 ID，不导出绝对路径
  adapterId: string;
  path: string;
  label?: string;           // 例如 "desktop"、"laptop-backup"
};

export type SourceRef = {
  sourceRootId: string;
  adapterId: string;
  stableId: string;
  uri: string;
  kind: "jsonl" | "sqlite" | "json";
  size?: number;
  mtimeMs?: number;
};

export type CanonicalEvent =
  | SessionEvent
  | UserPromptEvent
  | AssistantMessageEvent
  | TokenUsageEvent
  | ToolCallEvent
  | ToolResultEvent
  | FilePatchEvent
  | DiagnosticEvent;
```

所有标准事件至少包含：

```ts
type EventBase = {
  eventId: string;          // 与目录路径无关的语义事件 ID，用于跨设备去重
  agentId: string;
  sessionId: string;
  turnId?: string;
  occurredAt: string;       // UTC ISO-8601
  cwd?: string;
  source: { sourceRootId: string; stableId: string; byteOffset?: number; rawType: string };
};
```

能力用显式 flags 表达，例如 `prompts`、`tokenUsage`、`patches`、`toolCalls`。后续某个 Agent 没有补丁事件时，报告页应显示“该数据源不支持”，不能显示 0%。

### 5.2 CodexAdapter 数据目录与优先级

可以同时启用多个 Codex root。根目录集合按以下规则确定：

1. CLI 中每个重复出现的 `--codex-home PATH` 都加入集合。
2. `--sources sources.json` 可声明多台设备的路径和显示标签，适合长期复用。
3. 只有在未显式传入任何 root 时，才使用环境变量 `CODEX_HOME`，否则使用 `~/.codex`。

示例配置：

```json
{
  "sources": [
    { "adapter": "codex", "path": "/home/me/.codex", "label": "desktop" },
    { "adapter": "codex", "path": "/data/old-laptop/.codex", "label": "laptop-2025" }
  ]
}
```

每个 root 必须独立检测 `sessions/`、`history.jsonl` 和最新可识别的 `state_*.sqlite`。所有输入均只读；不要求用户把备份覆盖或合并进当前 `~/.codex`。

读取优先级：

1. `sessions/**/*.jsonl`：核心事实源。
2. `history.jsonl`：仅用于缺失 session 的降级或导入一致性诊断。
3. 最新可识别的 `state_*.sqlite`：只读补充 thread 元数据；检测 schema 后再查询。

永不读取：`auth.json`、`logs_*.sqlite`、shell snapshots、缓存中的工具鉴权信息。

### 5.3 多目录合并与去重

跨设备复制最常见的情况是两个 root 含有完全相同、前缀相同或各自追加过的 session。不能按文件路径去重，也不能把 CLI 参数顺序当作数据优先级。

合并规则：

1. root 先通过 realpath 去重；如果一个 root 的 `sessions/` 被另一个 root 包含，`doctor` 报告重叠并避免重复扫描。
2. session 以 Codex `session_meta.payload.id` 为全局身份。相同 session ID 的多个 JSONL 视作副本或分支，做事件级 union，而不是整文件二选一。
3. 事件优先使用 Codex 原生 event/call/turn ID；缺失时用 `adapter + sessionId + turnId + timestamp + rawType + normalizedPayloadHash` 生成稳定 ID。路径、root ID、mtime 和行号不能进入语义 ID。
4. 完全相同文件可用 size + 流式内容 hash 识别，第二份不重复解析正文，但仍记录 provenance。
5. 同一语义事件内容不同属于冲突。选择字段更完整的记录；完整度相同则用规范 JSON hash 做确定性决胜，同时写入 `import_diagnostics`，不得静默覆盖。
6. Token 累计快照、重复 prompt、tool call 和 patch 在合并后的 session 事件序列上再次去重，避免每个 root 内正确、跨 root 后翻倍。
7. 删除某个 source root 只移除它的 provenance；某事件仍被其他 root 引用时保留事实记录。

root 暂时离线或挂载失败时，只标记 `unavailable` 并沿用上次成功索引的数据，不能自动当作已删除。只有显式执行 `sources remove` 或未来的 `--prune-missing` 才改变 source scope，并必须使相关 snapshot 失效。

每个 root 有独立 checkpoint 和数据 watermark。Report Bundle 的 `provenance.json` 导出 root 数量、可选脱敏 label、时间覆盖和重复/冲突计数，默认不导出输入绝对路径或设备 installation ID。

项目跨设备合并需要单独处理：同一个仓库可能是 `/home/a/Code/foo` 和 `/Users/a/Code/foo`。默认使用 `sourceRootId + normalized cwd` 防止同名误合并；若 Git remote 的脱敏 hash 一致，或用户在 sources 配置中声明 `projectAliases`，才合并为同一 `project_key`。

### 5.4 Codex JSONL 事件规则

需要兼容而不能假设只存在一种形态：

- `session_meta`：会话 ID、初始 cwd、来源、CLI 版本、创建时间。
- `turn_context`：turn ID、模型、cwd、时区等；模型可能在会话中变化。
- `event_msg.user_message`：用户可见提示词。
- `response_item.message` 且 `role=user`：另一份用户消息表示。
- `event_msg.token_count`：Token 累计/单次快照。
- `response_item.custom_tool_call` / `custom_tool_call_output`：新版工具调用。
- `response_item.function_call` / `function_call_output`：旧版工具调用。
- `event_msg.patch_apply_end`：可用于补丁状态交叉校验。
- 其他未知类型：计入诊断，不中断导入。

提示词去重：优先使用 turn ID；没有 turn ID 时，对规范化后的正文、session ID 和相近时间窗口生成哈希。`event_msg.user_message` 与 `response_item(role=user)` 内容一致时只保留一条。系统/开发者消息不算用户提示词。

规范化只做展示无损的外层清理，例如移除 Codex 注入的 `<environment_context>`、附件占位元数据；不得删除用户正文中的 XML、Markdown 或代码。数据库同时保存 `raw_text`（可关闭）与 `normalized_text`，后续规则升级可重算。

Token 去重沿用累计快照思路：同一会话内以累计五元组去重；存在 `last_token_usage` 时优先取单次值，否则用当前累计值减上次累计值。模型必须按 turn 关联，不能把整场会话强行归给第一个模型。

## 6. 应用数据库设计

数据库默认位于 `~/.local/share/vibe-coding-wrapped/index.sqlite`，可由 XDG 目录或 CLI 参数覆盖。启用 WAL、foreign keys 和 busy timeout。原始 Codex 数据库始终只读，且不在其上建表。

建议表：

```sql
source_roots(
  id, adapter_id, label, canonical_path, installation_fingerprint,
  enabled, created_at, last_seen_at,
  UNIQUE(adapter_id, canonical_path)
);

source_files(
  id, source_root_id, stable_id, relative_uri,
  size, mtime_ms, inode, byte_offset, tail_fragment,
  content_hash, parser_version, status, last_imported_at, error_count,
  UNIQUE(source_root_id, stable_id)
);

sessions(
  id, agent_id, created_at, updated_at,
  cwd, project_key, source_kind, cli_version
);

session_sources(
  session_id, source_file_id, first_seen_at, last_seen_at,
  PRIMARY KEY(session_id, source_file_id)
);

event_provenance(
  event_kind, event_id, source_file_id, byte_offset, raw_hash,
  PRIMARY KEY(event_kind, event_id, source_file_id, byte_offset)
);

turns(
  id, session_id, started_at, completed_at,
  model_raw, model_family, model_provider, reasoning_effort,
  cwd, status, model_attribution_confidence
);

activity_blocks(
  id, project_key, started_at, ended_at,
  prompt_count, turn_count, tool_call_count
);

prompts(
  id, session_id, turn_id, occurred_at,
  raw_text, normalized_text, content_hash, char_count,
  UNIQUE(session_id, content_hash, occurred_at)
);

token_events(
  id, session_id, turn_id, occurred_at, model,
  input_tokens, cached_input_tokens, output_tokens,
  reasoning_tokens, total_tokens, snapshot_hash
);

tool_calls(
  id, session_id, turn_id, occurred_at,
  tool_name, call_id, status, outcome_kind, exit_code,
  sanitized_arguments_json
);

prompt_features(
  prompt_id, feature_version, char_count, word_count,
  language_class, structure_flags, context_flags,
  PRIMARY KEY(prompt_id, feature_version)
);

tool_call_features(
  tool_call_id, feature_version, category, confidence,
  command_family, is_mutation, is_check_invocation,
  PRIMARY KEY(tool_call_id, feature_version)
);

file_changes(
  id, tool_call_id, occurred_at, path, language,
  added_lines, deleted_lines, added_bytes,
  attribution_confidence, parser_rule
);

git_repositories(
  id, project_key, identity_hash, local_path,
  remote_hash, root_commit_hash, refs_fingerprint,
  last_scanned_at, status
);

git_commits(
  repository_id, hash, author_time, committer_time,
  author_identity_hash, parent_count, subject_redacted,
  files_changed, lines_added, lines_deleted,
  PRIMARY KEY(repository_id, hash)
);

git_commit_files(
  repository_id, commit_hash, path_hash, display_path, language,
  lines_added, lines_deleted, is_binary,
  PRIMARY KEY(repository_id, commit_hash, path_hash)
);

git_observed_commit_calls(
  repository_id, commit_hash, tool_call_id, session_id, turn_id,
  occurred_at, parser_version,
  PRIMARY KEY(repository_id, commit_hash, tool_call_id)
);

prompt_terms(
  prompt_id, term, normalized_term, count, pos, tokenizer_version
);

report_snapshots(
  id, agent_scope, source_scope_hash,
  period_kind, period_value, timezone, day_start_hour,
  data_watermark, analyzer_version, report_json, created_at,
  UNIQUE(agent_scope, source_scope_hash,
         period_kind, period_value, timezone, day_start_hour,
         data_watermark, analyzer_version)
);

analysis_artifacts(
  artifact_id, scope_hash, input_watermark, analyzer_version,
  artifact_json, created_at,
  PRIMARY KEY(artifact_id, scope_hash, input_watermark, analyzer_version)
);

import_diagnostics(
  id, source_file_id, line_number, severity, code, raw_type, message
);
```

隐私模式可配置为：

- `full`：保存提示词正文，才能完整展示首条提示词引用；静态发布风险最高。
- `redacted`（默认）：导入时做本地秘密检测与路径脱敏后保存。
- `metrics-only`：只保存哈希、长度和聚合词频；涉及原文的报告页自动省略。

不要把完整工具输出写入索引库。工具参数也只保留统计所需字段（工具名、文件路径、patch/write 内容），并在解析完成后丢弃命令环境和无关正文。

## 7. 增量导入与并发设计

### 7.1 为什么不能简单“多线程全开”

781 MB JSONL 的工作包含磁盘读取、UTF-8 解码、`JSON.parse`、补丁解析和 SQLite 写入。无限增加 worker 会导致磁盘争抢、消息复制和数据库锁竞争，反而变慢。

推荐流水线：

1. 主线程扫描所有启用 root 的文件，先排除重叠路径并比较各自 checkpoint。
2. 按文件大小做跨 root 贪心均衡，分给 worker pool；慢速挂载点可设置每 root 并发上限。
3. worker 使用 `createReadStream` + `readline` 流式解析，从 checkpoint offset 继续。
4. worker 每 500～2000 条标准事件批量回传；不回传整个文件字符串。
5. 单个 DB writer 先按全局语义 event ID 合并，再使用事务批量 upsert，避免多个线程写 SQLite。
6. 记录每条事实的所有 provenance；合并结束后再执行 session 级 Token/prompt/tool/patch 去重。
7. 导入完成后，使受影响时间范围和 source scope 的年报/月报 snapshot 失效；下次生成时按需重算。

默认 worker 数：

```ts
Math.max(1, Math.min(4, availableParallelism() - 1))
```

可根据基准测试通过 `--workers` 调整，并至少为 CLI 主线程保留一个 CPU。分词和大 patch 解析可共用 CPU worker pool，但 DB 写入不并行。

### 7.2 Checkpoint 与文件变化

- checkpoint key 是 `(source_root_id, source_file_stable_id)`；不同设备的同名相对路径互不覆盖。
- 新文件：从 byte 0 读取，并在流式读取时计算内容 hash。
- 文件只追加且 inode 相同、size 增大：从已确认的完整行 byte offset 继续。
- size 变小、inode 改变、parser version 改变：删除该 source 对应事实后全量重导。
- mtime 改变但 size 相同：计算轻量首尾块 fingerprint；不一致则重导。
- 最后一行不完整：保存 `tail_fragment`，下次与新字节拼接，绝不提前解析。
- 每批事务提交后才推进 checkpoint，进程中断后允许幂等重放。

首次导入显示 root、阶段、文件数、已读字节、事件数、重复/冲突数和预计剩余量。后续运行通常只需处理各 root 中活跃会话的追加内容。

### 7.3 分词任务

分词无需为每条提示词创建一个线程。按约 0.5～2 MB 正文组成 batch，投递到固定 worker pool：

1. Unicode NFKC 规范化（原文不改）。
2. 保留技术词：`C++`、`C#`、`.NET`、`Node.js`、`Next.js`、`Vue`、`React`、`SQLite`、文件扩展名等。
3. 中文使用 jieba；英文按 Unicode word boundary 切分并小写归一。
4. 去掉标点、纯数字、URL、超长 hash、路径、常见停用词和低信息指令词。
5. 支持项目词典与用户词典，避免把框架名拆散。
6. 输出 term count；周期关键词用 TF-IDF/对数频率排序，不单纯取最高原始词频。

建议同时展示两个概念：

- **最常说的词**：过滤后原始频次，直观可解释。
- **周期关键词**：按 `tf * idf` 或与个人历史基线的提升度排序，降低“帮我、修改、代码”等通用词占据榜首的问题。

V1 不做语义聚类。等多 Agent 和更大样本稳定后，再考虑本地 embedding；届时作为 `AnalyzerPlugin` 增加，不改变导入层。

### 7.4 只读一次：AnalysisDataset

生成报告时禁止每个 analyzer 自己查询 SQLite，更禁止重新扫描 JSONL。所有分析器通过同一个 `AnalysisContext` 获取按需、进程内 memoize 的数据集：

```ts
type AnalysisScope = {
  period: ReportPeriod;
  timezone: string;
  dayStartHour: number;
  sourceIds: string[];
  agentIds: string[];
  privacyMode: PrivacyMode;
};

interface AnalysisContext {
  readonly scope: AnalysisScope;
  readonly watermark: DataWatermark;
  dataset<T>(key: DatasetKey<T>): Promise<Readonly<T>>; // 同 key 只加载一次
  artifact<T>(id: ArtifactId<T>): Promise<Readonly<T>>;
}
```

建议的共享 dataset：

| Dataset key | 一次性读取内容 | 主要消费者 |
|---|---|---|
| `sessions` | session、project、source scope | activity、projects、provenance |
| `turns` | turn、model、effort、时间、cwd | activity、prompts、tools、code、models、projects、records |
| `prompts` | 周期内 prompt 与已缓存 features | prompts、activity、projects、tools、records |
| `tokens` | 去重后的 turn/token events | tokens、projects、overview |
| `tools` | tool calls/results 与分类 features | tools、activity、code、records |
| `fileChanges` | 结构化 patch/write 结果与语言 | code、projects、tools |
| `diagnostics` | source coverage、跳过/冲突统计 | provenance |
| `gitFacts` | commit、numstat、author filter、refs、精确 commit call | git |

`DatasetRegistry` 为每个 key 保存一个 Promise；两个 analyzer 同时请求 `prompts` 时共享同一次查询和同一个不可变结果。Analyzer package 不允许直接依赖 storage repository，代码审查和 lint rule 应阻止绕过 context。

数据库读取放在专用 DB worker 中，在一个稳定 read transaction 内按表各执行一次 prepared query。查询必须带 period、agent、selected source provenance 条件，只加载报告范围和少量边界缓冲，不把全库历史放入内存。`build` 先完成 import 再开始 read snapshot，因此不需要一边写一边分析。

大正文不构建第二份完整字符串数组：prompt loader 以 batch 形式把正文交给 feature worker，主分析上下文只保留 prompt ID、时间、统计字段和报告可能引用的少量脱敏 excerpt。已经存在匹配 `feature_version` 的 `prompt_features/prompt_terms` 时完全不再读取正文做分词。

### 7.5 计算 DAG 与 JSON artifact

“一个 JSON 文件”对应一个公开 artifact，但不代表各模块重复读取事实。共享 features 和 dataset 位于 DAG 下层：

```text
SQLite fact snapshot --> promptFeatures / terms -----> prompts ----+
        |            --> toolFeatures ---------------> tools ------+
        |            --> languageFeatures -----------> code -------+
        |            --> activityBlocks -------------> activity ---+--> records --+
        |            --> project identity -----------> projects ---+              |
        |            --> model normalization --------> models -----+              |
        |            --> token normalization --------> tokens -----+              |
        |                                                                       |
Git refs/log -----------> gitFacts -------------------> git ---------------------+
                                                                                |
diagnostics ----------------------------------------------------------------> provenance
                                                                                |
all available reliable artifacts + records --------------------------------> overview
                                                                                |
                                    JSON serialization + checksums ----------> manifest
```

具体依赖和并行性：

| Artifact/节点 | 输入 | 依赖 | 是否可并行 | 输出 |
|---|---|---|---|---|
| `activity` | prompts、turns、tools timestamps | coding-day projector | 是 | `activity.json` |
| `prompts` | prompts、turns | prompt features、terms、turn linkage | 是，CPU batch | `prompts.json` |
| `projects` | sessions、prompts、tokens、fileChanges | project identity | 是 | `projects.json` |
| `tools` | prompts、turns、tools、fileChanges | tool features、turn/prompt linkage | 是 | `tools.json` |
| `code` | turns、fileChanges | language classifier cache、turn linkage | 是 | `code.json` |
| `models` | turns | model/effort normalization | 是 | `models.json` |
| `tokens` | tokens、turns | token snapshot normalization | 是 | `tokens.json` |
| `records` | activity、prompts、projects、tools、code | 上述 artifacts | 第二层 | `records.json` |
| `gitFacts` | 本地 repositories | refs fingerprint | 可与文本分析并行，I/O 子进程池 | 内部事实 |
| `git` | gitFacts、已解析且验证的 commit calls | coding-day projector | gitFacts 后 | `git.json` |
| `overview` | 所有成功的可靠 artifacts、records | fact selection rules | 最后阶段 | `overview.json` |
| `provenance` | diagnostics、coverage、各节点状态 | 所有节点执行结果 | 最后阶段 | `provenance.json` |
| `manifest` | 已序列化文件和 checksum | 所有 JSON | 串行收尾 | `manifest.json` |

避免人为制造依赖。例如日历页可以在渲染时按 `codingDay` 对齐 `activity.json` 和 `git.json`，不应让 `activity` artifact 因为需要显示 commit 点而依赖 Git。这样仓库缺失或 Git 扫描失败不会阻塞基本活动报告。

### 7.6 分阶段并行调度

调度器按依赖和资源类型执行，而不是对所有 Promise 直接 `Promise.all`：

1. **Phase 0：确定快照**。完成 import，解析 scope，开启 SQLite read transaction，计算 Codex watermark；并行检查 Git repo/refs fingerprint。
2. **Phase 1：共享特征**。按需加载事实表；并行计算缺失的 prompt、tool、language features 和 activity blocks。
3. **Phase 2：独立 artifacts**。并行计算 activity、prompts、projects、tools、code、models、tokens；Git log 扫描与这些任务同时进行。
4. **Phase 3：组合 artifacts**。Git facts 就绪后计算 git；基础 artifacts 就绪后计算 records。
5. **Phase 4：收束**。计算 overview、provenance，校验所有 artifact schema。
6. **Phase 5：发布**。确定性序列化 JSON、计算 checksum、最后写 manifest 并原子替换输出目录。

每个任务声明资源标签：

```ts
type ResourceClass = "db-read" | "db-write" | "cpu" | "git-process" | "serialize";
```

- `db-write` 永远单并发；生成阶段通常没有 DB 写入，除非提交 feature/artifact cache。
- `db-read` 使用单个 snapshot loader，避免多个全表扫描争抢磁盘。
- `cpu` 使用固定 worker pool；分词、语言识别和大规模聚合按 batch 执行。
- `git-process` 默认最多 2 个仓库并行，防止几十个 repo 同时读取 object database。
- `serialize` 限制并发，避免多个大型 JSON stringify 同时造成内存峰值。

Node 主线程只负责 DAG、进度和小型归并。把 CPU 函数包装成 async 并不会自动并行；真正重任务必须进入 `worker_threads`。Worker 返回局部计数/紧凑数组，不把完整 prompt 集或大型 Map 在进程间反复 structured-clone。

所有并行归并必须确定性：按稳定 ID 排序、数值使用一致的累加顺序、Top N 使用固定 tie-break。改变 `--workers` 数量不能改变 JSON 内容或 checksum。

### 7.7 五层缓存与失效

| 层级 | 缓存内容 | Key/版本 | 何时复用 |
|---|---|---|---|
| L1 source checkpoint | JSONL byte offset、tail、file hash | root + file + parser version | 文件只追加/未变化 |
| L2 canonical facts | prompt、turn、token、tool、patch 等 | semantic event ID | 跨报告周期和主题永久复用 |
| L3 entity features | 分词、prompt structure、tool category、language | entity input hash + feature version | 年报/月报和不同时区共享 |
| L4 analysis artifact | activity/prompts/tools/code/models/tokens 等 JSON 内容 | artifact + scope + dependency watermark + analyzer version | 相同统计范围和依赖未变 |
| L5 final output | Report Bundle、静态主题产物 | bundle checksum + theme version + render options | 只换 host 时直接复制 |

典型失效传播：

| 变化 | 必须失效 | 可以复用 |
|---|---|---|
| 新增 prompt | activity、prompts、projects、tools、records、overview、provenance | 旧 tool/code/language features |
| 新增 token event | tokens、projects、overview | prompt terms、tool classification、code、git |
| 新增 tool/patch | tools、code、projects、records、overview | prompt terms、models、tokens、git history |
| Git refs 变化 | git、overview、provenance、最终 manifest | activity、prompts、tools、code、models、tokens |
| timezone/dayStart 变化 | activity、records、按时间分桶的 projects/models/tokens/git | 分词、tool/language features |
| privacy mode 变化 | excerpts、路径/名称和最终 artifacts/HTML | 不含秘密的数值聚合和 entity features |
| theme/CSS 变化 | 静态 HTML/assets | 所有 JSON artifacts |
| analyzer version 变化 | 该 analyzer 及下游节点 | 无依赖的兄弟 artifacts |

L4 不应只使用一个全局 `analyzerVersion`。每个 artifact 有独立版本和 dependency watermark，例如 `prompts@3` 升级不应迫使 `code.json` 重算。最终 manifest 记录每个 artifact 的 producer/version。

第一次实现可以先保留 L1～L3 和整个 bundle snapshot，等正确性稳定后增加 L4 细粒度缓存；但 DAG/接口从一开始就要支持独立 artifact version，避免未来拆缓存时重写分析器。

### 7.8 失败隔离、内存与复用边界

- activity/prompts 基础节点失败属于致命错误；Git 或 code 可选节点失败时标记 capability/error，其他 JSON 继续生成。
- 单个 analyzer 只能返回自己的 artifact 或 typed error，不得修改其他 analyzer 的结果。
- Artifact 对象冻结后共享；下游如需排序必须复制局部数组，禁止原地修改共享 dataset。
- 设定进程内存预算。DatasetRegistry 应在最后一个消费者完成后释放大型 prompt batch；不能为了“复用”把全年所有原文永久留在内存。
- 浏览器端 `ReportBundleLoader` 同样 memoize 每个 JSON fetch；页面共享对象，页面切换不重复请求或 parse JSON。
- 官方 renderer 构建阶段读取 bundle 一次。它不重新计算 Top N、百分比、coding day 或 Git 归因，只做格式化、筛选和跨 JSON 的按稳定 ID 对齐。
- Git refs 在扫描结束时复查一次；如果中途发生提交/rebase，最多自动重试一次，否则在 provenance 标记 snapshot changed，避免混合两个仓库时刻。

### 7.9 可观测性与“没有重复读盘”的验收

CLI 提供 `--profile`，在 stderr 输出且可选写入脱敏 profile JSON：

- 每个 dataset 的 query 次数、行数、读取字节估算和驻留峰值；同一 key 的 `loadCount` 必须为 1。
- 每个 DAG node 的等待时间、执行时间、worker、cache hit/miss 和失效原因。
- JSONL 实际读取文件/字节；无变化的 `generate/render` 阶段必须为 0。
- Git 仓库 refs 检查数、完整 log 扫描数和缓存命中数。
- 每层缓存的命中率，以及最终 bundle/theme checksum。

集成测试通过包装 filesystem/storage 接口计数，不依赖肉眼判断性能。对一个 fixture 同时启用全部页面时，`prompts`、`turns`、`tokens`、`tools` 等 dataset loader 各只允许执行一次；renderer 不允许访问 SQLite 或 Codex root。

## 8. 关键统计口径

### 8.1 时间与“凌晨 4 点换日”

所有事件入库保存 UTC instant；统计时使用用户选择的 IANA timezone，默认取系统时区。定义：

```ts
codingDay(event) = calendarDate(zonedTime(event) - 4 hours)
```

例如北京时间 2026-03-08 02:30 归入 2026-03-07 的 coding day。必须使用 Temporal 的 zoned time 运算处理 DST，不能写死 `+8`。

“最晚还在写提示词”不能直接按自然时钟取最大时间，否则晚上 23:50 会击败凌晨 03:20。定义相对 coding day 起点的活跃分钟：

```text
04:00 -> 0 分钟
23:50 -> 1190 分钟
次日 03:20 -> 1400 分钟（更晚）
```

“最早开工”则取 coding day 内最小活跃分钟。为避免一次误触造成夸张结论，可同时计算：

- 绝对纪录：单条 prompt 即可入选。
- 可信纪录：该会话或相邻 30 分钟内至少有第二条 prompt/tool event。

页面主文案用可信纪录，角标可写绝对纪录。用户例子可生成：

> 你最晚在凌晨 3:20 还发出了提示词。那是 11 月 18 日的工作日，距离 4 点收工线只剩 40 分钟。

### 8.2 第一条提示词

先按 `codingDay` 过滤报告周期，再按 instant 取最早的去重后用户提示词；显示本地月日、时间和经过脱敏/截断的正文。若用户选择“全部历史首条”，另行标注，不能与“本周期首条”混淆。

默认预览：去掉外层环境上下文，折叠空白，最多 80 个中文字符/160 个英文字符；不得把 token、密码或长密钥直接展示。完整正文只在用户主动展开时显示。

### 8.3 活跃天数与连续纪录

- 活跃日：某 coding day 至少有 1 条用户 prompt。
- 深度活跃日：至少 5 条 prompt 或 3 个完成 turn；阈值放入算法配置。
- 连续天数：按 coding day 连续，不按文件修改日期。
- 最忙一天：优先按 prompt 数，Token 和工具调用作为补充；不要混成不可解释的神秘分数。
- 最长会话：以首条用户 prompt 到最后一个关联事件计算；中间超过 2 小时无事件时拆为 activity block，避免休眠一夜被算作连续编程。

### 8.4 生成代码语言占比

指标名称必须写成“可识别的 Agent 新增代码行语言占比”。归因来源按置信度排序：

1. `apply_patch`/结构化 patch 中的新增行：高置信度。
2. `Write`/创建文件工具中的完整正文：高置信度。
3. `Edit` 的 `new_string - old_string` 可确定新增部分：中置信度。
4. shell heredoc 重定向到明确文件：低置信度，V1 可默认不计或单列。
5. Agent 聊天中的 fenced code：不计入“已生成到项目”，可另做“回答代码块”指标。

按新增非空代码行统计占比；注释和空行可以分别记录，主指标默认包含注释、不包含纯空行。路径先做 repo/cwd 相对化，再按 pinned Linguist 规则识别语言。未知和非代码文本必须进入 `Other/Unknown` 分母或明确展示“已识别率”，不能静默丢弃。

同一个 tool call 重试、重复 patch 或成功事件重复上报时，以 `call_id + path + patch hash` 去重。失败的 patch 不计入已生成代码。

### 8.5 Token、模型和项目

- 输入 Token 展示时区分非缓存输入与缓存读取，内部保留原始值。
- Token 代表整个模型上下文和输出消耗，可能包含系统指令、历史上下文与工具结果，不能把输入 Token 直接称作“提示词字数”。
- 模型按 turn 关联，展示使用次数和 Token 占比；价格属于版本化配置，费用需注明“估算”。
- 项目标识优先使用规范化 cwd；展示名取 basename，但内部 key 使用路径 hash，防止同名项目合并。
- 子 Agent 会话可通过 `thread_spawn_edges` 或元数据关联；总量去重后计入主报告，另可展示“你召集了多少个子 Agent”。

### 8.6 Prompt 与工具的 V1 可观察指标

V1 只把日志中可直接观察或通过稳定结构规则得到的内容写入 `prompts.json` 和 `tools.json`。每项派生指标必须携带 `sampleSize`、`coverage`、`methodVersion` 和 `definitionId`。

Prompt 指标：

1. 字符数、分词数的中位数/P90，以及按日/月变化。
2. 标题、列表、代码块、文件路径、日志、附件引用等结构元素的出现比例。
3. 中文、英文和中英混合比例，以及高频词和技术词。
4. 每个 session 的 prompt 数、首条 prompt 长度和后续 prompt 数分布。
5. Prompt 与 turn 成功关联时，对应 tool call 数量分布；必须同时输出 `linkedPromptCoverage`。
6. 最长、结构元素最多、上下文信号最多和高频词最集中的代表性 Prompt；只展示可复现的选择规则和脱敏片段。
7. 高频词对应的代表性 Prompt 片段，以及至少在两条 Prompt 中精确重复的关键句；不把它们解释为任务意图。

工具指标：

1. 原始 tool name 和规范化类别的数量/趋势。
2. 每个 turn 的 tool call 数中位数/P90、最长可观察工具序列和无工具 turn 比例。
3. Read/Search/List、Edit/Write/Patch、Test/Build/Lint/Typecheck 等**调用类别**的序列 motif。
4. 修改后出现检查命令调用的比例，命名为 `postChangeCheckInvocationRate`，不称为验证成功率。
5. 可明确解析的 command exit code 分布及 `outcomeCoverage`；exit code 只描述命令结果，不推断任务成功。
6. 每个 turn 的修改文件数、语言数和新增/删除操作量。
7. 子 Agent spawn/wait 数和最大可观察并行数；不推断委派任务类型或是否正确汇总。

V1 不生成任务分类、需求演化、纠偏原因、指令清晰度、用户协作风格、项目熟悉曲线、任务成功率或 reasoning 相关指标。

### 8.7 模型实际使用分布

Codex 的 `turn_context.payload.model` 通常记录 turn 级模型，`payload.effort` 记录 reasoning effort；`session_meta.payload.model_provider` 和 `state_*.sqlite.threads.model` 可作补充。模型可能在同一个 session 内切换，因此必须按 turn 归因，不能采用 TokenDash 当前“只记会话第一个模型”的简化方式。

关联规则：

1. 优先用 `turn_context.payload.turn_id` 连接 prompt、tool call 和 token event。
2. `event_msg.task_started.turn_id` 可把早于 `turn_context` 出现的同 turn 用户消息连接回来。
3. 缺少 turn ID 时，才在同 session 内按事件顺序和时间窗口关联，并标为较低置信度。
4. `state_*.sqlite` 的 thread model 只能补充缺失值，不能覆盖 JSONL 中的 turn 级模型。
5. 同时保存 `model_raw` 和可配置的 `model_family`。自定义 gateway 名称、别名和未知模型不得擅自合并。
6. reasoning effort 是独立维度，不能把同一模型的 high/medium 合并后解释为相同配置。

可以直接统计：

- 每个模型的 turn、session、prompt、Token、tool call、活跃日和可归因新增行数。
- 每个模型下用户 prompt 的中位长度、结构元素比例和后续 prompt 数分布。
- 每个模型的 tool call 数、工具类别分布、修改操作量和检查命令调用率。
- 模型切换次数和原始相邻模型转换矩阵；只描述先后顺序，不解释切换原因。
- `model x 本地小时`、`model x 星期`、`model x 项目` 的交叉分布。
- 每个时段的模型使用占比 `P(model | timeBucket)`，以及每个模型自身的时段分布 `P(timeBucket | model)`；两者含义不同，应同时保留。

适合总结页的文案示例：

- “深夜 0～4 点的 68 个 turn 中，54% 使用了 gpt-5.x；白天则是 31%。”
- “模型 A 的 turn 中，每个 turn 调用工具的中位数是 8；样本为 86 个可关联 turn。”
- “你最常观察到的相邻模型序列是 A -> B，共 14 次；日志不记录切换原因。”

不能直接称为“用户在某模型下表现更好”。日志没有任务难度、真实完成质量、模型选择原因和人类对照。报告只展示实际使用分布，并遵守：

- 样本少于建议阈值（默认 20 个可判定 turn）的模型不做比例比较，只展示使用量。
- 按项目、月份和 reasoning effort 分开展示，避免把不同使用时期混成质量比较。
- 优先展示中位数和分布，不只展示容易被长 turn 拉高的平均值。
- 某模型只在一段时间内可用时，不把发布时间差异解释成用户的昼夜偏好。
- 除非日志能证明用户显式选择了模型，否则页面标题使用“模型使用分布”，不使用“模型偏好”。默认模型、自动路由和子 Agent 都可能决定最终模型。

官方主题的 `model-map` 页展示时间、星期、项目和原始转换矩阵，并固定注明“日志不记录模型选择原因，这不是模型质量排名”。这些数据进入 `models.json`。

### 8.8 Git 提交历史与 Codex 活动关联

Git 分析是可选的 `GitRepositoryEnricher`，不属于 CodexAdapter。它只在 session/project 的本地路径仍存在，或用户为旧设备路径配置了当前仓库映射时运行；仓库缺失只产生 `unavailable` 能力状态，不阻断 JSON bundle。

#### 仓库解析与只读扫描

1. 对 session cwd 执行只读的 `git -C <cwd> rev-parse --show-toplevel --git-common-dir`，兼容子目录和 worktree。
2. 跨设备仓库 identity 优先使用规范化 remote 的脱敏 hash；无 remote 时使用 root commit 集合 hash。不能只用目录名。
3. 用户可通过 sources 配置的 `projectAliases/repositoryMappings` 把旧路径映射到现存 clone。
4. 使用 `spawn` 的参数数组调用系统 Git，不拼接 shell 命令；设置 `GIT_OPTIONAL_LOCKS=0`，不执行 fetch、checkout、hooks、submodule update 或任何写操作。
5. 使用 `git log --all --no-merges` 获取报告周期（含边界缓冲）的 commit hash、parents、author/committer time 和 author identity；使用 `--numstat -z` 获取结构化文件增删数据。相同 hash 在多个 ref 中只计一次。
6. 默认使用 committer time 对齐本地活动，同时保留 author time 并标出明显偏差；amend、rebase 和 cherry-pick 可能改变时间或 hash。
7. 生成报告前先计算 refs fingerprint；未变化时复用缓存，refs 改写时重新扫描受影响周期并删除已不可达的缓存 commit。Git fingerprint 必须进入 report data watermark，避免 Codex 日志未变但新 commit 没有出现在报告中。永不自动访问远端网络。
8. 默认不读取完整 patch。commit subject、作者邮箱和路径在进入 bundle 前脱敏；协作者提交只有在 author identity 被用户允许时才进入“你的提交”统计。

作者过滤不能简单假设仓库所有 commit 都属于当前用户。默认收集每个仓库的 `user.name/user.email` 作为候选，仅保存 identity hash；用户可用 `--git-authors` 文件补充多设备邮箱。未匹配作者的 commit 可用于仓库背景趋势，但不能计入个人提交数。

#### V1 只保留精确 Git 事实

V1 不做基于时间窗口或文件重叠的 commit-turn 推断，也不把 Token 分配给 commit。只保留两类数据：

1. Git 仓库直接提供的 commit 历史、时间、作者过滤结果、numstat、语言和项目分布。
2. Tool call 明确执行 `git commit`，输出中解析到 commit hash，且该 hash 能在同一 repository identity 中验证存在的 `observedCommitCall`。

`thread.git_sha` 通常是 session 起始基线，只作为元数据，不计为 Codex 创建的 commit。解析不到 hash 的 `git commit` 调用只计入工具调用数量，不与具体 commit 建立关系。

可以生成：

- 每日/月 commit 数和提交活跃日。
- files changed、added/deleted lines、语言和项目分布。
- 提交时段、星期分布、提交间隔和最长连续提交日。
- prompt、Token、commit 三条按同一日期对齐的独立趋势轨道；只表达同期变化，不表达单次归因或因果。
- 已验证 hash 的 `observedCommitCall` 数量及其覆盖率。

V1 不生成 Prompt-to-Commit 漏斗、提交前 Token、模型参与 commit、commit 工作流、未关联产出判断或 commit 质量结论。`git.json` 明确区分 `repositories[]`/`commitTrend[]` 这类独立仓库历史与 `observedCommitCalls[]` 这类精确工具观察。

## 9. 官方主题页面规格与 JSON 引用

现有所有分析域都必须在官方主题中有明确消费者，不能只写入 JSON 后无人展示。官方主题注册 17 个语义页面：通常生成 13～16 页，Git 可用且满足作者过滤时最多 17 页。页码在运行时连续重排，但 `pageId` 永久稳定，URL 使用 `#/page/<pageId>`。

本节中的 JSONPath 是 Bundle Schema 1.0 的字段草案，也是后续实现 schema 和 fixture 的依据。页面只读取这些公开 JSON，不查询 SQLite、Codex 目录或 Git 仓库。

### 9.1 页面注册与选择规则

每个页面组件导出：

```ts
type ReportPageDefinition = {
  id: string;
  titleKey: string;
  requiredCapabilities: string[];
  requiredData: JsonPath[];
  optionalData: JsonPath[];
  isEligible(bundle: ReportBundle): boolean;
  render(bundle: Readonly<ReportBundle>): ReactNode;
};
```

选择规则：

- `cover`、`origin`、`scale`、`calendar`、`peak-day`、`clock`、`rhythm`、`prompt-style`、`words`、`projects`、`tools`、`tokens`、`closing` 是 13 个基础页。
- capability 为 false 时直接省略对应页；`insufficient_data` 时可降级为合并模块，不显示空图。
- 模型存在时生成 `model-map`；只有一个模型时展示单模型与 effort 概览，不制造对比。
- 没有结构化 file change 时省略代码和语言页；没有可用仓库时省略 Git 页。
- Git 页只要求有经过作者过滤的仓库历史，不要求把 commit 归因到 Codex；精确 `observedCommitCalls` 只作为附注。
- 所有页面右下角可打开“数据说明”，读取 `provenance.json` 中该 metric 的 `definitionId`、样本量和覆盖率。

### 9.2 视觉章节

官方主题不是 17 张同样的卡片，而是六个连续章节：

| 章节 | 页面 | 视觉方向 |
|---|---|---|
| 序章 | 01～03 | 高对比黑白、超大数字、少量珊瑚红强调 |
| 时间 | 04～07 | 白底、青绿/深红数据色、日历与时间刻度 |
| 表达 | 08～09 | 墨色文本、鲜黄关键词、排版和文字运动 |
| 工作面 | 10～11 | 项目轨道、工具流程线、克制的状态色 |
| 创作 | 12～15 | 代码、语言、模型和 Token 的密集数据视觉 |
| 收束 | 16～17 | 可选 Git 提交脉冲和事实型总结 |

背景使用纯色、细网格或由真实数据生成的纹理，不使用装饰性渐变球。桌面以一个主视觉占 60%～70% 画面，叙事文字贴边放置；移动端改为主数字、图表、说明的纵向顺序，不做缩小版桌面双栏。

### 01 `cover`：报告封面

- **主题**：这一周期留下了一条怎样的编码轨迹。
- **数据**：`manifest.report.*`、`overview.featuredFacts[0]`、`activity.calendar.days[]`、`provenance.coverage`。
- **布局**：全屏标题；背景用 `activity.calendar.days` 生成稀疏活动轨迹；底部只放周期、Codex、来源数和生成时间。
- **月/年差异**：标题分别使用年度报告/月报；月报突出月份，年报突出年份。
- **降级**：无 prompt 时进入 `empty-report` 专页，不继续生成正常报告。

### 02 `origin`：从第一句话开始

- **主题**：展示周期内第一条真实用户输入。
- **数据**：`prompts.firstInPeriod`、`projects.items[]`、`records.earliestActivity`。
- **布局**：提示词引用占画面主体，日期时间沿左侧竖排，项目名和字符数作为小注。
- **隐私**：`metrics-only` 时不显示正文，改为“第一条提示词在某时发出，共 N 字”。

### 03 `scale`：这一周期的规模

- **主题**：用少量大数字建立整体印象。
- **数据**：`overview.totals`、`overview.averages.promptsPerActiveDay`、`overview.featuredFacts[]`。
- **布局**：一个主数字根据第一条可用 `featuredFact` 决定，其他数字沿基线排开；禁止六个独立统计卡。
- **交互**：切换“对话 / Token / 工具”，但初始视图只突出一个结论。

### 04 `calendar`：编程日历

- **主题**：何时活跃，一眼看完整个周期。
- **数据**：`activity.calendar.days[]`、`records.busiestDay`、`records.longestStreak`，可选按 `codingDay` 对齐 `git.commitTrend[]`。
- **布局**：年报为全年 GitHub 风格热力图；月报为完整月历。点击某天显示 prompt、turn、Token、项目和 commit 数。
- **颜色**：强度按 prompt 分位数分档，零值保持中性；不能用绝对最大值压平其他日期。

### 05 `peak-day`：最投入的一天

- **主题**：把最忙 coding day 还原成一天的节奏。
- **数据**：`records.busiestDay`、`records.busiestDayPrompts`、`activity.dayTimelines[dayId]`、`projects.byDay[dayId]`、`tools.categories[]`，可选按 `codingDay` 对齐 `git.commitTrend[]`。
- **布局**：横向 24 小时时间轴为主视觉，prompt、tool、file change、commit 用不同形状而非仅靠颜色区分。
- **文案**：展示首次/末次活动、主要项目和总量，并引用这一天第一条和最后一条脱敏 Prompt，不生成“生产力分数”。

### 06 `clock`：最早与最晚

- **主题**：凌晨 4 点换日后的真实作息纪录。
- **数据**：`activity.byHour[]`、`records.earliestActivity`、`records.latestActivity`。
- **布局**：一个从 04:00 开始的环形 24 小时时钟；两条引线指向最早/最晚可信纪录。
- **回忆引用**：最早开工和最晚仍在输入的时间旁直接引用对应脱敏 Prompt；`metrics-only` 只显示字数。
- **说明**：固定显示 timezone 和 dayStartHour；绝对纪录样本不足时只显示分布。

### 07 `rhythm`：星期与连续性

- **主题**：工作日、周末、连续活跃和空窗共同组成的节奏。
- **数据**：`activity.byWeekday[]`、`activity.periodBuckets[]`、`records.longestStreak`、`records.longestGap`。
- **布局**：桌面左侧星期条带，右侧连续天数阶梯；移动端上下排列。
- **回忆引用**：存在周期内空窗时，展示最长空窗天数和回来后的第一条脱敏 Prompt。
- **月/年差异**：年报显示月份小趋势，月报显示周次小趋势。

### 08 `prompt-style`：你如何提出需求

- **主题**：Prompt 的长度、结构和上下文组成。
- **数据**：`prompts.length`、`prompts.structure`、`prompts.contextSignals`、`prompts.languageMix`、`prompts.sessionDepth`。
- **布局**：中央展示“典型 Prompt”轮廓，周围标注列表、代码块、路径、日志、附件等比例；底部是长度箱线/分位图。
- **文案边界**：只描述“结构化、带上下文、边做边调”，不评价 prompt 好坏。

### 09 `words`：你最常说的话

- **主题**：高频表达和技术词汇。
- **数据**：`prompts.terms.frequent[]`、`prompts.terms.languageGroups`、`prompts.terms.stopwordVersion`。
- **布局**：词云占主体，右侧/下方提供精确 Top 10 排名、次数和 prompt 覆盖数，保证词云不可读时仍有数据。
- **交互**：切换全部、中文、英文、技术词；词项不可跳转到未脱敏全文。

### 10 `projects`：项目宇宙

- **主题**：时间和注意力分布在哪些项目。
- **数据**：`projects.items[]`、`projects.timeline[]`、`projects.crossSourceMerges`。
- **布局**：按 prompt/Token 可切换的横向项目轨道，长度代表活跃跨度，粗细代表活动量；不使用装饰性气泡图。
- **隐私**：只显示脱敏 displayName；路径、remote 和设备名从不直接出现。

### 11 `tools`：工具足迹

- **主题**：Prompt 之后实际触发了多少工具，以及可直接观察到的调用序列。
- **数据**：`tools.totals`、`tools.categories[]`、`tools.linkedPrompt`、`tools.sequenceMotifs[]`、`tools.postChangeChecks`、`tools.outcomes`、`tools.subagents`。
- **布局**：主视觉是 Top 3 工具类别序列，底部并列工具调用量、每个已链接 Prompt 的工具数、修改后检查命令调用比例和 exit-code 覆盖。
- **口径**：序列名称只来自工具类别，例如 `read -> patch -> shell-check`；不把它命名为任务阶段。`postChangeChecks` 表示调用过检查命令，不表示验证或任务成功。
- **覆盖**：始终展示 `linkedPrompt.coverage` 与 `outcomes.coverage`；覆盖不足时只显示直接调用计数。

### 12 `code-footprint`：Codex 写下了什么

- **主题**：结构化工具记录中可归因的代码变更。
- **数据**：`code.totals`、`code.trend[]`、`code.attributionCoverage`、`code.changeRadius`。
- **布局**：大号新增/删除行数叠加一条周期趋势；文件数和识别覆盖率贴近图表标注。
- **口径**：固定显示“结构化 patch/write 记录，不等于 Git 总改动”。

### 13 `languages`：编程语言光谱

- **主题**：可识别新增代码行的语言组成。
- **数据**：`code.languages[]`、`code.languageByProject[]`、`code.attributionCoverage`。
- **布局**：使用横向 100% 堆叠光谱而非普通饼图；Top 语言有独立色，Other/Unknown 使用中性纹理。
- **交互**：切换新增行数/文件数；每种语言显示主要项目和识别率。

### 14 `model-map`：模型使用地图

- **主题**：不同模型实际在何时、哪个项目中出现。
- **数据**：`models.items[]`、`models.byHour[]`、`models.byWeekday[]`、`models.byProject[]`、`models.transitions[]`、`models.efforts[]`，以及按 `modelId` 对齐的 `prompts.byModel[]`、`tools.byModel[]`、`code.byModel[]`。
- **布局**：中心是 model × hour 热力矩阵，侧边为 effort 分布和模型切换流；单模型时改为模型/effort 概览并可与 Token 页合并。
- **文案边界**：可比较每模型下直接观察到的 Prompt 长度、工具调用和新增行分布，但只称“可观察活动差异”；固定注明日志不记录选择原因，不称偏好、不解释为用户表现或模型质量。

### 15 `tokens`：Token 旅程

- **主题**：输入、缓存、输出、推理 Token 随时间如何变化。
- **数据**：`tokens.totals`、`tokens.trend[]`、`tokens.byModel[]`、`tokens.cacheRatio`、`tokens.costEstimate`。
- **布局**：年报按月、月报按日的堆叠面积/条形趋势；顶部突出缓存命中带来的读取量。
- **成本**：只有价格配置完整时显示估算，并引用 `provenance.producers.tokens.pricingVersion`。

### 16 `git-pulse`：提交脉冲（可选）

- **主题**：本地 Git 提交节奏与 Codex 活动在同一周期中的并列趋势。
- **数据**：`git.availability`、`git.commitTrend[]`、`git.commitStats`、`git.languageStats[]`、`git.observedCommitCalls[]`，并按 coding day 对齐 `activity.calendar.days[]` 与 `tokens.trend[]`。
- **布局**：commit、prompt、Token 同期对齐的三条独立轨道，避免误导性双轴；下方显示提交规模分布。
- **边界**：三条轨道仅表达同期变化，不连接单次 Prompt、Token 与 commit。只有 hash 已解析且仓库验证成功时，才在附注中显示 `observedCommitCall` 数量。

### 17 `closing`：周期事实集

- **主题**：用最有辨识度的直接事实收束，不生成性格、协作风格或能力画像。
- **数据**：`overview.featuredFacts[]`、`overview.totals`、`records.*`、`records.memoryMoments[]`、`code.languages[]`、`provenance.coverage`、`provenance.sources[]`、`provenance.diagnostics`。
- **布局**：最多 3 个事实标签、4～6 个数字、周期最后一条脱敏 Prompt 和一句中性结语；标签只能由可追溯规则生成，例如“凌晨活动 18 天”“TypeScript 可识别新增行最多”“最长连续活跃 12 天”。底部展示数据覆盖和隐私状态。
- **分享**：页面可提供仅用于截图/演示的视觉隐藏开关，但这不是安全边界，原始 JSON 仍在静态文件中。需要公开 host 时必须重新用 `redacted` 或 `metrics-only` bundle 构建。

### 9.3 JSON 消费完整性

官方主题的 fixture test 必须建立“JSON 文件 -> 页面”的完整映射：

| JSON | 消费页面 |
|---|---|
| `manifest.json` | 01、17，以及所有页面的周期/能力上下文 |
| `overview.json` | 01、03、17 |
| `activity.json` | 01、04、05、06、07、16 |
| `prompts.json` | 02、08、09、14 |
| `projects.json` | 02、05、10、13 |
| `tools.json` | 03、05、11、14 |
| `code.json` | 05、12、13、14、17 |
| `models.json` | 05、14 |
| `tokens.json` | 03、05、15、16 |
| `git.json` | 04、05、16 |
| `records.json` | 02、04、05、06、07、17 |
| `provenance.json` | 所有页面的数据说明，重点是 01、11、12、14、16、17 |

测试应遍历 schema 顶层字段，确保每个稳定公开字段被某个页面、数据说明面板或显式 `nonVisualMetadata` 清单消费。新增 JSON 字段但未声明消费者时 CI 失败，防止分析能力悄悄变成“只导出、不展示”。

## 10. 官方静态主题交互与视觉约束

- 桌面滚轮/方向键、移动端纵向 swipe，一次只切一页；提供右侧细进度条和页码。
- 每页使用 `100dvh`，内容区设置可控的最小/最大高度；矮屏允许页内滚动，避免文字重叠。
- 图表在页面进入时播放一次短动画；遵守 `prefers-reduced-motion`。
- 颜色按章节变化，但建立统一中性色和高对比文本，不做单一紫蓝渐变主题。
- 数字动效不能引起布局跳动，使用等宽数字和固定容器尺寸。
- 所有 ECharts 图提供文本摘要/表格替代，键盘可达。
- 原始提示词、绝对路径默认不进入截图模式；视觉开关不能替代重新生成脱敏 bundle。
- 刷新页面可通过 hash 恢复当前页，例如 `index.html#/page/calendar`，不依赖服务器路由。

## 11. 推荐目录结构

```text
vibe-coding-wrapped/
├── apps/
│   └── cli/
│       └── src/
│           ├── commands/          # import/generate/render/build/doctor/theme
│           ├── output/            # 进度条、错误和机器可读日志
│           └── main.ts
├── packages/
│   ├── contracts/                 # CanonicalEvent、Report Bundle 类型
│   ├── bundle-schema/
│   │   ├── schemas/               # 发布的 JSON Schema
│   │   └── src/                   # 校验、版本兼容、loader
│   ├── data-source-core/           # Adapter 接口、registry、checkpoint
│   ├── adapter-codex/
│   │   └── src/
│   │       ├── discovery.ts
│   │       ├── jsonl-reader.ts
│   │       ├── event-normalizer.ts
│   │       ├── prompt-deduper.ts
│   │       ├── token-normalizer.ts
│   │       ├── tool-call-normalizer.ts
│   │       └── schemas.ts
│   ├── storage/
│   │   ├── migrations/
│   │   └── src/                    # repositories、事务、checkpoint
│   ├── import-engine/
│   │   └── src/                    # worker pool、batch、进度、诊断
│   ├── analysis-core/
│   │   └── src/
│   │       ├── context.ts          # AnalysisScope、memoized dataset/artifact
│   │       ├── dag.ts              # 依赖注册、拓扑排序、失败传播
│   │       ├── scheduler.ts        # CPU/DB/Git/serialize 资源限流
│   │       ├── artifact-cache.ts
│   │       └── deterministic.ts    # 稳定排序和归并
│   ├── fact-datasets/
│   │   └── src/
│   │       ├── registry.ts
│   │       ├── loaders/            # 每张事实表唯一的 scope query
│   │       └── indexes/            # byTurn/bySession/byProject/byTime
│   ├── feature-engine/
│   │   └── src/
│   │       ├── prompts/            # 分词、长度、结构、上下文、语言
│   │       ├── tools/              # 类别、检查调用、结果覆盖、序列
│   │       ├── languages/
│   │       └── activity-blocks/
│   ├── git-enricher/
│   │   └── src/                    # repo resolver、只读 log、精确 commit-call parser
│   ├── analyzers/
│   │   └── src/
│   │       ├── activity/           # -> activity.json
│   │       ├── prompts/            # -> prompts.json（含 terms）
│   │       ├── projects/           # -> projects.json
│   │       ├── tools/              # -> tools.json
│   │       ├── code/               # -> code.json（含 languages）
│   │       ├── models/             # -> models.json
│   │       ├── tokens/             # -> tokens.json
│   │       ├── git/                # -> git.json
│   │       ├── records/            # -> records.json
│   │       ├── overview/           # -> overview.json
│   │       └── provenance/         # -> provenance.json
│   ├── bundle-generator/           # 指标到公共 JSON bundle
│   ├── renderer-core/              # 主题发现、构建、静态产物校验
│   └── privacy/                    # secret/path 检测、分享脱敏
├── themes/
│   └── official/
│       ├── theme.json
│       ├── src/
│       │   ├── report-pages/       # 官方主题的动态 13～17 页
│       │   ├── components/
│       │   ├── charts/
│       │   ├── motion/
│       │   └── entry.tsx
│       └── vite.config.ts          # base: "./"，输出纯静态资源
├── resources/
│   ├── stopwords/
│   ├── dictionaries/
│   └── linguist/                   # 固定版本生成的语言映射
├── tests/
│   ├── fixtures/codex/             # 合成、脱敏的各版本 JSONL
│   ├── fixtures/bundles/           # 年报、月报、缺失能力等金标 bundle
│   ├── contract/                   # 所有 adapter 共用契约测试
│   ├── dag/                        # 依赖、并行、失败隔离、确定性测试
│   ├── cache/                      # watermark 与精确失效测试
│   ├── integration/
│   └── e2e/
├── scripts/                        # 更新 Linguist 映射、生成 fixture
├── docs/
│   ├── metrics.md                  # 面向用户的统计口径
│   ├── adapter-authoring.md
│   ├── theme-authoring.md
│   ├── bundle-format.md
│   └── privacy.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

不要在 V1 为每一个 analyzer 单独发包；上面的 package 是责任边界，不是必须立刻拆成 npm 发布单元。若 monorepo 开销过大，可保留同样边界为 `src/modules/*`，但禁止把 Codex 字段渗透进分析器。

## 12. CLI 与静态输出契约

```text
vibe-wrapped doctor [--codex-home PATH]... [--sources FILE] [--json]
vibe-wrapped import [--codex-home PATH]... [--sources FILE]
                    [--workers N] [--force]
vibe-wrapped generate (--year YYYY | --month YYYY-MM)
                      [--source SOURCE_ID]...
                      [--git auto|off] [--git-authors FILE]
                      [--repository-mappings FILE]
                      [--profile]
                      [--timezone IANA] [--day-start 0..23]
                      [--privacy full|redacted|metrics-only]
                      --out BUNDLE_DIR
vibe-wrapped render BUNDLE_DIR [--theme official|PATH]
                    [--single-file] --out SITE_DIR
vibe-wrapped build (--year YYYY | --month YYYY-MM)
                   [--codex-home PATH]... [--sources FILE]
                   [generate options] [render options] --out SITE_DIR
vibe-wrapped sources list
vibe-wrapped sources remove SOURCE_ID
vibe-wrapped theme validate THEME_PATH
```

约定：

- `--year` 和 `--month` 必须二选一；非法日期、未来周期或完全无数据时返回清楚的非零退出码。
- `--codex-home` 是可重复参数，顺序不影响去重结果。显式传入一个或多个 root 时，不再隐式加入当前 `~/.codex`。
- `import` 将 root 注册到本地索引；`generate` 默认汇总所有启用且已导入的 root，可用重复的 `--source` 限定范围。
- `sources remove` 默认只注销来源并重新计算引用；仅由该 root 提供的事实会被移除，仍有其他 provenance 的事实保留。
- `build` 先导入本次声明的全部 root，再生成 bundle 和静态站点，适合一次命令合并当前设备与备份设备。
- `--git auto` 是默认值：只扫描能从 session cwd 或显式 mapping 解析到的本地仓库；`--git off` 完全跳过 Git 命令并在 bundle 标为 disabled。
- `--git-authors` 可声明跨设备使用过的 name/email；使用文件而非直接命令参数，避免邮箱进入 shell history/process list。索引和 bundle 只保存脱敏 hash。未声明时使用各仓库本地 Git identity 候选并在 provenance 标注推断来源。
- `--profile` 输出 DAG、dataset load count、cache hit 和阶段耗时，用来验证并行与复用，不改变 bundle 统计内容。
- `generate` 的输出始终是 bundle 目录；`render` 的输入始终是 bundle 目录，二者可由不同程序、机器或时间执行。
- `build` 在站点目录的 `_report/` 保留一份原始 bundle，除非指定 `--omit-bundle-copy`；即使官方主题把数据编译进 JS，也不丢失机器可读结果。
- 默认的人类可读进度写 stderr；`--json`/`--json-progress` 输出稳定的机器可读事件，方便脚本集成。
- 未指定 `--out` 时不在当前目录散落文件；应要求显式路径或使用可预测的 `./vibe-wrapped-<period>` 目录并先提示。
- 已存在且非空的输出目录默认拒绝覆盖；`--force` 只原子替换精确输出目录，不能递归清理其父目录。
- snapshot key 必须包含 `period.kind + period.value + timezone + dayStartHour + agentScope + selectedSourceSet + analyzerVersion + codexDataWatermark + gitRefsFingerprintSet`，避免不同设备集合、Git 新提交、年报/月报或不同 4 点设置错误复用缓存。
- 成功退出前验证 JSON Schema、manifest checksum、HTML 入口和全部静态资源引用；任何一步失败都不能发布半成品目录。

## 13. 测试策略

### 13.1 必测 fixture

- 同一 prompt 同时出现于 `event_msg` 和 `response_item`。
- 两个 root 中完全相同的 session/file 只计一次，但 provenance 保留两个来源。
- 一个 root 是旧前缀、另一个 root 是追加后的完整 session；合并结果等于完整事件 union，不重复累计 Token。
- 相同 session ID 的两个副本各自有独有事件，以及同一语义事件内容冲突的确定性处理和诊断。
- root realpath 重复、父子 sessions 路径重叠、某 root 临时不可访问或从索引中移除。
- 同一 Git remote 在不同设备 cwd 下的显式合并，以及同名但不同仓库不被误合并。
- 中英文混合、代码块、XML、图片占位的 prompt。
- 新旧 `custom_tool_call` / `function_call`。
- 重复 `token_count` 快照、缺少 `last_token_usage`、会话内切换模型。
- 成功/失败/重复 patch，新增、删除、重命名、二进制文件。
- 文件最后一行不完整、单行坏 JSON、未知事件类型。
- append、truncate、rename、parser version 升级后的 checkpoint。
- 03:59 与 04:00 边界、跨年、含 DST 的 IANA 时区。
- 空年份/月份、跨月 03:59 与 04:00、只有 prompt 没有 patch、只有 metrics-only 数据。
- 年报/月报 bundle 的 schema、checksum、确定性排序和 major version 拒绝策略。
- 静态站点部署在域名根路径和两级子路径；构建结果不得请求 `/api` 或绝对 `/assets`。
- `--single-file` 中包含 `</script>`、U+2028/U+2029 的提示词片段不能逃逸数据标签。
- tool category、检查命令调用分类的正例/反例金标，并验证 `linkedPromptCoverage` 的分子、分母和未绑定调用处理。
- tool result 同时覆盖结构化 exit code、无 exit code、opaque string，验证 `outcomeCoverage`；退出码不得被提升为任务成功结论。
- 修改事件后调用测试/构建/lint 命令时只增加 `postChangeCheckInvocationRate`，不产生验证成功、失败恢复或任务完成字段。
- 相邻模型转换 fixture 只按 turn 时间和稳定 ID 排序，原样记录 `A -> B`，不生成切换原因或任务类型。
- 临时 Git fixture 覆盖 commit tool call 的精确 hash：只有解析成功且能在同一 repository identity 中验证的 hash 才进入 `observedCommitCalls`。
- Git 仓库缺失、worktree、无 remote、多 ref 同一 hash、merge、rename、binary、amend/rebase 后 refs 改写。
- 多作者仓库、跨设备邮箱集合和未授权协作者 commit；个人统计不能混入其他作者。
- Git 命令必须通过参数数组执行；包含空格、引号和以 `-` 开头的仓库路径不能形成参数注入。
- 全部 artifact 同时请求相同 dataset 时，loader 只执行一次；并发请求共享同一个 Promise。
- DAG 节点只在依赖完成后启动，无依赖节点能并行；可选 Git/code 失败不阻断基础 bundle。
- 分别改变 prompt、token、tool、Git refs、timezone、privacy 和 theme，断言失效集合与 7.7 表一致。
- `--workers 1/2/4` 生成的规范 JSON 和 checksum 完全相同。
- generate 阶段不得打开 Codex JSONL，render 阶段不得访问 SQLite、Git 或任何 Codex root。

### 13.2 金标与性质测试

- 用小型人工 fixture 保存期望的 prompts、Token、代码新增行、语言占比和多 root 合并金标。
- 不变量：语言行数之和等于可归因非空新增行；占比之和约等于 100%；活跃日一定落在所选报告周期对应的 coding day。
- Adapter contract test：坏记录隔离、稳定 event ID、幂等重放、能力声明一致。
- Analysis contract test：analyzer 只能通过 `AnalysisContext` 声明 dataset/artifact 依赖，不能直接 import storage。
- Bundle contract test：V1 JSON Schema 和金标 bundle 中不得出现 `taskType`、`taskTransition`、`switchReason`、`taskSuccess`、`projectFamiliarity`、`reasoningPlan`、`attributedCommitTokens` 或同义公开字段。
- Metric contract test：所有派生指标必须包含 `sampleSize`、`coverage`、`evidence`、`methodVersion`、`definitionId`；`evidence` 只能是 `direct` 或 `structural_derived`。

### 13.3 性能验收

以约 1 GB / 1500 JSONL 文件作为基准，而不是只测几十 KB fixture：

- 峰值内存目标小于 500 MB。
- 首次导入目标在常见 8 核 SSD 机器上小于 90 秒；先测量再收紧。
- 无变化的二次导入小于 2 秒。
- 活跃会话追加后的增量导入小于 3 秒。
- report snapshot 已存在时，JSON bundle 生成小于 1 秒（不含主题构建）。
- 典型几十个本地仓库的无变化 Git 二次扫描只比较 refs fingerprint；不重新遍历完整历史。
- 官方主题静态构建目标小于 10 秒，产物在普通静态 host 首屏不依赖任何后端请求。
- profile 中同一 dataset 的 load count 必须为 1；记录总 DB query 数、JSONL 读取字节、峰值 dataset 内存和各 DAG phase 并行度。

性能测试必须记录机器、Node 版本、worker 数和磁盘类型，不能只保留一个孤立数字。

## 14. 隐私与安全

- CLI 全程本地处理，不启动监听端口；最终站点是纯静态文件。
- 官方主题在 `index.html` 设置严格 CSP，不加载远程字体、脚本、图片和分析 SDK，也不允许外连上报。
- 日志只记录 source ID、行号和错误码，不记录 prompt、patch、命令参数。
- 分享模式默认隐藏提示词正文、绝对路径、仓库远端和用户名。
- Git remote、作者 name/email、完整 commit subject 和绝对文件路径默认不进入静态站点；只导出脱敏 hash、截断安全摘要和聚合值。
- 秘密检测至少覆盖常见 API key、JWT、PEM 私钥、Bearer token、GitHub token；检测到的片段在 UI 和 snapshot 中替换。
- 提供“清除本地索引与报告”命令，只删除应用自己的数据目录，不碰 `~/.codex`。
- 应用数据库权限设置为当前用户可读写；生成 bundle 前再次执行脱敏，而不是只依赖导入时处理。
- 静态站点一旦被公开 host，其中的数据也会公开。CLI 在 `full` 模式渲染 HTML 前必须给出醒目警告，官方主题默认推荐 `redacted`。

## 15. 实施顺序

### Milestone 1：数据正确性

- 建立 workspace、contracts、storage migration。
- 实现 Codex discovery、流式 JSONL reader、prompt/token/tool 标准化。
- 实现多 source root 注册、跨 root session/event 去重和 provenance。
- 建立脱敏 fixture 和契约测试。
- 实现 `doctor` 与导入诊断。

验收：相同数据无论放在一个还是多个 root，统计结果都不翻倍；输入 root 顺序不影响输出；坏行不影响其他会话；prompt 与 Token 金标通过。

### Milestone 2：增量与分析

- worker pool、单写入者、checkpoint 和 parser version。
- 实现 analysis-core、DatasetRegistry、DAG scheduler、资源限流和确定性归并。
- 实现 L3 entity feature cache；为 L4 artifact cache 保留接口和独立版本，首版可按风险分阶段启用。
- activity、prompt terms、project、token、tool、language analyzers，以及可选只读 Git enricher。
- 实现仓库身份、refs 缓存、author filter，以及精确 commit-call hash 解析与仓库验证。
- 实现 4 点换日及 DST 测试。
- 年/月 `ReportPeriod`、report snapshot 与算法版本。

验收：约 1 GB 基准满足内存目标，二次导入只处理变化文件；单次生成每个 dataset 只加载一次；无依赖 artifacts 确实并行；不同 worker 数 checksum 一致；语言分母与新增行金标一致；Git 不分配 Token，只有已解析且仓库验证的 hash 进入精确观察集合。

### Milestone 3：Bundle 与静态报告

- 完成多文件 Report Bundle、JSON Schema、checksum 和版本兼容测试。
- 完成 renderer core、官方 React 主题和纯静态 Vite 构建，固定 `base: "./"`。
- 先完成封面、首条提示词、年历、作息、高频词、语言占比、总结 7 个核心页。
- 再按第 9 节完成全部 17 个页面组件、能力降级、JSON 消费完整性测试和分享隐私开关。
- Playwright 通过静态文件服务器覆盖桌面、手机、矮屏、子路径部署、减少动态效果和刷新恢复页码。

验收：输出目录可直接交给任意静态 host；断开 CLI/Node 进程后仍完整工作；所有页面无重叠；关闭敏感信息后 JSON 和 HTML 中均不存在原文与绝对路径。

### Milestone 4：为多 Agent 做证明

- 用一个只含合成数据的 `FixtureAdapter` 跑通 adapter contract tests。
- 确认 analyzer 和 bundle generator 中没有 `if (agent === "codex")`。
- 写 `adapter-authoring.md`，再开始 Claude/OpenCode 适配，避免过早抽象未经验证的共同点。

## 16. 需要尽早固定的产品决策

建议 V1 采用以下默认值，并允许通过 CLI 参数修改：

- 报告周期：必须显式传 `--year` 或 `--month`，避免脚本在跨年/跨月后悄悄改变输出。
- 数据源：未显式传路径时使用当前 `CODEX_HOME`/`~/.codex`；显式传入的多个 root 只合并这些来源，不暗中加入默认目录。
- 时区：系统 IANA 时区。
- coding day 起点：04:00。
- 文本存储与静态导出：默认 `redacted`；只有显式传 `--privacy full` 才保留完整引用，并在 render/build 时再次警告。
- 语言占比单位：Agent 可归因的新增非空代码行。
- 最忙日排序：prompt 数，Token 仅作并列决胜。
- 活动 block 超时：连续 120 分钟无事件则断开。
- 首条提示词：报告周期内首条；“历史首条”仅作补充。
- 页面：官方主题注册 17 个语义页，按能力动态生成约 13～17 页，不为缺失数据填 0。

最重要的实现优先级是先让事实表和统计口径可信，再做动画。翻页视觉可以迭代，错误地重复计算 prompt、把固定时区当 DST、或把仓库现存代码冒充 Agent 生成代码，会直接破坏周期报告的可信度。
