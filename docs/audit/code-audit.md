# 工作台代码审计：无效代码、冗余与历史残留

- 仓库：`D:\project\pi-main`（pi coding-agent fork：Fastify 本地服务 + React Web 工作台 + Electron 桌面）
- 审计范围：`apps/server/src/**`、`apps/web/src/**`、`apps/shared/src/**`、`desktop/**`、`scripts/**`、根目录遗留文件、`docs/` 资源与文档引用
- 明确排除：`packages/**`（上游 pi 包与内核，fork 的产品资产；本报告只记录“工作台未使用”的事实，不提议删除）
- 审计性质：**只读**。本报告不删除、不修改任何文件，所有结论均可用文中命令复现。
- 运行环境：Windows，node v26.7.0。审计脚本现保留在 `docs/audit/`（`reachability.mjs`、`refs.mjs`、`web-unused.mjs`、`assets.mjs`、`docs-orphans.mjs` 及对应 JSON 输出）；下文历史命令中的 `.audit/` 路径按 `docs/audit/` 理解。
- 归档说明：本报告记录 2026-11-03 审计时的代码与文档状态，部分被审计路径随后已删除或迁移，结论只作证据保留。

## 1. 摘要

1. 从 23 个生产入口（server `main.ts`、web `main.tsx`、desktop `main.ts`/`preload.ts`、`package.json` 引用的脚本）做可达性分析，覆盖 191 个文件：**产品代码里唯一的整文件死代码是 `apps/server/src/app.ts`（6 行兼容 shim，仓库内 0 个 importer）**；唯一的死函数是 `apps/server/src/sessions/pi-events.ts:46` 的 `adaptRpcEvent`（62 行，被 `adaptSdkEvent` 完全取代，0 引用）。
2. 未发现未注册路由、未挂载页面、重复审批逻辑：6 个 HTTP 路由模块全部注册；`apps/web/src` 的 48 个 `.ts/.tsx` 源文件全部从 `main.tsx` 可达；审批只有 `ToolAuthorization` 一套实现。
3. 真正影响维护的是**文档与实现脱节**：`docs/` 仍按 Tauri/Rust 桌面描述（34 处，其中 2 个相对链接指向已不存在的 `desktop/src-tauri/`）；根 `README.md:96` 与 `apps/server/.env.example` 宣称的访问令牌（`PI_CONSOLE_TOKEN`）在代码中不存在（唯一实现是同源校验 + 桌面关闭 token）。
4. 冗余集中在“小而散”：`packageIdentity` 在前后端各有一份逐字节相同的实现，`formatDuration` 有两份舍入语义不同的实现；另有 48 处仅类型 import、74 处仅文件内使用的 `export`；根 `package.json` 的 `motion` 依赖全仓 0 引用。
5. 建议清理 19 组：**9 组可立即执行（低风险、不影响运行）**，10 组需确认后归档/删除；另有约 2.4MB 未引用资源与约 680MB 本地备份/旧安装包可作为仓库卫生项处理（不含 `.pi-console` 运行数据）。

### 口径

- 死代码：从生产入口不可达，且无运行时路径（动态 URL、字符串路径等人工复核）；测试可达单独标注。
- 冗余：同一职责多份实现、仅类型 import、仅文件内使用的 `export`。
- 残留：兼容层、过期文档/图片/脚本、根目录孤儿文件、本机工具产物。
- 未用配置：`package.json`/`.env.example` 中声明但代码从不读取的项。
- 风险等级：高 = 会误导部署/安全判断或破坏流程；中 = 维护成本、误删风险或仓库污染；低 = 纯清理，无行为影响。
- 可达性脚本用正则剥离注释后解析 `import`/`export from`/动态 `import()`/`require()`/CSS `@import`，并人工复核了动态路径（`office-preview.ps1`、脚本 glob、CI 引用等）。已知盲区：无扩展名文件（`.husky/pre-commit`、`.nsi`）不被文本扫描覆盖，因此“0 命中”不等于绝对无引用。

## 2. 总表

| # | 路径 | 类型 | 证据（要点） | 风险 | 建议 |
| --- | --- | --- | --- | --- | --- |
| C1 | `apps/server/src/app.ts` | 残留（兼容 shim） | 6 行 re-export；全仓 import 0 命中；仅历史文档提及 | 低 | 删除，并同步清理 docs 中对旧入口的描述 |
| C2 | `apps/server/src/sessions/pi-events.ts` `adaptRpcEvent` | 死代码 | 62 行；全仓仅定义处 1 命中；`adaptSdkEvent` 承接全部调用 | 低 | 删除函数，保留 `adaptSdkEvent`/`adaptRuntimeEvent` |
| C3 | 27 个文件中的 48 个未使用 import 绑定 | 冗余 | `.audit/web-unused.mjs` 扫描；tsc 未开 `noUnusedLocals` | 低 | 机械删除（类型为主，不改变行为） |
| C4 | 74 处仅文件内使用的 `export` | 冗余 | 导出扫描：外部引用 0（`adaptRpcEvent` 除外） | 低 | 可选：去掉多余 `export`，缩小模块表面 |
| C5 | `packages.ts:89` 与 `ResourcesPage.tsx:269` 的 `packageIdentity` | 冗余（重复实现） | 逐字节相同的 7 行函数，`grep` 2 处定义 | 低 | 抽到 `apps/shared`，两端复用 |
| C6 | `ExecutionProgress.tsx:11` 与 `WorkbenchSettingsPanels.tsx:451` 的 `formatDuration` | 冗余（近似重复） | 同名函数，一个 `floor` 一个 `round`，秒数显示不一致 | 低 | 统一为一个 shared 实现（明确舍入规则） |
| C7 | `docs/architecture/current-code-architecture.png`（232.6KB）、`harness-layers.svg`（19.5KB） | 残留（孤儿图） | 全仓 0 引用；同目录 Markdown 未链入 | 低 | 删除或移入 `docs/archive/` |
| C8 | `desktop/icons/icon.png`（10.5KB） | 残留（未用图标） | `icon.ico` 被 `package-shell.mjs:28`、`installer.nsi:41-42` 使用；`icon.png` 0 引用 | 低 | 确认是否为 ico 源图；否则删除 |
| C9 | `scripts/issues/`（25 文件，50.9KB） | 残留（整套未用工具） | 工作流 `issue-analysis.yml` 走 pi `/is` prompt；该目录仅自述 README/run.sh 互引，外部 0 引用 | 中 | 归档（确认无人依赖它的 triage UI 后删除） |
| C10 | 9 个开发统计脚本：`cost.ts`、`stats.ts`、`tool-stats.ts`、`read-tool-stats.mjs`、`edit-tool-stats.mjs`、`session-context-stats.mjs`、`session-transcripts.ts`、`repro-5893-wsl-bash.mjs`、`update-source-imports-to-ts.sh`（111.3KB） | 残留（上游开发辅助） | 全仓 0 引用、0 文档入口；`grep -rn` 命中为 0 或仅文件名自身的测试 fixture | 中 | 归档到 `scripts/legacy/`（上游开发脚本，产品不使用） |
| C11 | `apps/web/public` 下 14 个未引用品牌资源（约 1.6MB） | 残留（未用资源） | `assets.mjs` 0 引用：`app-icon.png`、`brand-logo.png`、`brand/allweave-logo-*.svg`×3、`allweave-mark-*.svg`×3、`allweave-parent-lockup.png`、`build-logo-*.svg`×3、`build-mark-*.svg`×3 | 低 | 归档；品牌源文件已保存在 `品牌设计/` |
| C12 | 根 `README.interview.md`（4.4KB） | 残留（根目录孤儿） | 全仓 0 引用；内容与 `README.md` 重叠，为面试展示版 | 中 | 移出仓库或归档（个人材料，误删风险中） |
| C13 | `docs/rebuild-frontend/implementation-notes.md` | 残留（过期文档） | 0 引用；正文描述 Tauri `decorations(false)`、`capabilities/main-window.json`，这些文件已不存在 | 中 | 归档为历史记录或删除 |
| C14 | `.agents/skills/` + `.agents/skills-lock.json`（0.3MB） | 残留（本机工具产物） | 0 引用；lock 源路径指向 `C:/Users/ke/AppData/Local/Temp/emilkowalski-skills-inspect/...` | 中 | 移出仓库，并加入 `.gitignore` |
| C15 | `backups/`（89.5MB，4 个快照） | 残留（本地备份） | `.gitignore` 无 `backups/` 条目；`v0`、`pre-cleanup-20261026`、`pre-pi-source-removal`、`frontend-redesign-20261102-074950` | 中 | 移出仓库或归档压缩，并加忽略规则 |
| C16 | `desktop/dist/` 中 1.1.1–1.1.5 旧安装包（约 591.8MB） | 残留（旧构建产物） | 只分发当前 1.1.6；`dist/` 已被 `.gitignore` 忽略 | 低 | 清理旧版本，保留 1.1.6 + sha256 |
| C17 | 根 `README.md:96` 的“校验访问令牌” + `apps/server/.env.example` 的 `PI_CONSOLE_TOKEN` | 未用配置 + 文档失配 | `grep -rn PI_CONSOLE_TOKEN apps desktop scripts` = **0**；代码只有同源校验与桌面关闭 token（`create-app.ts:89-100`、`security.ts` 的 `tokenMatches`） | 中 | 删除该变量并修正 README（或真正实现认证）；`apps/README.md:61` 的描述是对的，可作为基准 |
| C18 | 根 `package.json` 依赖 `motion` 14.6.0 | 未用配置 | `grep -rn 'from "motion\|framer-motion' apps packages scripts desktop` = 0；仅 `package.json:83` 一处声明 | 低 | 移除依赖（单独提交并更新 lockfile） |
| C19 | `docs/` 中 Tauri/Rust 桌面残留 34 处 + 2 个死链 | 文档失配 | `grep -rn 'src-tauri\|Tauri\|tauri' docs` = 34；`refs.mjs` 校验 539 条相对链接，2 条断链均指向 `../../desktop/src-tauri/src/main.rs` | 中 | 更新“当前实现”文档与 SVG；历史阶段文档加“已过时（Tauri → Electron）”标注；修 2 个链接 |
| C20 | `apps/server/src/sessions/tool-authorization.ts:61` | 缺陷（非清理项，仅记录） | `expiresAt` 用常量 `approvalTimeoutMs` 计算，而定时器用 `this.timeoutMs`（:64），超时配置可能不一致 | 中 | 单独修复并加测试；不在本次清理范围 |

## 3. 逐项详情

### C1 `apps/server/src/app.ts`（兼容 shim）

```ts
/**
 * Compatibility entry point. The composition root moved to
 * `bootstrap/create-app.ts`; this module keeps the previous import path alive
 * for external callers. Repository callers use the composition root directly.
 */
export { type AppOptions, configuredRoots, createApp } from "./bootstrap/create-app.ts";
```

```
grep -rn 'from ".*/app\.ts"' apps desktop scripts --include='*.ts' --include='*.tsx' --include='*.mjs'
# 结果：0 命中
```

- 唯一真实入口是 `apps/server/src/main.ts` → `./bootstrap/create-app.ts`。
- `docs/architecture/04-baseline.md`、`10-stage-6-transport.md` 等历史文档提到“app.ts 495 行 → 5 行兼容 re-export”（实际文件 6 行：5 行注释 + 1 行 re-export），说明它的使命已经结束；当前没人在 import。
- 注意：`docs/` 中还有大量历史文档按旧 `app.ts` 描述架构（属于历史记录，不算错误），但 `current-code-architecture.md`、`project-architecture.md` 这类“当前实现”文档里若继续引用 `app.ts` 行号就是失配，需随本项一起更新。

**建议**：删除文件 `apps/server/src/app.ts`；删除前跑一次 `npx tsc -p apps/server/tsconfig.json --noEmit`（只读检查）确认无外部引用。

### C2 `adaptRpcEvent`（死函数 / 重复实现）

```
grep -rn 'adaptRpcEvent' apps --include='*.ts'
# 结果：1 命中 —— apps/server/src/sessions/pi-events.ts:46（仅定义）
```

- `apps/server/src/sessions/pi-events.ts` 172 行里有两套事件映射：
  - `adaptRpcEvent:46-108`（约 62 行）：把 `JsonAgentSessionEvent` 映射为 `AdaptedEvent`，**全仓无调用方**；
  - `adaptSdkEvent:110-163`：被 `adaptRuntimeEvent:166` 使用；`apps/server/test/adapter.test.ts` 直接测它。
- 这是同一职责的两份实现，`adaptRpcEvent` 是从旧 RPC 事件模型迁移后的遗留，保留只会让后来者误以为两条链路都活着。
- 附带：`RuntimePhase` 类型也仅文件内使用。

**建议**：删除 `adaptRpcEvent` 与仅服务于它的私有分支/类型；保留 `adaptSdkEvent` + `adaptRuntimeEvent`。删除后跑 `apps/server` 的单测（`node --import ./packages/coding-agent/src/experimental/source-resolver.ts --test test/*.test.ts`）验证。

### C3 48 个未使用 import 绑定（冗余）

```
node .audit/web-unused.mjs
# 结果：48 个绑定 / 27 个文件，绝大多数是 type-only
```

典型样本（均为类型 import，删掉不改变运行行为）：

| 文件 | 未使用绑定 |
| --- | --- |
| `apps/server/src/browser.ts` | 6 个 `playwright-core` 类型 |
| `apps/server/src/event-projector.ts` | 5 个协议类型 + `SessionMeta` |
| `apps/server/src/sessions/pi-runtime.adapter.ts` | `AgentSession`、`createAgentSession`、`RuntimeEvent` |
| `apps/server/src/transport/http/*.routes.ts` | 各模块的 `*RoutesOptions` |
| `apps/web/src/features/chat/useSession.ts` | `SessionDetail`、`SocketMessage` |
| `apps/web/src/pages/ResourcesPage.tsx` | `PluginFeatureId` |
| `desktop/src/main.ts` | `ChildProcess` |

这些 import 目前由 `verbatimModuleSyntax` 保留为类型引用，没有运行时代价，但会制造“谁在用”的噪音，也让按文件追踪依赖的审查变慢。

**建议**：一次性机械清理；用仓库已有的 `npm run check:web`（只读 tsc + biome）验收。注意：该命令不在本次审计允许执行范围内（会写文件），由执行清理的会话运行。

### C4 74 处仅文件内使用的 `export`

```
node .audit/reachability.mjs   # unusedExports 列表
# 结果：74 项，其中只有 adaptRpcEvent 是“死值导出”
```

- 绝大多数是类型/选项接口（`AgentServiceOptions`、`SessionCoordinatorOptions`、`*RoutesOptions`、`WorkspaceServiceOptions` 等），属于“导出但无外部消费者”。
- 只有 `adaptRpcEvent` 是真死代码（见 C2）；`springPresets`（`theme/motion.ts:9` → 同文件 :51 使用）、`remoteMcpLaunchCommand`（`remote-mcp.ts:175` + 测试）等是文件内使用，删 `export` 即可。

**建议**：低优先级；只对确认仅内部使用的符号去掉 `export`，不做大范围重命名。类型导出常被 `tsc` 的声明输出或未来扩展使用，删除前以“无外部引用 + 非公共 API”为准。

### C5 `packageIdentity` 两份实现（冗余）

```
grep -rn 'function packageIdentity' apps --include='*.ts' --include='*.tsx'
# 结果：2 命中
#   apps/server/src/packages.ts:89
#   apps/web/src/pages/ResourcesPage.tsx:269
```

两份函数逐字节相同：仅处理 `npm:` 前缀，去掉 `@scope/name@version` 的版本段。

**建议**：移动到 `apps/shared/src/plugins.ts`（该文件已承载插件协议类型），前后端各自 import。这是个纯函数，放 shared 不引入依赖方向问题。

### C6 `formatDuration` 两份实现（冗余，且有行为差异）

| 位置 | 实现 |
| --- | --- |
| `apps/web/src/features/chat/ExecutionProgress.tsx:11` | `Math.floor(milliseconds / 1000)` |
| `apps/web/src/pages/WorkbenchSettingsPanels.tsx:451` | `Math.round(durationMs / 1000)` |

同一产品里两处“运行耗时”会有一秒内的显示差异（例如 1.5s 显示 1s vs 2s）。不是 bug 级别，但属于同一职责两份实现。

**建议**：合并为一个 shared 工具（建议统一用 `Math.round`，与用户对“耗时”的直觉一致），并在测试里固定边界（59.5s、60s）。

### C7 `docs/` 孤儿图

```
node .audit/assets.mjs
# 0 引用：docs/architecture/current-code-architecture.png (232.6KB)
#         docs/architecture/harness-layers.svg (19.5KB)
```

- `docs/architecture/README.md` 索引只链接了 `current-code-architecture.md/.svg`，没有链 `.png` 和 `harness-layers.svg`。
- 其余架构 SVG（`project-architecture.svg`、`kernel-split-*.svg`）均被索引或正文引用。

**建议**：删除两张图，或移到 `docs/archive/` 并在索引中说明。

### C8 `desktop/icons/icon.png`

```
grep -rn 'icon\.png' desktop apps scripts --include='*.mjs' --include='*.ps1' --include='*.nsi' --include='*.ts'
# 0 命中
```

- `desktop/package-shell.mjs:28`（Electron packager `icon`）与 `desktop/installer.nsi:41-42`（NSIS 图标）都使用 `desktop/icons/icon.ico`。
- `icon.png` 很可能是 ico 的源图，但构建链不读它。

**建议**：确认无人工用途后删除；若想保留源图，移到 `品牌设计/` 而不是 `desktop/icons/`（避免误以为打包需要它）。

### C9 `scripts/issues/` 整套工具（残留）

```
ls scripts/issues          # 25 个文件，50.9KB：main.ts、triage.ts、github.ts、register.mjs、ui.html、run.sh、categories/*.md
grep -rn 'scripts/issues' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=backups --exclude-dir=.audit
# 除脚本自身 README/run.sh 互引外 0 命中
```

- `.github/workflows/issue-analysis.yml` 实际运行的是 pi 的 `/is` prompt，不调用这套工具。
- 该工具需要 `scripts/issues/data/token` 与本地 7788 端口，是一个独立的小服务（README 自述），与工作台产品无关。

**建议**：归档（例如 `scripts/legacy/issues/` 或移出仓库）。如果团队仍在人工用它做 issue triage，则保留并在 `scripts/README` 写明入口——目前没有任何文档入口。

### C10 9 个未引用的开发统计脚本（残留）

```
grep -rn 'cost\.ts\|stats\.ts\|tool-stats\|read-tool-stats\|edit-tool-stats\|session-context-stats\|session-transcripts\|repro-5893\|update-source-imports' \
  . --include='*.json' --include='*.md' --include='*.yml' --include='*.mjs' --include='*.ts' --include='*.sh' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=backups --exclude-dir=.audit
# 0 命中（cost.ts 的唯一命中是 packages 测试里的同名 fixture，与本文件无关）
```

- 这些脚本是上游 pi 仓库的开发辅助（会话统计、成本统计、工具统计、WSL repro、源码 import 重写），工作台产品与 CI 都不使用。
- 它们不参与 `npm run test:scripts`（glob 只收 `scripts/*.test.*`），也不在 `package.json` 的 scripts 中。

**建议**：归档到 `scripts/legacy/`（保留历史可追溯），不直接删除；`scripts/auto-pi.sh` 例外——它是自述的开发用 symlink 包装器（header 有安装说明），保留。

### C11 `apps/web/public` 未引用品牌资源

`node .audit/assets.mjs` 结果（0 引用）：

| 路径 | 大小 |
| --- | --- |
| `apps/web/public/app-icon.png` | 694KB |
| `apps/web/public/brand-logo.png` | 303KB |
| `apps/web/public/brand/allweave-logo-{black,blue,white}.svg` | 131.8KB × 3 |
| `apps/web/public/brand/allweave-mark-{black,blue,white}.svg` | 3.9KB × 3 |
| `apps/web/public/brand/allweave-parent-lockup.png` | 167KB |
| `apps/web/public/brand/build-logo-{black,blue,white}.svg` | 5.5KB × 3 |
| `apps/web/public/brand/build-mark-{black,blue,white}.svg` | ~2KB × 3 |

仍被使用的品牌资源（不要动）：`app-icon.svg`（`index.html` + docs）、`brand/build-app-icon.svg`（favicon）、`brand/allweave-dotted-mark.svg`（`BuildBrandFamily.tsx`）、`brand/allweave-parent-mark.svg`（docs）、`brand/build-mark-*`/`build-logo-*` 中的部分（按 `assets.mjs` 输出逐项确认）。

**建议**：归档，不要直接删——这些是品牌物料，可能在宣传页/商店素材中复用；`品牌设计/` 已有设计源文件（29 个，2.9MB），可作为唯一来源。

### C12 根 `README.interview.md`（孤儿）

- `refs.mjs` 根文件入链统计：0 引用。
- 内容是“面试展示版”README：项目简介、技术栈、核心功能、个人贡献、展示图（引用 `docs/brand/workbench.png`），与 `README.md` 信息重叠。
- 若它不是有意保留的个人材料，放在仓库根会持续制造“哪份 README 是真的”的困惑。

**建议**：移出仓库，或移到 `docs/` 下并加说明；不要直接删（可能是作者个人材料）。

### C13 `docs/rebuild-frontend/implementation-notes.md`（过期文档）

- 0 引用；`docs/architecture/README.md` 也未索引它。
- 正文仍在描述 Tauri：
  - 第 5 行：`Tauri 主窗口改为 decorations(false) 与 shadow(false)`；
  - 第 6 行：`data-tauri-drag-region="deep"`；
  - 第 7 行：`capabilities/main-window.json` 授予窗口控制权限。

  桌面端已改为 Electron（`desktop/src/main.ts` + `preload.cjs`），仓库里没有 `desktop/src-tauri`。这份笔记作为历史过程记录有价值，但作为“当前说明”会误导。

**建议**：移到 `docs/architecture/` 的历史区并加“已过时”头注，或删除。

### C14 `.agents/` 本机工具产物

- `.agents/skills/` 是 AI skill 副本；`.agents/skills-lock.json` 中的 source 指向 `C:/Users/ke/AppData/Local/Temp/emilkowalski-skills-inspect/...`（本机临时路径）。
- 它们与工作台产品、构建、测试都无关，`.gitignore` 也没有忽略 `.agents/`。
- 风险不在体积，而在“误提交后泄漏本机路径 / 其他开发者环境不存在”。

**建议**：移出仓库并加入 `.gitignore`（`.agents/`）；若团队要共享 skills，应改为稳定 URL 并提交文档化的安装方式。

### C15 `backups/` 本地备份（89.5MB）

```
v0/  pre-cleanup-20261026/  pre-pi-source-removal/  frontend-redesign-20261102-074950/
```

- `.gitignore` 只有 `dist/`、`plans/`、`.pi/hf-sessions-backup/` 等，**没有 `backups/`**。
- 如果这些目录从未被跟踪，风险只是磁盘占用；一旦有人在根目录 `git add .`，会把 89.5MB 历史快照带进仓库。

**建议**：压缩后移出仓库（或至少加 `backups/` 到 `.gitignore`），保留最近一次快照即可。

### C16 `desktop/dist/` 旧安装包

```
AllWeaveBuild-1.1.1 … 1.1.6 (windows-x64).exe + .sha256
841.5MB 总计，其中 1.1.1–1.1.5 约 591.8MB
```

- `dist/` 已被 `.gitignore` 忽略，属于本地产物。
- `desktop/AGENTS.md` 要求每次交付递增版本、`desktop.json` 持有版本号（当前 1.1.6），旧版本没有保留必要。

**建议**：只保留当前版本与它的 `.sha256`（发布归档在别处），清理旧 exe 释放约 590MB。

### C17 `PI_CONSOLE_TOKEN` 与 README 访问令牌描述（未用配置 + 文档失配）

```
grep -rn 'PI_CONSOLE_TOKEN' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=backups --exclude-dir=.audit
# 结果：只有 2 处文档描述
#   apps/server/.env.example  （变量本身）
#   docs/architecture/project-architecture.md:831（明确写着“未被使用”）
```

- 代码里的安全边界只有两层：
  1. 同源检查：`bootstrap/create-app.ts:89-100`（Host/Origin、`/api`、`/ws` 必须同源本机）；
  2. 桌面关闭 token：`PI_CONSOLE_SHUTDOWN_TOKEN` + `x-pi-console-shutdown-token` header，仅 `POST /api/desktop/shutdown`。
- 根 `README.md:96` 写“并校验访问令牌、Host 和 Origin”，其中“访问令牌”没有实现；`apps/README.md:61` 的描述（“当前没有通用访问令牌或 Cookie 登录层”）才是准确的。
- `.env.example` 保留 `PI_CONSOLE_TOKEN` 会让部署者以为设置它就启用了认证。
- 该变量的注释更具体，也更具误导性：`# Optional stable console access token (32+ characters). Otherwise generated on startup.` —— 代码既没有读取这个环境变量，也没有“启动时生成 token”的逻辑。

**建议**：删除 `.env.example` 中的 `PI_CONSOLE_TOKEN`，把 `README.md:96` 改为“同源校验 + 桌面关闭 token（无通用访问令牌）”，并链接 `apps/README.md` 与 `docs/architecture/project-architecture.md:831`。如果确实需要认证层，应单独立项，而不是留着这个“看起来已实现”的变量。

### C18 `motion` 依赖（未用配置）

```
grep -rn 'from "motion"\|from "motion/react"\|from "framer-motion"' apps packages scripts desktop \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs'
# 0 命中
grep -rn '"motion"' package.json
# package.json:83: "motion": "14.6.0"
```

- 工作台自己的动画实现是 `apps/web/src/theme/motion.ts` + `Spring*` 组件（CSS transition/spring 曲线），没有使用 `motion` 库。
- 该依赖在根 `dependencies`，会让每次安装多拉一个包（lockfile 中还有它的传递依赖）。

**建议**：移除 `motion`，用 `npm install --package-lock-only --ignore-scripts` 刷新 lockfile（按 AGENTS.md 的依赖流程单独提交）。注意 `@emotion/react`、`@emotion/styled` 虽然 0 直接 import，但它们是 MUI 的 peer dependency，**不要删**。

### C19 `docs/` 的 Tauri 残留与死链（文档失配）

```
grep -rn 'src-tauri\|Tauri\|tauri' docs --include='*.md' --include='*.svg' | wc -l
# 34
```

命中分布（按“是否属于当前实现文档”分类）：

| 文件 | 性质 | 处理 |
| --- | --- | --- |
| `docs/architecture/current-code-architecture.md:12,150` | 当前实现文档，仍写“Rust/Tauri”与 `../../desktop/src-tauri/src/main.rs` 链接，且该链接是死链 | 更新为 Electron（`desktop/src/main.ts`、`preload.cjs`、`build-installer.ps1`），修链接 |
| `docs/architecture/project-architecture.md:48,61,136,714,857` | 主文档仍按 Tauri 描述桌面外壳；:857 链接同样是死链 | 更新桌面章节与链接 |
| `docs/plugin-architecture.md:32` | 表格里把 `desktop/src-tauri/src/main.rs` 当作“把数据目录传给本地服务”的实现 | 改为 Electron 入口 |
| `docs/architecture/project-architecture.svg:16`、`harness-layers.svg:16`、`current-code-architecture.svg:43` | 图里写“Tauri/Rust 外壳 + WebView2” | 重绘为 Electron 文案 |
| `docs/rebuild-frontend/implementation-notes.md:5-7` | 过期过程笔记 | 见 C13 |
| `docs/architecture/01-current-architecture.md`（7 处）、`02-target-architecture.md`（8 处）、`03-refactoring-plan.md`（3 处）、`04-baseline.md:35`、`06-stage-2-transaction.md:57` | 历史阶段文档（记录当时状态） | 保留内容，加“已过时（2026-11 桌面从 Tauri 切换到 Electron）”头注，避免被当作现状引用 |

`refs.mjs` 的相对链接校验结果：539 条链接中恰好 2 条断链，均为 `../../desktop/src-tauri/src/main.rs`（`current-code-architecture.md`、`project-architecture.md`）。其余 537 条均可达。

**建议**：分两步：先修“当前实现”文档 + 2 条死链（低风险、纯文档）；历史文档只加过时标注，不重写（它们是过程证据）。同一批更新把 C1 涉及的 `app.ts` 描述一并修正。

## 4. “不要动”清单

| 路径 | 原因 |
| --- | --- |
| `packages/**` | 上游 pi 包与内核，fork 的产品资产。审计只记录“工作台未使用”（如 `packages/durable`、`packages/evals` 未接入主链路），不提议删除。 |
| `desktop/build-installer.ps1`、`set-version.ps1`、`stage-runtime.ps1`、`compile-installer.ps1`、`installer.nsi`、`package-shell.mjs`、`desktop.json`、`icons/icon.ico`、`test-version.ps1`、`test-installer.ps1`、`test-runtime.mjs` | 桌面 EXE 交付链的必需文件，全部仍有调用关系（`build-installer.ps1:27,35,36` → set-version/stage-runtime/compile-installer；`stage-runtime.ps1:32` → package-shell.mjs；`compile-installer.ps1:19` → installer.nsi；`desktop.json` 由 3 个脚本读取）。`test-runtime.mjs` 虽只在 `compile-installer.ps1:10` 的提示文字中出现，但它是人工验证工具，删除会丢失排障入口。`desktop.json` 的版本号按 `desktop/AGENTS.md` 每次交付必须递增，不要在清理中改动。 |
| `apps/server/src/workspaces/office-preview.ps1` | 可达性脚本的假阳性：`apps/server/src/workspaces/office-preview.ts:31` 用 `fileURLToPath(new URL("./office-preview.ps1", import.meta.url))` 在运行时解析该路径。 |
| `apps/web/index.html`、`apps/web/vite.config.ts` | 构建入口（Vite 读取），不是源码 import 图的节点；可达性脚本把它们列入“不可达”属假阳性。 |
| `apps/web/public/provider-logos/**`（含 `LICENSE`、`README.md`） | 由 `apps/web/src/components/ProviderLogo.tsx` 的 provider-id→文件名映射在运行时按需加载，静态 grep 只能看到部分名字。 |
| `apps/web/public/app-icon.svg`、`brand/build-app-icon.svg`、`brand/allweave-dotted-mark.svg`、`brand/allweave-parent-mark.svg`、`docs/brand/build-banner.svg`、`docs/brand/workbench.png` | 分别被 `index.html`、`BuildBrandFamily.tsx`、README、docs 引用（`assets.mjs` 已验证）。 |
| `scripts/dev-web.mjs`、`check-browser-smoke.mjs`、`check-pinned-deps.mjs`、`check-runtime-deps.mjs`、`check-package-install.mjs`、`check-ts-relative-imports.mjs`、`check-entry-graphs.mjs`、`generate-coding-agent-install-lock.mjs`、`hydrate-env-daemons.mjs`、`diff-model-catalog.mjs`、`update-model-catalog-pin.mjs`、`publish-model-catalog.mjs`、`profile-coding-agent-node.mjs`、`sync-versions.js`、`publish.mjs`、`local-release.mjs`、`release.mjs`、`release-notes.mjs`、`pack-packages.mjs`、`model-catalog-protocol.ts` | 被根 `package.json` 的 scripts 直接引用；已逐个验证目标存在。 |
| `scripts/agent-treeshake-smoke-entry.ts`、`browser-smoke-entry.ts`、`durable-browser-smoke-entry.ts` | 被 `scripts/check-browser-smoke.mjs` 作为 esbuild 入口引用。 |
| `scripts/build-binaries.sh`、`create-source-archive.sh`、`build-coding-agent-bundle.mjs`、`smoke-test-codemode-binary.mjs`、`npm-audit.mjs`、`publish-release-announcement.mjs`、`check-lockfile-commit.mjs`、`use-local-packages.mjs`、`auto-pi.sh`、`scripts/*.test.*` | 分别被 GitHub Actions（`build-binaries.yml`、`npm-audit.yml`）、`.husky/pre-commit`、`packages/*/package.json`、`npm run test:scripts` glob、README.pi.md 引用。`check-lockfile-commit.mjs` 的文本扫描为 0 命中，是因为 `.husky/pre-commit` 是无扩展名文件（扫描盲区），实际有调用。 |
| `scripts/biome/model-type-comparison.grit` | 被 `biome.json` 的 `plugins` 配置引用。 |
| `apps/server/scripts/benchmark-session-startup.mjs`、`benchmark-stream-writes.mjs` | 虽不在 `package.json` scripts 中，但 `docs/architecture/11-stage-7-measurement.md:18,21`、`13-cross-stage-followup.md:35` 给出可复现命令，是测量工具，保留。 |
| `scripts/hydrate-pinned-model-data.mjs`、`generate-thinking-capabilities.mjs` | 分别被 `apps/README.md`/`docs/architecture/{13,15}` 与 `scripts/diff-model-catalog.mjs` 引用。 |
| `.pi/prompts/*.md`、`.pi/skills/*.md` | 以 pi 斜杠命令/技能名调用（如 `/cl`、`/deslop`），不是文件链引用；`AGENTS.md` 也指向 `.pi/skills/interactive-testing.md`、`.pi/skills/release.md`。 |
| `scripts/issues/` 的 `README.md`、`run.sh` | 若决定保留 C9，这两个是入口文档；若归档则一起移动，不要只删代码留文档。 |
| 根 `test.sh`、`pi-test.ps1`、`pi-test.sh`、`pi-test.bat`、`start-web.cmd` | 开发入口：`test.sh` 被 README/CI 说明引用；`pi-test.*` 分别指向存在的 `packages/coding-agent/src/cli.ts` 与 `.../experimental/cli.ts`；`start-web.cmd` 被 `README.md:69` 引用。`pi-test.bat` 0 文本引用但只是 ps1 的 cmd 包装器，保留成本为零。 |
| 根 `.env.example` 中 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` | `apps/**` 不直接读取，但 `apps/server` 的 dev 脚本用 `--env-file-if-exists=../../.env` 加载，环境变量最终由上游 `pi-ai` 读取；UI 也支持配置凭据。保留并维持“可选”注释。 |
| `apps/web` 的 `@emotion/react`、`@emotion/styled` | 0 直接 import，但为 MUI 的 peer dependency，删除会导致构建失败。 |
| 根 devDependency `pnpm` | 被 `scripts/local-package-install.test.mjs:195` 通过 `node_modules/pnpm/bin/pnpm.mjs` 调用。 |
| `desktop/dist/` 中的当前版本 1.1.6 安装包 | 对应当前 `desktop.json` 版本，可作为交付/回滚基线；只清理 1.1.1–1.1.5。 |

## 5. 建议的清理顺序

### 阶段一：可立即执行（纯清理，不改行为，无需业务确认）

1. **C1** 删除 `apps/server/src/app.ts`；同步把“当前实现”文档里对 `app.ts` 的引用改为 `bootstrap/create-app.ts`。
2. **C2** 删除 `pi-events.ts` 中的 `adaptRpcEvent`（及其专用私有分支），保留 `adaptSdkEvent`/`adaptRuntimeEvent`。
3. **C3** 清理 48 个未使用 import 绑定（27 个文件），以 biome/tsc 为验收。
4. **C7** 删除 `docs/architecture/current-code-architecture.png`、`harness-layers.svg`（或移入 `docs/archive/`）。
5. **C17** 删除 `.env.example` 的 `PI_CONSOLE_TOKEN`，修正 `README.md:96` 的安全表述。
6. **C19（第一半）** 修 2 条死链、更新 `current-code-architecture.md`/`project-architecture.md`/`plugin-architecture.md` 与 3 个 SVG 的桌面描述为 Electron。
7. **C8** 确认 `desktop/icons/icon.png` 无人工用途后删除（或移到 `品牌设计/`）。
8. **C18** 移除 `motion` 依赖并刷新 lockfile（单独提交，便于回滚）。
9. **C16** 清理 `desktop/dist/` 中 1.1.1–1.1.5（保留 1.1.6 + sha256）。

验收：`npm run check`（执行清理的会话在允许范围内运行；会写 biome 格式，属预期）；桌面打包链不需要重新验证（本阶段未动 `desktop/*.ps1`/`desktop.json`）。

### 阶段二：归档（低风险，但涉及“可能还要用”的资产，建议先移动到 `archive/` 而非直接删）

1. **C11** `apps/web/public` 未引用品牌资源（14 个文件）→ 归档；`品牌设计/` 作为设计源保留。
2. **C10** 9 个上游开发统计脚本 → `scripts/legacy/`。
3. **C9** `scripts/issues/` → `scripts/legacy/issues/`。
4. **C13** `docs/rebuild-frontend/implementation-notes.md` → `docs/architecture/archive/` 并加过时头注。
5. **C12** `README.interview.md` → 移出仓库或 `docs/archive/`。
6. **C14** `.agents/` 移出仓库并加 `.gitignore`。
7. **C15** `backups/` 压缩归档并加 `.gitignore`。

### 阶段三：需要讨论后再做

1. **C4** 74 处多余 `export`：只在团队接受“缩小模块表面”时批量处理；注意 `apps/shared` 的协议类型可能是对外契约。
2. **C5/C6** 重复 helper 合并：需要决定 shared 包的归属与命名（`apps/shared/src/plugins.ts` 现有边界）。
3. **C20** `tool-authorization.ts:61` 的 `expiresAt` 与 `this.timeoutMs` 不一致：单独开修复单，补“自定义超时”测试，不要混进清理提交。
4. `packages/**` 的“产品未使用”事实（`durable`、`evals` 等）只记录，不采取动作。

## 6. 附注：审计过程中确认的非清理类事实

- 未发现 TODO/FIXME/XXX/HACK 标记（`apps/**`、`desktop/**` 均无；`scripts/**` 只有 `mktemp` 的 `.XXXXXX` 模板与 `model-catalog` 协议中合法的 `legacy` 枚举值）。
- 未发现被注释掉的 import 或整块注释代码。
- 6 个 HTTP 路由模块（`app-plugins`、`browser`、`providers`、`resources`、`sessions`、`workspaces`）全部在 `create-app.ts:138-143` 注册；Web 侧对每个端点都有调用点；`/api/desktop/shutdown` 由桌面主进程调用。
- `apps/web/src` 无不可达文件；`App.tsx` 的 import 全部被使用；`features/chat/index.ts` 是唯一 barrel（`export { ChatPage }`），属于有意的 feature 边界。
- `desktop/*.ps1`、`installer.nsi`、`stage-runtime.ps1` 没有过期脚本：每个文件都能在 `build-installer.ps1` 链上找到调用点或被 `desktop/AGENTS.md` 指定为验证步骤。
- 运行时数据目录（`.pi-console/` 700.7MB）与 `node_modules/`（487.4MB）不建议纳入清理：前者是本地会话数据，后者是依赖安装产物；两者都已被 `.gitignore` 忽略。

---

审计脚本（只读，可复跑）：

| 脚本 | 作用 |
| --- | --- |
| `.audit/reachability.mjs` | 入口可达性 + 未使用导出；输出 `.audit/reachability.json` |
| `.audit/refs.mjs` | 仓库文本引用计数 + `docs/**/*.md` 相对链接校验；输出 `refs{1..4}.json` |
| `.audit/web-unused.mjs` | 未使用 import 绑定扫描 |
| `.audit/assets.mjs` | `apps/web/public`、`docs/`、`desktop/icons`、`品牌设计` 资源引用扫描 |
| `.audit/docs-orphans.mjs` | Markdown 文档入链扫描（216 个文件） |
