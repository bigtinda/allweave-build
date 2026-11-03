# 00 架构重写与内核重构计划

> 状态：文档清理与重写已完成（2026-11-03）；S0–S9 尚未开始　基线：`codex/v1` 工作树（在 v1.1.6 之后重核）　日期：2026-11-03
> 依据：`docs/audit/docs-audit.md`（42 份文档逐份核对）、`docs/audit/code-audit.md`（19 组清理项，191 个文件可达性分析）、`docs/audit/kernel-map.md`（内核 5 包 12 文件 26 符号接缝、`AgentSession` 18 个职责块）
> 配套图：`01-project-architecture.svg`（细化）、`02-kernel-architecture.svg`（新绘）、`03-target-architecture.svg`、`04-roadmap.svg`

---

## 0. 一页纸

三句话：

1. **代码的分层比文档写得好。** `apps/server` 的组合根、传输、会话编排、持久化投影、工作区、服务都已经按能力分目录；真正的债不在 `apps/` 的目录结构，而在一处——`packages/coding-agent/src/core/agent-session.ts`（4398 行，18 个职责块）。
2. **文档已系统性腐化。** 42 份对象里 34 处仍按 Tauri/Rust 描述桌面（实际是 Electron），2 条相对链接指向已删除的 `desktop/src-tauri/`，根 README 宣称的 `PI_CONSOLE_TOKEN` 在代码里 0 引用，Node 版本三处互相矛盾（`engines >=22.19.0` vs 四份文档 `24.3+`）。
3. **不需要新工程，需要三件事：** 清账（文档 + 死代码 + 仓库卫生）、把文档重写成"事实 / 目标 / 阶段"三件套、按 S0–S9 十步把内核逐块换成自研并每步可回退。

本轮交付：本文 + 两张图 + 清理清单。评审通过后按 §8 顺序执行。

---

## 1. 目标、非目标、硬约束

### 1.1 目标

对齐用户提出的三条产品标准：**可用、可扩展、可维护**，并顺便把"标准化开发流程"落在可检查的产物上。

| 维度 | 可检查的定义 |
|---|---|
| 可用 | 崩溃/重启后 in-flight run 恢复率 100%；审批不丢；桌面与 Web 同一套后端行为 |
| 可扩展 | 新增一个工具 ≤1 个文件、1 处注册；新增一个模型 provider 不碰会话代码；扩展不获得未授权能力 |
| 可维护 | 单文件 ≤800 行（例外需登记）；内核边界违规 0；循环依赖 0；文档与代码不一致项 0（脚本校验） |
| 可学习 | 每阶段一篇文档，固定六要素；每阶段有度量前后对比与回退开关 |

### 1.2 非目标

- 不删除 `packages/**`（上游 pi 是 fork 的产品资产，只记录"产品未使用"）。
- 不改 `/api`、`/ws`、`apps/shared/src/protocol.ts` 的对外语义（可加字段，不破坏）。
- 不做微服务、不引入第二套 Agent 框架、不默认多代理。
- 不在本轮重写桌面外壳（Electron 现状可用）。

### 1.3 硬约束（全部有代码证据，违反则重构失败）

| # | 约束 | 证据 |
|---|---|---|
| H1 | `AgentSessionEvent` 联合类型是跨层冻结契约，先冻结再动实现 | `packages/coding-agent/src/core/agent-session.ts:196-237`；`apps/server/src/sessions/pi-events.ts:3` 消费；10 个测试依赖 |
| H2 | 工作台授权依赖 `tool_call` 钩子**同步**返回 `{block}`；语义不能变 | `apps/server/src/sessions/tool-factory.ts:110-127`；`agent-session.ts:658-724` |
| H3 | Pi JSONL（`SessionManager`，版本 3，entry id，append-only 树）是对话真相源，工作台只读 | `core/session-manager.ts:41`、`1079-1080`；`apps/server/src/persistence/transcript.ts:31-88` |
| H4 | 本地单用户、无 OS 沙箱是**当前契约**，任何"安全"表述必须先改代码再改文档 | `apps/server/src/bootstrap/create-app.ts:134-135`（`"No sandbox"`）；`sessions/pi-runtime.adapter.ts:313`（`setProjectTrusted(true)`） |
| H5 | 唯一守住的分层是 `agent-core` 不依赖 `coding-agent`；新包不得破坏它 | `packages/agent/src/agent-loop.ts`；`packages/coding-agent/src/core/sdk.ts:46` |

---

## 2. 事实基线（2026-11-03 实测）

### 2.1 规模

| 单元 | 规模 | 最大文件 |
|---|---|---|
| `apps/server/src` | 42 个文件（41 .ts + `office-preview.ps1`） | `sessions/coordinator.ts` 660、`browser.ts` 582、`app-plugins.ts` 470、`workspaces/service.ts` 473、`remote-workspaces.ts` 440、`sessions/pi-runtime.adapter.ts` 413 |
| `apps/web/src` | 48 个 .ts/.tsx（55 个文件） | `pages/ResourcesPage.tsx` 1719、`App.tsx` 1333、`pages/WorkbenchSettingsPanels.tsx` 1103、`features/chat/ChatPage.tsx` 1078 |
| `apps/shared/src` | 4 个文件 | `protocol.ts` 321（前后端唯一契约）、`browser.ts`、`plugins.ts`、`format.ts` |
| `desktop` | 16 个文件（不含 `dist/`） | `src/main.ts`（Electron 主进程，spawn 随包 Node） |
| `packages/coding-agent/src` | `core/` 98 个 .ts | `core/agent-session.ts` **4398**、`core/session-manager.ts` 2013、`core/extensions/{types 2273, runner 1560, loader 876}`、`core/compaction/compaction.ts` 1120 |

### 2.2 内核形状（"一个类 + 一堆配套"）

- 工作台到内核的接缝：**5 个包 × 12 个文件 × 26 个符号 / 33 处引用**；`pi-coding-agent` 之外还直接 import `pi-ai`（3 文件）、`pi-agent-core`（1）、`chord`（3）、`pi-env`（1），其中 `chord` 与 `pi-agent-core` **未在 `apps/server/package.json` 声明**（靠 monorepo 提升），`pi-env` 已声明。
- `packages/coding-agent/src/index.ts`（495 行）是全量 barrel，把 core + CLI + modes + TUI 一起导出，接缝没有"面"。
- `AgentSession` 18 个职责块，最畸形的三块：持久化写在事件回调里（`1103`、`1144-1185`）、压缩触发散在 4 处（`776`/`838`/`905`/`1884`）、扩展绑定 `3360-3493` 把 30 个私有能力编成回调交给 runner。
- 双权威：内核写 JSONL（entry id），工作台写 SQLite（`randomUUID` 生成 message id）；重载时以 JSONL 重建对话、用 meta 合并 UI 字段，两条写路径无共同事务。

### 2.3 八个问题（沿用 `harness-assessment.md` 编号，本次全部复核）

| # | 问题 | 级别 | 证据 |
|---|---|---|---|
| P0-1 | 三套运行时并存（Pi classic 主链路 / durable 仅 experimental / protocol+client+server 未用） | P0 | `apps/` 无任何 `pi-durable`/`pi-protocol`/`pi-client` import |
| P0-2 | 崩溃不恢复 in-flight run 与审批 | P0 | `sessions/event-projector.ts`、`sessions/tool-authorization.ts:35`（仅内存 Map） |
| P0-3 | 无 OS 沙箱 + 项目 `.pi/extensions` 自动信任 | P0 | `create-app.ts:134-135`、`pi-runtime.adapter.ts:313` |
| P0-4 | 每个非 delta 事件写全量快照（长会话 O(n²) 写放大） | P0 | `event-projector.ts:311-352` |
| P0-5 | 中文 token 估算失真（`ceil(chars/4)`、`CHARS_PER_TOKEN=3.5`） | P0 | `packages/coding-agent/src/core/compaction/compaction.ts:295-339`、`packages/ai/src/utils/estimate.ts:15` |
| P1-6 | 压缩请求不复用父前缀缓存（`cacheRetention:"none"`） | P1 | `compaction.ts` 调用点 |
| P1-7 | 工具结果按字节截断、bash 无默认超时 | P1 | `core/tools/truncate.ts:11-12`、`core/tools/bash.ts:42` |
| P1-8 | 缺任务级评测与观测（telemetry 未接入） | P1 | `packages/telemetry` 无工作台调用点 |

补充缺陷（本次审计新发现，进 S1）：
- `apps/server/src/sessions/pi-events.ts:24` 用 `randomUUID()` 生成 message id，`persistence/transcript.ts:41/53` 用 `entry.id` → 同一消息"运行中"与"重启后"的 id 不同，前端按 id 合并会重复。
- `apps/server/src/sessions/tool-authorization.ts:61` `expiresAt` 用常量 `approvalTimeoutMs`，定时器用 `this.timeoutMs`（`:64`），自定义超时时两者不一致。

### 2.4 文档现状

42 份对象：删除 4、归档 18、重写 9（含根 README 与 `.env.example`）、保留 11。硬矛盾清单见 `docs/audit/docs-audit.md` §4；本计划 §3.1 给出动作。

---

## 3. 清理（阶段 C：先做，做完再动架构）

> **执行状态（2026-11-03）：已完成**。评审决策（用户）覆盖了本节最初"能归档就不删除"的原则：旧文档体系**直接删除**、不归档；清理范围额外明确为 `backups/`、`desktop/dist/`、`.agents/`、`README.interview.md`。保留边界不变：`packages/**` 不动、运行数据 `.pi-console/` 与 `node_modules/` 不动、桌面打包链不动。实际执行记录见 §3.4。

原则：**旧文档直接删除（用户决策）；代码能删则删，只限"0 引用且无历史价值"**；`packages/**` 不动。

### 3.1 文档

**删除（4，0 引用且被新图取代）**

| 路径 | 理由 |
|---|---|
| `docs/architecture/current-code-architecture.md` | 2026-11-01 快照，被 `01-project-architecture.md` 取代 |
| `docs/architecture/current-code-architecture.svg` | 同上（仅被上一行引用） |
| `docs/architecture/current-code-architecture.png` | 同上（232.6KB，孤儿） |
| `docs/architecture/harness-layers.svg` | 0 引用，被 `02-kernel-architecture.svg` 取代 |

**归档到 `docs/architecture/archive/`（17）**：`01-current-architecture.md`、`02-target-architecture.md`、`03-refactoring-plan.md`、`04-baseline.md`、`05..15`（11 篇阶段记录）、`project-architecture.md`、`project-architecture.svg`、`harness-assessment.md`、`16-kernel-split-plan.md`、`kernel-split-{current,target,roadmap}.svg`、`legacy-issues.md`、`docs/rebuild-frontend/implementation-notes.md`、`docs/rebuild-frontend/refactoring-plan/README.md`。
归档时在 `docs/architecture/archive/README.md` 写一句头注：**历史记录，部分内容已过期（桌面曾写 Tauri，实际为 Electron），当前事实见 `../01/02`。**

**保留（不改内容）**：`README.pi.md`、`AGENTS.md`、`desktop/{README,AGENTS}.md`、`docs/brand/build-banner.svg`、`docs/brand/workbench.png`（被根 README 引用）。

**重写（9）**：根 `README.md`、`apps/README.md`、`apps/server/.env.example`、`docs/workbench-ui.md`、`docs/plugin-architecture.md`、`docs/architecture/README.md`、`README.interview.md`（移出仓库或归档）。重写时以 §1.3 的硬约束与真实代码为准，尤其：删除 `PI_CONSOLE_TOKEN`；Node 版本统一为 `engines` 的 `>=22.19.0`；桌面写 Electron；"内核为进程内 SDK"而不是"Pi RPC 控制内核"。

### 3.2 代码（19 组，分三批）

**批次 1：立即可做（9 项，不改行为）**

| # | 动作 | 证据 |
|---|---|---|
| C1 | 删除 `apps/server/src/app.ts`（6 行兼容 re-export，0 importer） | 全仓 import 0 命中 |
| C2 | 删除 `apps/server/src/sessions/pi-events.ts` 的 `adaptRpcEvent`（62 行，被 `adaptSdkEvent` 完全取代） | 仅定义处 1 命中 |
| C3 | 清理 27 个文件里的 48 个未使用 import 绑定 | `web-unused.mjs`（tsc 未开 `noUnusedLocals`） |
| C7 | 删除 4 个孤儿文档/图（见 §3.1） | 0 引用 |
| C17 | 删除 `.env.example` 的 `PI_CONSOLE_TOKEN`，修正根 README 安全表述 | 代码 0 读取 |
| C19a | 修 2 条指向 `desktop/src-tauri/` 的死链 | `refs.mjs` 539 条链接校验 |
| C8 | 删除 `desktop/icons/icon.png`（`icon.ico` 才是打包输入） | 0 引用 |
| C18 | 移除根依赖 `motion`（全仓 0 import），单独提交 + 刷新 lockfile | `package.json:83` |
| C16 | 清理 `desktop/dist/` 中 1.1.1–1.1.5 旧安装包（保留 1.1.6 + sha256） | 约 591.8MB |

**批次 2：归档（7 项）**：`scripts/issues/`（25 文件）→ `scripts/legacy/`；9 个上游开发统计脚本 → `scripts/legacy/`；`apps/web/public` 14 个未引用品牌资源（约 1.6MB）→ `docs/archive/brand-assets/`；`.agents/` → 移出仓库并加 `.gitignore`；`backups/`（89.5MB，未被忽略）→ 压缩归档 + `.gitignore`；`README.interview.md` → 移出仓库；`docs/rebuild-frontend/*` 已随文档归档。

**批次 3：讨论后做（3 项）**：74 处仅文件内使用的 `export`（注意 `apps/shared` 是契约）；`packageIdentity`（`packages.ts:89` / `ResourcesPage.tsx:269`）与 `formatDuration`（两份舍入不同）合并到 `apps/shared`；`tool-authorization.ts:61` 超时不一致（单独修复单 + 测试，不混进清理提交）。

**明确不动**：`packages/**`、桌面打包链（`desktop/*.ps1`、`installer.nsi`、`package-shell.mjs`、`desktop.json`、`icon.ico`）、`apps/server/src/workspaces/office-preview.ps1`（运行时用 `fileURLToPath` 解析，静态扫描假阳性）、`apps/web/public/provider-logos/**`、根 `test.sh`/`pi-test.*`/`start-web.cmd`、`.pi-console/`（700.7MB 运行数据）与 `node_modules/`。

### 3.3 清理验收

1. `git status` 只包含预期路径（当前工作树 236 个脏文件，清理提交必须单独一个 commit 且只含本清单文件）。
2. `npx tsc --noEmit -p apps/server` 与 `-p apps/web` 通过；`apps/**` 无残留 import。
3. `node docs/audit/refs.mjs` 相对链接断链 = 0。
4. `grep -rn "PI_CONSOLE_TOKEN\|src-tauri" apps docs README.md` = 0。

### 3.4 执行记录（实际做了什么）

**文档（全部删除，不归档）**：`docs/architecture/` 下 28 个旧文件（`01-current-architecture.md`、`02-target-architecture.md`、`03-refactoring-plan.md`、`04-baseline.md`、`05`–`15` 阶段记录、`16-kernel-split-plan.md`、`current-code-architecture.md/.svg/.png`、`harness-layers.svg`、`kernel-split-{current,target,roadmap}.svg`、`legacy-issues.md`、`project-architecture.md/.svg`、`README.md`）与 `docs/rebuild-frontend/` 整目录已删除；`harness-assessment.md` 移到 `docs/audit/` 作为证据保留。`docs/architecture/` 现在只保留本次重写的 `00`/`01`/`02`/`03`/`04`/`README`/`stages/`。

**仓库卫生**：删除 `backups/`（89.5MB）、`.agents/`、`README.interview.md`；`desktop/dist/` 删除 1.1.1–1.1.5 的 exe+sha256（保留 1.1.6 与 electron-cache）；`.gitignore` 增加 `backups/`、`.agents/`。

**归档（不是删除，属于 fork 自己的资产整理）**：9 个上游开发统计脚本与 `scripts/issues/` → `scripts/legacy/`；14 个未被引用的品牌位图 + `desktop/icons/icon.png` → `品牌设计/web-unused-assets/`（`apps/web/public` 只保留 2 处实际引用：`app-icon.svg`、`brand/allweave-dotted-mark.svg`、`brand/allweave-parent-mark.svg`、`brand/build-app-icon.svg`）。

**代码（批次 1/2/3 全部落地）**：删 `apps/server/src/app.ts`、删 `pi-events.ts` 的 `adaptRpcEvent`（173→108 行）、47 个未使用 import 绑定（26 文件）、`packageIdentity`/`formatDuration` 合并到 `apps/shared`、`tool-authorization.ts:61` 超时统一、根 `motion` 依赖移除并刷新 lockfile。

**偏差与事故（必须记录）**：`docs/audit/code-audit.md` 的 C3 未使用 import 清单误判了仅用于类型注解的导入，批量删除后 `tsc` 报错；回填脚本因 `apps/**` 不在 git HEAD、无法 `git show` 取原模块，误插了错误路径与声明位置，最终逐个手工修正（正确模块映射见 §3.5）。教训：**未使用绑定清理必须用 compiler API 或 `tsc --noUnusedLocals` 证明，不能靠正则**。

**清理验收结果**：`tsc -p apps/server|apps/web|desktop --noEmit` 全部通过；`biome check` 在 `apps/`、`desktop/` 上无 fix；`grep PI_CONSOLE_TOKEN` = 0；`grep src-tauri` 仅文档历史说明为 0（旧文档已删）。**遗留**：`npm run test:unit --workspace=@pi-console/server` 有 3 个失败，全部与本次清理无关（纯 import/死代码改动）：`session-runtime.test.ts:118` 删除未归档会话报 409（实现要求先归档、测试未更新）、`workbench-smoke.test.ts:133` Playwright 等待文案超时、`session-projection.test.ts` legacy 元数据升级 `actual: 3, expected: 2`。三项记入 S0 基线，由 S0 修复或标注。

### 3.5 未使用绑定清理的正确模块映射（防止再次"清理"时改错）

`agent.ts` ← `./sessions/pi-runtime.adapter.ts` 的 `AgentRuntimeFactory`、`SessionFactory`；`sessions/event-projector.ts` ← `../../../shared/src/protocol.ts`（`applyEvent`、`RunUsage`、`SessionDetail`、`SessionEvent`、`SessionSummary`、`SessionUsageRecord`）+ `../persistence/session-projection.ts` 的 `SessionMeta`；`sessions/tool-factory.ts` ← `@earendil-works/pi-coding-agent`（`InlineExtension`、`ToolDefinition`）+ `../app-plugins.ts` 的 `AppPluginManager` + `../browser.ts` 的 `BrowserService`；`store.ts` ← `./persistence/session-projection.ts` 的 `SessionMeta`；`transport/http/app-plugins.routes.ts` ← `../../app-plugins.ts`；`transport/http/browser.routes.ts` ← `../../browser.ts`；`remote-workspaces.ts` ← `@earendil-works/pi-env` 的 `SshTarget`；`workspaces/workspace-access.ts` ← `../git.ts` 的 `GitOperations`；`workspaces/service.ts` ← `./workspace-access.ts` 的 `WorkspaceFiles`；`browser.ts` ← `playwright-core`（`Browser`、`BrowserContext`、`CDPSession`、`Dialog`、`Locator`、`Page`）；web 侧 `RefObject`/`ReactNode` ← `react`、`SpringPresetName` ← `../theme/motion.ts`、`ThemeTransitionOrigin` ← `../theme/theme-transition.ts`、`PluginFeatureId` ← `../components/PluginFeaturePanel.tsx`、`SessionDetail`/`SocketMessage` ← shared protocol；`desktop/src/main.ts` 的 `ChildProcess` ← `node:child_process`。

### 3.6 文档重写执行记录（2026-11-03）

- 目录结构：`docs/architecture/{README,00-plan,01-project-architecture,02-kernel-architecture,03-target-architecture,04-roadmap}.md` + 四张同名 SVG；`stages/{_template,S0-baseline,S1-kernel-facade,S2-telemetry,S3-persistence,S4-context-budget,S5-compaction,S6-tool-plane,S7-extension-host,S8-sandbox,S9-kernel-loop}.md`，每份阶段文档配一张同名 SVG；历史记录迁入 `stages/history/R1..R6`；审计报告与复跑脚本在 `docs/audit/`。
- 门禁：新增 `scripts/check-architecture-docs.mjs`（路径存在、行号不越界、声明行数误差 ≤5%、相对链接有效），并在根 `package.json` 的 `check` 链中加入 `check:arch-docs`。首次运行有 204 项误报（裸文件名、后缀歧义、旧文档引用），已通过"裸文件名不校验 + 唯一后缀匹配 + `PLANNED`/`HISTORICAL`/`DELETED` 白名单"修正，现检查 36 个被引用文件、0 失败。
- 校验：17 张 SVG 全部通过 `XmlDocument` 显式 UTF-8 加载（`root=svg`、无替换字符）；阶段文档均为 10 节、标题与 `_template.md` 一致。
- 执行中收敛的口径：S8 只承诺"超时 + Job Object + 工具参数路径越界拒绝"，命令内部重定向明确不承诺（列入 AppContainer 调研）；S7 是否改上游取决于是否需扩展 `ExtensionBindings` 类型，改动一律走 `docs/patches/`；S1 不动 `sessions/pi-events.ts:24` 的 message id 合成与 `packages/coding-agent/src/index.ts` 的 barrel 收窄，两项留给 S9。
- 已知遗留：`apps/server` 三个既有测试失败（`session-runtime.test.ts:118` 未先归档即删除、`workbench-smoke.test.ts:133` Playwright 超时、`session-projection.test.ts` legacy 元数据版本断言 2 vs 3），归属 S0 修复，不计入本次清理回归。

---

## 4. 新文档体系（重写，不修补）

```
docs/
├── architecture/
│   ├── README.md                    索引：阅读顺序、术语、图与文的对应表
│   ├── 00-plan.md                   本文（执行台账）
│   ├── 01-project-architecture.md   项目架构（事实）
│   ├── 01-project-architecture.svg
│   ├── 02-kernel-architecture.md    内核架构（事实 + 缺陷证据）
│   ├── 02-kernel-architecture.svg
│   ├── 03-target-architecture.md    目标架构（拆分后）
│   ├── 03-target-architecture.svg
│   ├── 04-roadmap.md                阶段总览 + 所有权交棒 + 指标基线
│   ├── 04-roadmap.svg
│   └── stages/
│       ├── _template.md             六要素模板
│       ├── S0-baseline.md … S9-kernel-loop.md
│       └── history/                 2026-10-31 至 11-01 的阶段 1–6 记录
├── workbench-ui.md                  Web 工作台（重写）
├── plugin-architecture.md           app plugin（重写）
└── audit/                           三份审计报告 + harness 评估迁入，作为证据留存
```

### 4.1 每篇文档的固定结构

- `01/02/03`：**图在前**，正文按"这张图画了什么 → 每层职责 → 数据流/时序 → 关键设计取舍 → 与代码的核对入口（文件:行号表） → 已知缺陷（指向阶段）"。
- `stages/S*.md`：**六要素**（修改前架构 / 修改后架构 / 改哪一块及其在整体架构中的作用 / 为什么改 / 怎么改 / 验收与度量），外加"回退开关""风险""复盘（执行后回填）"。
- 每张图必须有"读图要点"三条与"本图对应的代码路径"表。
- 行号、行数、模块清单必须可由脚本复核（见下）。

### 4.2 文档-图-代码一致性门禁（S0 实现）

`node scripts/check-architecture-docs.mjs`：
1. 图与文里出现的 `路径` 必须存在；
2. 文中 `path:行号` 的行号不得超过文件实际行数；
3. 文中声明的行数（如"agent-session.ts 4398 行"）与实测差 ≤5%；
4. 所有相对链接有效；
5. 失败即 `npm run check` 失败。

---

## 5. 阶段编排（S0–S9）

排序原则：先安全网，再收接缝，再低风险高收益，最后动循环；每个阶段都可单独发布、单独回退。

| 阶段 | 主题 | 动哪一块 | 图中层 | 主要产物 | 估算 |
|---|---|---|---|---|---|
| S0 | 基线固化 | 仓库根（测试/脚本/文档） | 横切 | 表征测试 5 条、指标脚本、文档骨架、门禁脚本 | 1–2 周 |
| S1 | 内核门面 | `apps/server/src/kernel/*` + 12 个导入文件 | L2 接缝 | 单点接缝、死代码清理、id 一致性修复 | 1 周 |
| S2 | 可观测与成本 | `sessions/*`、`store.ts`、usage 路由 | L9 | run/turn/tool span、成本、指标面板 | 2 周 |
| S3 | 持久化单一事实 | `event-projector`、`coordinator`、`store`、`persistence` | L6 | append-only 事件、run/审批落库、崩溃恢复 | 3 周 |
| S4 | 上下文预算 | `compaction/*`、`estimate.ts`、`truncate.ts` | L3 上下文 | CJK 估算、cache-safe 压缩、工具结果 token 化 | 2 周 |
| S5 | 压缩子系统抽取 | `agent-session.ts:2714-3256/767-844/366-372` | L3 会话 | `CompactionController`，会话 -550 行 | 3 周 |
| S6 | 工具面重构 | 工作台工具层 + 内核工具装载 | L5 治理 | `ToolRegistry`、`PolicyEngine`、审批持久化 | 3 周 |
| S7 | 扩展宿主与信任 | `agent-session.ts:3258-3700`、`extensions/*`、`kernel.ts` | L7 扩展 | `ExtensionHost`、显式信任、pi 扩展 shim | 4 周 |
| S8 | 执行隔离 | `tools/bash.ts`、`WorkspaceTools`、新 `sandbox/` | L5 执行 | 超时/预算、Job Object、工具参数路径越界拒绝（命令内部重定向不在 Node 层承诺） | 4 周 |
| S9 | 内核 loop 与编排 | `agent-session.ts:1822-1957`、`agent-loop.ts` | L3 核心 | `RunController`、`Orchestrator`、pi 降为 adapter | 5 周 |

合计 28 周（单人）／约 16 周（两人并行 S2/S3 与 S4/S5）。所有权交棒（自研代码占内核比例）：S0 0% → S5 后约 20%（上下文）→ S6 约 35%（工具面）→ S7 约 50%（扩展）→ S8 约 60%（执行）→ S9 约 85%（循环与编排）。

---

## 6. 各阶段六要素

> 每条只写"计划值"；执行时展开成 `stages/S*.md`（模板见 `stages/_template.md`）。

### S0 基线固化 — 安全网

- **修改前架构**：没有表征测试目录、没有 trace、没有指标采集；重构只能靠人读代码；文档与代码无门禁。图中为空白横切带。
- **修改后架构**：出现横切层——`apps/server/test/characterization/`（5 条主链路：建会话→prompt→工具审批→中断→重启恢复）、`scripts/metrics/collect.mjs`（8 项指标从 `console.sqlite` + JSONL 读取）、`scripts/check-architecture-docs.mjs`（§4.2）、`docs/architecture/` 骨架。
- **改哪一块**：仓库根与测试/脚本/文档，不动运行时代码。作用：为 S1–S9 提供"改前/改后"判据与文档门禁。
- **为什么**：`harness-assessment.md` 的结论是"先测量再优化"；没有基线，后面的每一步都无法证明是改进。
- **怎么改**：先跑 `./test.sh` + `npm run check` 记录基线；用 faux provider 写 5 条表征测试（禁用真实 API）；指标脚本输出 JSON 存档；文档骨架落盘。
- **验收**：基线报告进 `04-roadmap.md` 附录；8 项指标可一键复现；新测试稳定不 flaky。
- **回退**：纯新增，无回退面。

### S1 内核门面 — 把内核变成工作台里的一个子系统

- **修改前架构**：12 个文件直接 import 5 个包（33 处），其中 `pi-agent-core`/`chord` 未在 `apps/server/package.json` 声明，adapter 还深路径 import `pi-ai/utils/model-operations`；接缝没有"面"。
- **修改后架构**：`apps/server/src/kernel/{index,sdk,models,tools,events,env}.ts` 成为唯一 import 点；`scripts/check-kernel-boundaries.mjs` 禁止越界；`package.json` 依赖声明补齐。
- **改哪一块**：`apps/server/src` 的 12 个文件（`sessions/pi-runtime.adapter.ts`、`sessions/tool-factory.ts`、`workspaces/workspace-access.ts` 等）。作用：L2 接缝从"网状直连"变成"单点门面"，后续任何内核替换只改门面。
- **为什么**：kernel-map §1 证明不先收口，每动内核一处要改 12 个文件；这是所有后续阶段的乘数。
- **怎么改**：纯搬运 + re-export；顺带 C1/C2 死代码；修 `pi-events.ts:24` 用 `entry.id`（与 transcript 对齐，补回归测试）。
- **验收**：`grep -rn "@earendil-works" apps/server/src | grep -v kernel/` = 0；`tsc`/`biome` 通过；5 条表征测试 100% 通过。
- **回退**：单 commit revert。

### S2 可观测与成本 — 让每一步都可度量

- **修改前架构**：只有 run 级 token 汇总（`sessions/run-usage.ts` + coordinator `finishRunUsage`），无 span、无成本、无错误分类，`packages/telemetry` 未接入。
- **修改后架构**：L9 观测层出现——`sessions/trace.ts` 产 run/turn/tool/model span；`store.ts` 加 `runs`/`spans` 表；`/api/usage` 返回成本与延迟分位；`packages/telemetry` 作为可选 sink（默认 NOOP）。
- **改哪一块**：`sessions/{run-usage,coordinator,pi-runtime.adapter}.ts`、`store.ts`、`transport/http` usage 路由、`apps/web` 用量面板。作用：横切度量层，为 S3–S9 提供成本/延迟/错误率判据。
- **为什么**：8 项指标目前缺 7 项（只有 turns per task 近似可得）。
- **怎么改**：在 AgentRuntime 事件订阅处包 span（不进内核）；成本用 `pi-ai` 的 `calculateCost`；写入与投影同事务；前端只加只读面板。
- **验收**：run trace 覆盖率 100%；成本与 provider 账单误差 <5%；面板可查单会话与全局。
- **回退**：`PI_CONSOLE_TRACE=off`。

### S3 持久化单一事实 + 崩溃恢复

- **修改前架构**：in-flight run、审批、浏览器/SSH 句柄只在内存；projector 对每个非 delta 事件写全量快照；JSONL 与 SQLite 双权威无共同事务。
- **修改后架构**：`session_events` 成为 append-only 单一写者（仅每 50 条或 turn 边界写 checkpoint）；`running_runs`/`approvals` 落库；启动时 replay → 补 `interrupted` tool_result（`RESTART_OUTPUT`）→ 发 `session.recovered`；SQLite 明确降级为"可重建投影"，JSONL 仍是对话真相。
- **改哪一块**：`sessions/{event-projector,coordinator,tool-authorization}.ts`、`store.ts`（新表）、`persistence/*`、必要时 `shared/protocol.ts` 加字段。作用：L6 持久化层，把"能重启"变成"能恢复"。
- **为什么**：P0-2、P0-4；用户"可用"要求的第一条就是恢复率 100%。
- **怎么改**：先加表并双写（观察一周）→ 再切读路径 → 最后删旧全量快照路径；测试注入 kill 点。
- **验收**：kill -9 后重启恢复率 100%；`apps/server/scripts/benchmark-stream-writes.mjs` 写放大下降 ≥80%；回放与快照一致。
- **回退**：`PI_CONSOLE_PROJECTION=legacy`。

### S4 上下文预算 — 成本与长任务成功率的核心

- **修改前架构**：六处 `Math.ceil(chars/4)`（`packages/coding-agent/src/core/compaction/compaction.ts:295-339`）+ `CHARS_PER_TOKEN=3.5`（`packages/ai/src/utils/estimate.ts:15`），中文低估 2–8×；压缩请求 `cacheRetention:"none"`；工具结果按 2000 行/50KB 字节截断（`truncate.ts:11-12`）。
- **修改后架构**：CJK 感知估算（ASCII/全角分权重或 tokenizer 近似，误差 <15%）；压缩保留父前缀 `cacheRetention`；工具结果按 token 预算截断 + spill 到文件、模型按需 `read`。
- **改哪一块**：`packages/coding-agent/src/core/{compaction/*,estimate.ts,tools/truncate.ts}`。作用：L3 上下文预算，直接决定成本与长任务是否成功。
- **为什么**：P0-5、P1-6、P1-7；中文项目实测压缩过早/过晚。
- **怎么改**：双权重函数 + 中英混合语料单测；压缩请求加 cacheRetention；truncate 改 token 计数并落盘。
- **验收**：估算误差 <15%；cache hit rate 上升；compaction/task 下降；长任务 pass@1 不降。
- **回退**：`estimate=legacy`。

### S5 压缩子系统抽取 — 内核第一次减重

- **修改前架构**：压缩散在 `AgentSession` 三入口（`776` / `2764` / `2947`+`3097`）+ 阈值投影（`767-844`）+ 估算（`366-372`），状态在 4398 行类里。
- **修改后架构**：`CompactionController`（输入 entries/settings/estimator/events/store；输出 `CompactionResult` + 4 个事件 + 1 次 `appendCompaction`）；`AgentSession` 只调用；先落在 `core/compaction/compaction-controller.ts`，等价验证后迁 `packages/kernel-context`。
- **改哪一块**：`agent-session.ts:2714-3256`、`767-844`、`366-372`。作用：L3 会话模块第一次"减重"，同时验证"提取→抽象→替换"的方法论。
- **为什么**：kernel-map §9.2 五条理由（契约已是纯函数、三入口一实现、输出面窄、正确性最热、与工作台零耦合）。
- **怎么改**：先冻结事件序列做 golden trace → 加端口接口 → 搬实现 → 三入口逐一替换 → 双轨对比。
- **验收**：三入口事件序列逐字节一致；`agent-session.ts` 减少 ≥500 行；无行为回归。
- **回退**：保留旧私有方法一版（`compaction=legacy`）。

### S6 工具面重构 — 安全执行入口

- **修改前架构**：工具可见性、系统提示、执行三者耦合（`471-479`、`1483-1575`、`1700`、`3495`）；策略是 17 行三元函数（`apps/server/src/tool-policy.ts`）；审批在内存 Map、5 分钟超时。
- **修改后架构**：`ToolRegistry`（注册/可见性/提示片段）+ `PolicyEngine`（规则表：工具×模式×路径 → allow/ask/deny + 沙箱级别）+ 审批持久化（复用 S3 表）。
- **改哪一块**：`apps/server/src/{tool-policy,tool-authorization,sessions/tool-factory}.ts` 与内核工具装载。作用：工作台唯一的安全执行入口，也是 S7/S8 的前置。
- **为什么**：P1-7 + P0-3 的前置；"新增工具 ≤1 文件 1 处注册"这条可扩展性指标落在这一层。
- **怎么改**：先抽工作台侧（低风险），再动内核装载；策略表配置化；每次授权决策入事件日志。
- **验收**：改策略零代码；工具清单一键 diff；审批重放测试通过。
- **回退**：`policy=legacy`。

### S7 扩展宿主与信任 — 第三方代码执行边界

- **修改前架构**：扩展 API ≈ `AgentSession` API（`3360-3493`，30 个回调）；jiti 以宿主权限执行；项目 `.pi` 自动 trust。
- **修改后架构**：`ExtensionHost`（显式信任：workspace trust 清单 + 用户批准 + 能力按需授予）+ pi 扩展 compat shim（版本化）。
- **改哪一块**：`agent-session.ts:3258-3700/1284-1362/658-724`、`core/extensions/*`、`apps/server/src/kernel.ts`。作用：L7 扩展层，把"任意代码执行"变成"被授权的代码执行"。
- **为什么**：P0-3；`pi-subagents` 这类编排能力目前完全依赖第三方扩展在宿主权限下运行。
- **怎么改**：先加信任门（默认关）与审计日志 → 再抽 host 接口 → 最后做 shim。
- **验收**：未信任扩展不执行；黄金扩展集兼容率 >95%。
- **回退**：`trust=all`（恢复旧行为）。

### S8 执行隔离 — 把"授权 ≠ 隔离"补上

- **修改前架构**：bash 无默认超时（`core/tools/bash.ts:42`），子进程以宿主权限运行，工作区校验只在 API 层。
- **修改后架构**：默认超时 + 输出预算 + 进程树 kill；Windows 先落 Job Object，AppContainer/容器只做调研；所有 spawn 前做工作区路径校验。
- **改哪一块**：`tools/bash.ts`、工作台 `WorkspaceTools`、新增 `apps/server/src/sandbox/`（或 `packages/kernel-sandbox`）。作用：L5 执行面。
- **为什么**：P0-3；"可扩展"意味着以后会跑不受信代码。
- **怎么改**：先超时/预算（低风险）→ 再 Job Object（Windows）→ 最后评估更强隔离。
- **验收**：超时 kill 100%；经工具参数给出的越界路径被拒；命令内部重定向（如 echo > ../x）明确不承诺，列入 AppContainer 调研项。
- **回退**：`sandbox=off`。

### S9 内核 loop 与编排 — 交棒完成

- **修改前架构**：两层循环（`agent-core` 的 runLoop + `AgentSession._runAgentPrompt` 1822-1951）；两套队列（`Agent.MessageQueue` 与 `_steeringMessages`，`_queueSteer` 两边都写）；编排靠 npm `pi-subagents`。
- **修改后架构**：单一 `RunController` 拥有循环与队列；`Orchestrator` 提供 spawn/send/wait（由事件日志支撑，可恢复）；pi loop 降为 adapter，`engine=pi|own` 可切。
- **改哪一块**：`agent-session.ts:1822-1957`、`packages/agent/src/agent-loop.ts`、新 `packages/kernel-loop` + `kernel-orchestrator`。作用：L3 核心，所有权交棒终点。
- **为什么**：P0-1；用户"可扩展"要求的根能力（子代理、并行任务）。
- **怎么改**：golden traces 双轨跑 ≥30 天；按任务类型逐个切换；pi 保留 fallback。
- **验收**：trace 一致率 >95%；pass@1 不降；子代理任务成功率有基线。
- **回退**：`engine=pi`。

---

## 7. 图与阶段的对应

| 图 | 画什么 | 被哪些阶段修改 |
|---|---|---|
| `01-project-architecture.svg` | 部署三形态（dev / web 生产 / 桌面）、进程与端口、`apps/*` 模块清单、数据存储、信任边界、外部依赖 | S1（接缝层）、S2（观测）、S3（存储）、S6/S7（策略） |
| `02-kernel-architecture.svg` | pi 内核内部：18 个职责块、五个子系统、5 包 26 符号接缝、5 条耦合证据、3 个硬约束 | S4/S5（上下文）、S6（工具）、S7（扩展）、S8（执行）、S9（循环） |
| `03-target-architecture.svg` | 自研 `kernel-*` 八模块 + `adapters-*` + 会话协议 v2 | 目标态，S9 后替换 01/02 |
| `04-roadmap.svg` | S0–S9 时间轴 + 所有权交棒条 + 每阶段度量门槛 | 每阶段完成后回填实际值 |

---

## 8. 执行顺序与完成定义（DoD）

```
C 清理（文档 4 删 / 17 归档；代码批次 1）
  → 01/02 文档 + 两张图（事实基线冻结）
  → 03 目标架构 + 04 路线图 + stages/_template
  → S0（文档骨架 + 5 条表征测试 + 指标脚本 + 门禁脚本）
  → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9
```

每个阶段的 DoD（缺一不算完成）：

1. `stages/S*.md` 的六要素写全，且"修改后架构"与图中的位置一致；
2. 该阶段的表征/回归测试通过，`npm run check` 无错误；
3. 指标前后对比写进 `04-roadmap.md`；
4. 回退开关存在且被演练过一次；
5. 文档-代码一致性脚本通过（§4.2）；
6. 一个独立 commit（或 PR），描述里引用阶段文档。

---

## 9. 风险与"不做"

| 风险 | 应对 |
|---|---|
| 阶段太多导致长期分支 | 每阶段单独发布；S0–S2 与前序重构可并行 |
| Windows 沙箱形态不确定 | S8 只承诺"超时 + Job Object"，AppContainer 作为调研项，不写进验收 |
| pi 扩展兼容性 | S7 的 shim 用黄金扩展集度量（含 `pi-subagents`） |
| 双轨维护成本（S9） | 双轨只保留 30 天，之后强制单轨 + fallback 只读 |
| 动上游文件（S4/S5/S9 改 `packages/coding-agent`） | 先在本仓库内以新模块实现（`core/compaction/compaction-controller.ts`、`packages/kernel-*`），上游文件只做"调用点替换"，便于 diff 与回退 |
| 过度重构 | 明确不做：微服务、第二套 Agent 框架、默认多代理、为 CRUD 造 Repository、把 tags 当认证 |

---

## 10. 待确认（评审时请逐条回答）

1. **清理范围**：`backups/`（89.5MB）、`desktop/dist/` 旧安装包（591.8MB）、`.agents/`、`README.interview.md` 是否现在就移出仓库？`docs/architecture/` 旧文档是"归档到 `archive/`"还是直接删除？
2. **阶段粒度**：S0–S9 十段是否接受？若想更快见效，可把 S2+S3 合并为"可恢复的度量"（4 周），把 S8 并入 S6。
3. **上游改动策略**：S4/S5/S9 必须改 `packages/coding-agent` 内的文件，是否可以接受"在 fork 内改上游文件 + 保留 patch 记录"？还是坚持"只新增包、上游文件一行不改"（后者会让 S5/S9 成本翻倍）。
