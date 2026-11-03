# 内核架构测绘（kernel-map）

- 仓库：`D:\project\pi-main`，分支 `codex/v1`（工作区是脏的，本次测绘只读，未改任何现有文件）。
- 方法：按 `apps/server` 的 import 反查接缝 → 逐文件读内核实现（`read` 全文或大段）→ `grep` 交叉验证调用点。
- 行号约定：全部来自本次实际读到/定位到的内容；凡只由 grep 命中、未逐行读过的，标 **待核**。
- 三份被反复引用的文件：
  - `packages/coding-agent/src/core/agent-session.ts`（4398 行）
  - `packages/coding-agent/src/core/session-manager.ts`（2013 行）
  - `apps/server/src/sessions/pi-runtime.adapter.ts`（413 行）

---

## 0. 一页纸结论

### 0.1 八个问题的一句话答案

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 内核边界 | **不是"一个接缝"，是 5 个包 × 12 个文件**：`pi-coding-agent`（26 个符号）、`pi-ai`（3 文件）、`pi-agent-core`（1 文件）、`chord`（2 文件）、`pi-env`（1 文件）；后两者**没写进 `apps/server/package.json`** | §1.1 表；`apps/server/package.json:11-21` |
| 2 | AgentSession 职责 | **18 个职责块**，其中最畸形的三块是"事件持久化""压缩触发""扩展绑定"——它们是别的模块的职责，被塞进了会话类 | §2.1 表 |
| 3 | 扩展点 | 4 条注册通道（`bindExtensions` / `extensionFactories` / `additionalExtensionPaths` / `registerTool`）+ 39 个 `pi.on` 钩子；工作台用 `pi.on("tool_call")` 把"路径授权 + 审批"反注入内核 | §3.1、§3.2 |
| 4 | 工具执行链 | 11 跳：`agent-loop.runToolCall` → `beforeToolCall`(扩展) → `tool.execute` → `ToolDefinition.execute` → `ops.*` → `WorkspaceTools.check` → `workspacePath`(containment) → `fs.*` | §4.1 |
| 5 | 会话与持久化 | **双权威**：内核写 JSONL（append-only 树，entry id），工作台写 SQLite（meta + 事件 + 快照，message id 用 `randomUUID`）；重载时用 JSONL 重建对话、用 meta 补 UI 字段 | §5.3 六条证据 |
| 6 | 上下文与压缩 | 3 个入口都收敛到 `compaction/compaction.ts`；token 估算**只有一种实现**：6 处 `Math.ceil(chars/4)`，没有 `CHARS_PER_TOKEN` 常量 | `compaction.ts:311,317,330,335,339,344` |
| 7 | 模型网关 | `ModelRuntime.create` 用 `builtinProviderCatalog` 装配 provider，再叠 config/扩展 overlay；`setDefaultStreamFn(streamSimple)` 在 **`core/sdk.ts:46`** | `model-runtime.ts:216-261`、`sdk.ts:46` |
| 8 | 分层 | 5 层：宿主 / 工作台 / SDK 接缝 / 内核（loop·会话·上下文·工具·模型·扩展·持久化）/ 外部依赖。**只有 `agent-core` 的 loop 和 `ai` 的 provider 调用接近 commodity，其余全是自研且在互相纠缠** | §8 |

### 0.2 内核实际形状（不是分层，是"一个类 + 一堆配套"）

```
┌─ 宿主层 ───────────────────────────────────────────────────────────┐
│ 浏览器(apps/web: React，0 个内核 import)  ·  Windows 文件系统/子进程  │
└──────────────┬──────────────────────────────────────────────────────┘
               │ HTTP /api/*  +  WS /api/sessions/:id/stream
┌─ 工作台层 apps/server（in-process，无 RPC 边界）─────────────────────┐
│ create-app.ts(组合根) → sessions/coordinator.ts(会话编排)            │
│   ├ pi-runtime.adapter.ts  ← 自己 new 内核零件再塞回 createAgentSession
│   ├ tool-factory.ts        ← 用扩展钩子把工作台授权规则反注入内核
│   ├ event-projector.ts + persistence/transcript.ts ← 第二套持久化
│   └ workspaces/* / providers.ts / packages.ts / browser.ts
└──────────────┬──────────────────────────────────────────────────────┘
               │ SDK 接缝：5 包 / 12 文件 / 26+ 符号（编译期直接 import 源码）
┌─ 内核层 packages/* ─────────────────────────────────────────────────┐
│ agent-core: agentLoop(949 行) — 唯一"干净"的 while 循环              │
│ coding-agent:                                                       │
│   AgentSession 4398 行 ← 会话/事件/持久化/压缩/工具/模型/扩展 全在这  │
│   sdk.ts(工厂) · session-manager(JSONL) · compaction · model-runtime │
│   extensions/(runner 1426 · loader 780 · types 1998) · tools/        │
│   resource-loader(1287) · settings-manager(1224) · modes/(TUI/RPC)   │
└──────────────┬──────────────────────────────────────────────────────┘
    外部依赖: 模型 API · 文件系统 · 子进程 · MCP servers · SSH daemon(pi-env)
```

### 0.3 SDK 接缝符号清单（`apps/server/src`，12 个文件）

| 文件 | 行 | 包 | 符号 |
|---|---|---|---|
| `bootstrap/create-app.ts` | 4 | coding-agent | `createAgentSession`, `VERSION` |
| `sessions/pi-runtime.adapter.ts` | 3 | pi-ai | `isModelType`（深路径 `pi-ai/utils/model-operations`） |
| 同上 | 4-16 | coding-agent | `type AgentSession`, `type createAgentSession`, `createCodemodeExtension`, `createMcpExtension`, `createToolSearchExtension`, `DefaultResourceLoader`, `defaultModelPerProvider`, `getAgentDir`, `ModelRuntime`, `SessionManager`, `SettingsManager` |
| `sessions/tool-factory.ts` | 2-10 | coding-agent | `createBashToolDefinition`, `createEditToolDefinition`, `createReadToolDefinition`, `createWriteToolDefinition`, `type InlineExtension`, `type ToolDefinition`, `withFileMutationQueue` |
| `sessions/pi-events.ts` | 2 | pi-agent-core | `type AgentMessage` |
| 同上 | 3 | coding-agent | `type AgentSessionEvent`, `type JsonAgentSessionEvent` |
| `persistence/transcript.ts` | 1 | coding-agent | `SessionManager` |
| `providers.ts` | 4 | pi-ai | `type AuthEvent`, `type AuthPrompt`, `type AuthType`, `isModelType` |
| 同上 | 5 | coding-agent | `ModelRuntime` |
| `packages.ts` | 4 | coding-agent | `DefaultPackageManager`, `type ProgressEvent`, `SettingsManager` |
| `browser.ts` | 2 | pi-ai | `Type`（typebox 再导出） |
| 同上 | 3 | coding-agent | `defineTool` |
| `git.ts` | 5 | coding-agent | `withFileMutationQueue` |
| `remote-workspaces.ts` | 15 | coding-agent | `withFileMutationQueue` |
| 同上 | 24 | pi-env | 远程执行环境（具体符号 **待核**，只读到 import 尾行） |
| `workspaces/workspace-access.ts` | 4 | chord | `BACKGROUND_CONTEXT` |
| 同上 | 5 | coding-agent | `detectSupportedImageMimeTypeFromFile`, `withFileMutationQueue` |
| `workspaces/command-operations.ts` | 1 | chord | `BACKGROUND_CONTEXT`, `withAbortSignal` |
| 同上 | 2 | coding-agent | `type BashOperations` |

测试另有 10 个文件直接 `createAgentSession`（`test/api.test.ts:8`、`app-plugins:7`、`browser-agent:8`、`chat-controls:7`、`remote-project-features:9`、`remote-workspaces:9`、`session-runtime:8`、`session-storage:7`、`workbench-smoke:11`、`usage-observation:7`）+ `CURRENT_SESSION_VERSION`（`test/session-coordinator:7`、`session-projection:6`）+ `createLocalBashOperations`（`test/workspace-command:7`）。**测试把"能拿到什么"也钉死了**：任何收窄 barrel 的改动都会同时打破这 10 个测试的 import。

### 0.4 AgentSession 职责总览（18 块，详细表见 §2.1）

| 区间 | 职责 |
|---|---|
| 1-364 | 类型面（事件联合 196-237、配置 252-299、绑定 301-308）+ 本地 `estimateMessagesTokens` 366 |
| 378-526 | 字段 + 构造函数：订阅 agent、装 4 个投影钩子、建工具注册表（485-526） |
| 528-651 | 模型鉴权与选择记录（532/572/615/628/640） |
| 652-764 | 工具拦截（before/after hook）+ 嵌套工具调用（730） |
| 767-932 | 请求投影、turn_end 边界、下次 turn 刷新、阈值判定 |
| 934-1281 | 事件订阅 + **持久化**（`_handleAgentEvent` 1103）+ 就地改写消息 |
| 1284-1414 | 扩展事件桥 + `subscribe`/`dispose` |
| 1416-1813 | 只读状态、工具装载（1483-1575）、系统提示重建（1700/1738） |
| 1818-2451 | **Prompting**（外层二次循环 1822、`prompt` 1968、队列 2211-2365、abort） |
| 2453-2600 | 模型管理（setModel 2477、cycleModel 2519） |
| 2602-2712 | thinking level + 队列模式 |
| 2714-3256 | **压缩**（2719/2764/2947/3097） |
| 3258-3700 | **扩展绑定**（bindExtensions 3258、`_bindExtensionCore` 3360、reload 3660） |
| 3701-3827 | 自动重试（3762） |
| 3828-3934 | bash 执行（3841） |
| 3935-4160 | 会话命名 + **树导航**（navigateTree 3964） |
| 4161-4336 | 统计/导出（4183/4237/4288/4314） |
| 4338-4398 | 工具方法与扩展上下文（4347/4375/4388） |

### 0.5 第一个拆解接缝：**压缩子系统（2764-3256 + 767-844 + 366-372）**

理由见 §9.2。一句话：它是唯一**已经有纯函数契约、且被三个入口重复调用**的子系统（`prepareCompaction` / `compact` / `shouldCompact`），抽取是"搬调用点"而不是"重新设计接口"，风险最低而能立刻让 `agent-session.ts` 掉约 550 行。

---

## 1. 内核边界：工作台与内核之间到底有几个接缝

### 1.1 事实

`apps/server/src` 一共 12 个文件 import `@earendil-works/pi-coding-agent`，**26 个不同符号、33 处引用**。但"唯一编译期接缝"的说法不成立：

| 包 | 引入文件数 | 是否在 `apps/server/package.json` 声明 |
|---|---|---|
| `@earendil-works/pi-coding-agent` | 12 | 是（`package.json:13`，`^1.1.0`） |
| `@earendil-works/pi-ai` | 3（`browser.ts:2`、`providers.ts:4`、`pi-runtime.adapter.ts:3`） | 是（`package.json:12`） |
| `@earendil-works/pi-env` | 1（`remote-workspaces.ts:24`） | 是（`package.json:14`，精确 `1.1.0`） |
| `@earendil-works/pi-agent-core` | 1（`pi-events.ts:2`） | **否** |
| `@earendil-works/chord` | 2（`workspace-access.ts:4`、`command-operations.ts:1`） | **否** |

两个未声明的包靠 monorepo 提升解析（**待核**：干净安装下的行为；`npm ci` 时若 hoist 策略变化会直接编译失败）。

### 1.2 接缝的四种"漏"

1. **深路径穿透**：`pi-runtime.adapter.ts:3` 直接 `import { isModelType } from "@earendil-works/pi-ai/utils/model-operations"`——不是包的公开入口，是内部实现路径。
2. **类型擦除后强转**：`tool-factory.ts:59-78` 三个 `create*ToolDefinition` 的结果全部 `as unknown as ToolDefinition`，注释自述"SDK customTools 擦除 schema 类型"。类型系统在这条接缝上是失效的。
3. **运行时类直接 new**：工作台自己实例化 `ModelRuntime`（`pi-runtime.adapter.ts:274-283`、`providers.ts:5`）、`SettingsManager`（`pi-runtime.adapter.ts:286-294`、:311）、`DefaultResourceLoader`（:336-353）、`SessionManager`（:355-357）——即"内核零件"被工作台组装，而不是内核提供装配好的服务。
4. **barrel 全量暴露**：`packages/coding-agent/src/index.ts`（495 行）把 core + CLI + modes(TUI/RPC) + tabs/themes 一起导出。接缝没有任何"面"可言——工作台能拿到 `VERSION`，也能拿到 `runPrintMode`/`InteractiveMode`/主题。

### 1.3 为什么这会阻碍重构

- 想动 `AgentSession` 的构造参数（`AgentSessionConfig`，`agent-session.ts:252-299`，15 个字段），要同时改 `sdk.ts:461-478` 和工作台的 `pi-runtime.adapter.ts:358-385`。
- 想换掉 `SessionManager`（JSONL），`transcript.ts:1-88` 与 `event-projector.ts:168-175` 会一起失效——因为工作台**直接读** JSONL 当真相源。
- 想删掉 modes（TUI/RPC），`index.ts` 的导出面会连带破坏 26 个符号里的若干 type（`AgentSessionEvent`/`JsonAgentSessionEvent` 经 `modes/rpc` 暴露，`pi-events.ts:3` 消费）。

---

## 2. AgentSession 职责分区（4398 行）

### 2.1 分区表

"本应属于"是测绘结论（按"该职责的输入/输出与谁有关"判断），不是既有代码里的注释。

| 行号区间 | 职责 | 关键方法/字段 | 本应属于 |
|---|---|---|---|
| 1-186 | import + 局部工具函数 + `ParsedSkillBlock` | 166 | —（文件头） |
| 188-240 | **会话事件联合类型**（扩展了 `AgentEvent`） | `AgentSessionEvent` 196-237（含 `agent_settled`/`queue_update`/`compaction_start/end`/`auto_retry_*`/`summarization_retry_*`/`bash_execution_update`） | 事件契约应独立成 `session-events.ts` |
| 246-364 | 配置与结果类型 + `estimateMessagesTokens` | `AgentSessionConfig` 252、`ExtensionBindings` 301、`PromptOptions` 314、`SessionStats` 342、366 | 配置拆分到各子系统；`estimateMessagesTokens` → compaction |
| 378-483 | 20+ 私有字段，按注释分成 6 组 | 385 事件订阅 / 402 压缩 / 407 分支摘要 / 410 重试 / 419 bash / 423 扩展 / 471-479 工具注册表与提示词片段 | 每组都是"另一个模块的状态" |
| 485-526 | **构造函数：装配内核** | 513 `agent.subscribe`；514 `_installAgentToolHooks`；515 `_installAgentNextTurnRefresh`；516 `_installAgentRequestProjection`；517 `_installAgentBoundaryHooks`；518 `_installHiddenDeclarationsProjection`；519 `_installAgentForcedPromptProjection`；521 `_buildRuntime`；525 `_restoreToolsFromTranscript` | 组合根（`sdk.ts` 的职责） |
| 528-651 | 模型鉴权 + 选择记录 | 532 `_getRequiredRequestAuth`、572 `_getSummarizationRequestAuth`、615 `_modelForMessage`、628 `_recordSelection`、640 `_limitsModel` | ModelController |
| 652-764 | **工具拦截 + 嵌套工具** | 652 `_installAgentToolHooks` 把 `beforeToolCall`/`afterToolCall` 指到自己（653/654）；658 `_beforeToolCall` → `runner.emitToolCall`；684 `_afterToolCall` → `emitToolResult` + 图片归一化；730 `_executeNestedToolCall` | ToolRegistry / ExtensionHost |
| 767-844 | **请求投影 + 压缩阈值 + 虚拟模型** | 767 `_exceedsCompactionThreshold`；776 `_compactBeforeNextAssistantResponse`；787 `_installAgentRequestProjection`：包 `agent.prepareRequest`，793 `buildSessionProjection()`，822 `_modelRuntime.resolveModel`，829-835 写 `VIRTUAL_MODEL_STATE_ENTRY`，838 再判阈值 | ContextManager + ModelController |
| 846-932 | 边界生命周期（turn_end / before settle / 下一轮刷新） | 846 `_dispatchTurnEndBoundary`、886 `_installAgentBoundaryHooks`（包 `agent.finishTurn`）、898 `_installAgentNextTurnRefresh`（包 `agent.prepareNextTurnWithContext`） | 独立 `boundary.ts`（代码里已有 `BoundaryContextPreview` 类型） |
| 934-1100 | 事件发射 + 边界草稿 | 938 `_refreshFinalizedContext`、946 `_applyBoundaryDrafts`（四类 draft 写 SessionManager）、987 `_createBoundaryPreviewManager`（`SessionManager.inMemory`）、1039 `_emit`、1078 `_emitAgentSettled` | SessionStore + EventBus |
| 1103-1281 | **agent 事件 → 持久化**（最脏的一块） | 1103 `_handleAgentEvent`：1140 先发扩展事件再 `_emit`；1144-1185 `message_end` 分派到 `appendCustomMessageEntry`/`appendMessage` 并维护 `_entryIdsByMessage`；1214 `_findPersistedMessageEntryId` 用 `getBranch()` 反查；1237 `_omitRecoveryAttempt` 写 `context_edit`；1267 `_replaceMessageInPlace` 就地改写 | SessionStore（持久化不该从事件回调里长出） |
| 1284-1362 | agent 事件 → **扩展钩子** 映射 | 1284 `_emitExtensionEvent`（9 类事件逐个 translate） | ExtensionHost |
| 1369-1414 | `subscribe` / `dispose` | 1393 `dispose`：abort×5 → `_extensionRunner.invalidate` → 断订阅 → `cleanupSessionResources` | 生命周期归组合根 |
| 1416-1813 | 只读状态 + **工具装载** + **系统提示重建** | 1483-1575 active/callable/all tools、`_applyToolLoadout` 1575；1667 `setScopedModels`；1700 `_rebuildSystemPrompt`；1738 `_preparePromptAndToolLoadout`；1767 `_installHiddenDeclarationsProjection`；1787 `_installAgentForcedPromptProjection`；1809 `_restoreToolsFromTranscript` | ToolRegistry + PromptComposer |
| 1818-2451 | **Prompting（外层二次循环）** | 1822 `_runAgentPrompt`：`agent.prompt()` → while(`_handlePostAgentRun`) → `agent.continue()` → `_runBeforeSettleBoundary`；1853 `_handlePostAgentRun`（retry + `_checkCompaction` + 队列）；1968 `prompt()`（命令/skill/模板/图像/鉴权/压缩/钩子的总闸）；2116 扩展命令；2293-2365 自定义消息/用户消息；2434 `abort` | RunController（`agent-core` 已有 loop，这里又套了一层） |
| 2453-2600 | **模型切换** | 2457 `_emitModelSelect`、2477 `setModel`、2519 `cycleModel`、2529 `_cycleScopedModel`、2570 `_cycleAvailableModel` | ModelController |
| 2602-2712 | thinking level + 队列模式 | 2612/2641/2657/2665/2669/2683；2691-2712 把 settings 同步成队列模式 | ModelController / SessionSettings |
| 2714-3256 | **压缩（三入口）** | 2719 `_runDefaultCompaction`、2764 `compact`、2914/2922 两个 abort、2947 `_checkCompaction`、3097 `_runAutoCompaction`、3249 开关 | CompactionController |
| 3258-3700 | **扩展绑定（把内核能力反向暴露给扩展）** | 3258 `bindExtensions`、3279 发 `session_start`、3284 `extendResourcesFromExtensions`、3336 `_applyExtensionBindings`、3360 `_bindExtensionCore`（`runner.bindCore(①操作面,②状态面,③provider 注册面)`）、3495 `_refreshToolRegistry`、3606 `_buildRuntime`、3660 `reload` | ExtensionHost |
| 3701-3827 | 自动重试 | 3709 `_isRetryableError`、3721 `_summarizationRetryCallbacks`、3762 `_prepareRetry`、3807 `abortRetry` | RetryPolicy |
| 3828-3934 | **bash 执行** | 3841 `executeBash`、3879 `recordBashResult`、3905 `abortBash`、3925 `_flushPendingBashMessages` | BashRunner（工作台也在别处用 `BashOperations`） |
| 3935-4160 | 会话命名 + **树导航** | 3942 `setSessionName`；3964 `navigateTree`（含 4025 `session_before_tree`、4057 `generateBranchSummary`、4110 `branchWithSummary`、4141 发 `session_tree`） | BranchNavigator |
| 4161-4336 | 统计 / 导出 | 4183 `getSessionStats`、4237 `getContextUsage`、4288 `exportToHtml`、4314 `exportToJsonl`、4322 `summarizeForBugReport` | Reporting（**导出 HTML/JSONL 属于 CLI 表现层**） |
| 4338-4398 | 工具方法 + 扩展上下文 | 4347 `getLastAssistantText`、4375 `createReplacedSessionContext`、4388 `hasExtensionHandlers` | — |

### 2.2 五条"耦合核心"证据

1. **两层循环**：`agent-core` 已经有 `runLoop`（`agent-loop.ts:163`），`AgentSession` 在它外面又套了 run/continue 循环（`_runAgentPrompt` 1822-1851）。状态机因此有两个所有者：`Agent` 的 `MessageQueue`（`agent.ts:147-171`）和 `AgentSession._steeringMessages`（字段 385 区）。`_queueSteer`（2238）**两边都写**，是同步 bug 的天然温床。
2. **持久化在事件回调里**：`_handleAgentEvent`（1103）在 `message_end` 时直接调 `appendMessage`（1144-1185），并维护 `_entryIdsByMessage`。要改存储格式，必须改事件处理。
3. **压缩的触发点散在 4 处**：`prompt()` 里发前压缩（2054-2057）、`_handlePostAgentRun`（1884）、`_installAgentRequestProjection` 内（838）、`_installAgentNextTurnRefresh`（905）。四处都要先读 settings、再判阈值、再发事件。
4. **扩展系统反向依赖会话**：`_bindExtensionCore`（3360-3493）把 AgentSession 的 30+ 能力编成三个对象交给 runner，包括 `setModel`（3429 还要先查 `hasConfiguredAuth`）、`compact`、`executeTool`、`getCallableTools`。扩展 API 面 ≈ AgentSession 面，两者无法独立演进。
5. **系统提示重建与工具装载耦合**：`_preparePromptAndToolLoadout`（1738）同时决定"哪些工具可见"和"提示词怎么写"，且被 `_installAgentNextTurnRefresh`（909-917）在每轮开始前调用——提示词构建不是纯函数。

### 2.3 它自造的基础设施（本该复用现成模块）

| AgentSession 内的实现 | 已有/更合适的位置 |
|---|---|
| `_eventListeners` + `_emit`（1039-1043） | `core/event-bus.ts`（`createEventBus`，`core/index.ts:31` 已导出） |
| `estimateMessagesTokens`（366-372） | `compaction/compaction.ts`（已有 `estimateContextTokens` 196） |
| 自己维护 `_toolRegistry`、`_toolDefinitions`、`_toolPromptSnippets`、`_toolPromptGuidelines`（471-479） | 独立的 ToolRegistry |
| `_getIdleWaitPromise`（1059-1076） | 未使用现成 promise 工具的临时实现 |
| `getSessionStats`/`exportToHtml`/`exportToJsonl`（4183-4336） | CLI/表现层（`modes/`） |

反例（正面的）：`CacheWarmer` 已经有干净的接缝——`AgentSessionConfig.cacheWarmer?: Pick<CacheWarmer, "cancel"|"status"|"onAgentSettled"|"onModeChanged"|"onWarmed">`（266），`_cacheWarmer` 字段（469）。这是"应该怎么拆"的样板：按 `Pick<>` 收窄契约。

---

## 3. 扩展点清单

### 3.1 四条注册通道

| 通道 | 定义 | 装载点 | 谁在用 |
|---|---|---|---|
| `session.bindExtensions(bindings)` | `agent-session.ts:3258`；`ExtensionBindings` 301-308（uiContext/mode/commandContextActions/abortHandler/shutdownHandler/onError） | `rpc-mode.ts:319`、`print-mode.ts:76`、`interactive-mode.ts:1973`、**`apps/server/src/sessions/pi-runtime.adapter.ts:388`**（`{mode:"rpc", onError}`） | 内核自有三种 mode + 工作台 |
| `extensionFactories: InlineExtension[]` | `DefaultResourceLoaderOptions.extensionFactories`（`resource-loader.ts:285`）；装载 `loadExtensionFactories`（1135-1158，`<inline:N>` 命名 1145，`loadExtensionFromFactory` 1147） | 工作台 `pi-runtime.adapter.ts:352`（`[...remoteExtensions, ...toolFactory.extensionFactories]`）、`tool-factory.ts:103` | 工作台把授权/插件管理/browser 工具都做成 inline 扩展 |
| `additionalExtensionPaths` | `resource-loader.ts:281`；`reload()` 内 530 `resolveExtensionSources(..., {temporary:true})` | 工作台 `pi-runtime.adapter.ts:340`（`[cordisHostPath]`，该文件由 `apps/server/src/kernel.ts` **生成**出来） | 宿主注入（doompi/cordis） |
| `pi.registerTool(...)` | `extensions/types.ts:1643`；汇聚到 `_refreshToolRegistry`（`agent-session.ts:3495`） | 扩展工厂内部调用 | `tool-factory.ts:141/154/165`（plugin_list/validate/install）、202-259（每个 app plugin 的 CRUD）、199 browser 工具 |

关闭链的特例：宿主扩展自己在 `pi.on("session_shutdown", …)` 里收尾（`apps/server/src/kernel.ts` 生成的文件内容），而 `PiAgentRuntime.dispose` 又主动 `session.extensionRunner.emit({type:"session_shutdown", ...})`（`pi-runtime.adapter.ts:236-242`），然后才 `session.dispose()`——**关闭钩子被调用了两次的所有权不清晰**（一次由工作台显式发，一次可能由 `dispose` 内部路径发）。**待核**：`dispose()`（`agent-session.ts:1393`）是否也 emit `session_shutdown`。

### 3.2 `pi.on` 钩子全表（`extensions/types.ts:1569-1636` 是权威定义）

| 分组 | 钩子（定义行） |
|---|---|
| 生命周期/会话 | `project_trust` 1569、`session_start` 1574、`session_info_changed` 1575、`session_before_switch` 1576、`session_before_fork` 1580、`session_before_compact` 1584、`session_compact` 1588、`session_compact_failed` 1589、`session_shutdown` 1590、`mcp_servers_change` 1591、`session_before_tree` 1592、`session_tree` 1596 |
| 上下文/请求 | `context` 1597、`context_with_system` 1598、`before_provider_request` 1599、`before_provider_headers` 1607、`after_provider_response` 1608、`provider_stream_event` 1609、`resources_discover`（payload 712，注册口经 `extendResources`） |
| Agent 循环 | `before_agent_start` 1610、`agent_start` 1614、`agent_end` 1615、`agent_before_settle` 1616、`agent_settled` 1620 |
| 消息/工具 | `message_start` 1625、`message_update` 1626、`message_end` 1627、`tool_execution_start` 1628、`tool_execution_update` 1629、`tool_execution_end` 1630、**`tool_call` 1633**、**`tool_result` 1634**、`user_bash` 1635、`input` 1636、`turn_start` 1623、`turn_end` 1624 |
| UI/选择 | `ui_prompt_start` 1621、`ui_prompt_end` 1622、`model_select` 1631、`thinking_level_select` 1632 |

payload 类型定义行（写类型时有用的锚点）：712/742/758/765/772/785/811/834/841/872/888/898/904/911/920/933/938/1006/1031/1038/1048/1054/1061/1067/1077/1088/1144/1166/1240。

其他注册面：`registerCommand` 1652、`registerShortcut` 1655、`registerFlag` 1664、`registerMessageRenderer` 1687、`registerToolRenderer` 1696、`sendMessage` 1703、`sendUserMessage` 1713、`appendEntry` 1719、`setSessionName` 1726、`setLabel` 1732、`getActiveTools` 1738、`getAllTools` 1741、`getSettings` 1744、`setActiveTools` 1750、`getCommands` 1753、`setModel` 1763、`setThinkingLevel` 1772、`registerProvider` 1830/1831、`registerVirtualModel` 1883、`events: EventBus` 1889。

### 3.3 工作台如何把扩展点当"内核补丁"

`apps/server/src/sessions/tool-factory.ts:103-262` 的 inline 扩展做了三件内核不该知道的事：

1. **路径授权**（112-119）：对 read/write/edit/ls/find/grep 逐个 `tools.check(path)`。
2. **权限策略 + 人工审批**（122-127）：`toolPermission(accessMode, toolName, pluginReadOnlyTools)` → deny 返回 `{block:true,reason}`；ask 调 `input.requestApproval(...)`（阻塞在 HTTP 往返上）。
3. **动态工具注册**（202-259）：按 app plugin 动态生成 `${prefix}_{list,create,update,delete}`。

即：**内核的 `tool_call` 钩子被当成"授权中间件总线"用**。这解释了为什么 `_beforeToolCall`（658）必须存在且必须同步阻塞——它的语义已经从"扩展可以拦一下"变成"安全边界"。

### 3.4 绑定面的规模

`_bindExtensionCore`（3360-3493）交给 runner 的能力分三组，字段定义在 `extensions/types.ts:2145-2201`：

- 操作面（2145-2173）：`registerProvider`/`registerNativeProvider`/`registerVirtualModel`/`sendMessage`/`sendUserMessage`/`appendEntry`/`setSessionName`/`getSessionName`/`setLabel`/`getActiveTools`/`getAllTools`/`getSettings`/`setActiveTools`/`refreshTools`/`getCommands`/`setModel`/`setThinkingLevel`
- 状态面（2181-2201）：`getModel`/`getScopedModels`/`isIdle`/`isProjectTrusted`/`getSignal`/`abort`/`shutdown`/`getContextUsage`/`compact`/`getSystemPrompt`/`getSystemPromptOptions?`/`executeTool?`/`getCallableTools?`

**30 个回调都指向 AgentSession 的私有实现**——扩展 API 与 AgentSession 是一对一的，这层"API"没有抽象价值。

---

## 4. 工具执行链

### 4.1 文件写链（模型 toolCall → 落盘），11 跳

以工作台的 `write` 工具为例（remote 模式更绕，见 4.2）：

1. **模型输出** → `agent-loop.streamAssistantResponse`：`packages/agent/src/agent-loop.ts:403` `await streamFunction(...)`，assistant message 里带 `toolCall` block。
2. **loop 分派**：`agent-loop.ts:270` `await executeToolCalls(...)` → 508 `executeToolCalls` → 520 顺序 / 522 并行 → 530 `executeToolCallsSequential` / 586 `executeToolCallsParallel`。
3. **准备 + 校验 + 授权**：`agent-loop.ts:708` `prepareToolCall` → 726 `prepareToolCallArguments` → 727 `validateToolArguments` → **728-729 `await config.beforeToolCall(...)`**。
4. **beforeToolCall 实体**：`agent-session.ts:653` 把 `agent.beforeToolCall` 指到 `_beforeToolCall` → 658 `_beforeToolCall` → 662-674 `runner.emitToolCall({type:"tool_call", ...})`。
5. **工作台的拦截器**：`apps/server/src/sessions/tool-factory.ts:110` `pi.on("tool_call", ...)` → 112-119 `tools.check(path)` → 122 `toolPermission(...)` → 127 `input.requestApproval(...)`（→ `coordinator.ts:209` → `tool-authorization.ts:54 request` → 发 `approval.requested` 事件 → 前端批准）。
6. **block 语义**：`agent-loop.ts:745-755` 若 `beforeResult.block` → `createErrorToolResult` + `isError:true`（`terminate` 可终止整批）。
7. **执行**：`agent-loop.ts:821` `executePreparedToolCall` → 工具 `execute`。
8. **ToolDefinition → AgentTool**：`core/tools/tool-definition-wrapper.ts:8` `wrapToolDefinition`（21-28 注入 `ExtensionToolContext`）；`write` 的定义由 `tool-factory.ts:72-77` 的 `createWriteToolDefinition(cwd,{operations:{writeFile:checkedWrite, mkdir}})` 构造。
9. **业务实现**：`core/tools/write.ts:44 createWriteToolDefinition` → 48 `ops = options?.operations ?? defaultWriteOperations` → 67 `withFileMutationQueue(absolutePath, …)` 包住 78 `ops.mkdir` / 82 `ops.writeFile` → `ops.writeFile` 即 `tool-factory.ts:56-58` 的 `checkedWrite` → `tools.write(path, content)`。
10. **containment**：`apps/server/src/workspaces/workspace-access.ts:185-193` `localTools.check` → `security.ts:51 workspacePath`：`realpath` 解析根、`contained` 判定、逐级 `lstat` 拒符号链接（62）、拒绝 `.git/.pi/.env/.pi-console` 等私有名（74-76）。返回 `{path, relative, mutationKey, paths}`。
11. **真正落盘**：`workspace-access.ts:198-200` `write: (path, content) => writeFile(await workspacePath(cwd, path, true), content, "utf8")`；remote 分支走 `remoteTools.write`（225-227）→ `RemoteWorkspaceService.writeFile` → `pi-env` daemon。

**串行化有两层，且只在 remote 下双层**：
- 工具层：`write.ts:67 withFileMutationQueue(absolutePath, …)`，键 = 解析后的绝对路径。
- 工作台层（仅 remote，`tool-factory.ts:80-102`）：先 `tools.check` 拿到 `checked.relative` 并把 `path` 改写成项目相对路径（95），非 read 再 `withFileMutationQueue(checked.mutationKey, …)`（97-99），键 = `remote.mutationKey(...)`。
- **HTTP 保存文件**是第三条路径：`workspace-access.ts:141-150 localFiles.write`，`withFileMutationQueue(target, …)`（143）+ revision 校验（145-146，409 "The file changed on disk. Reload before saving."）。
- 本地工作区里工具层与 HTTP 层的队列键都是同一个绝对路径，因此互斥成立（少见的正确点）；remote 下两层键不同（绝对路径 vs `remote.mutationKey`），互斥只在各自层内有效（**待核**：`remote.mutationKey` 是否就是远端绝对路径）。

### 4.2 bash 链

1. 模型 toolCall → 同 4.1 第 1-6 跳（`bash` 也在 `tool_call` 拦截器名单里，`tool-factory.ts:112-119`）。
2. `createBashToolDefinition`（`core/tools/bash.ts:427`）→ `createShellToolDefinition`（243）→ `ops = options?.operations ?? createLocalBashOperations({shellPath})`（248）。
3. `BashOperations` 接口：`core/tools/bash.ts:75`（`exec(command, cwd, {onData, signal, timeout})`）；本地实现 `createLocalShellOperations`（97）/`createLocalBashOperations`（174）。
4. 执行器：`core/bash-executor.ts:48 executeBashWithOperations` → **121 `({exitCode} = await operations.exec(command, cwd, {onData, signal}))`**。
5. 工作台覆盖：`apps/server/src/workspaces/command-operations.ts:12 workspaceCommandOperations` → 19-36 返回 `BashOperations`，`exec` 内 22 `remote.toolPath` → 23 `remote.checkedPath` → 24 `checked.env.exec(command, {cwd, timeout, onOutput}, context)`（`pi-env` 远端执行）。
6. 本地工作区返回 `undefined`（`command-operations.ts:17`），落入内核默认实现——注释 7-11 明说"Undefined selects the SDK's builtin local backend"，即**同一能力由两个包分别实现本地/远端**。

### 4.3 拦截点分布（三层，语义重叠）

| 层 | 位置 | 拦截内容 |
|---|---|---|
| L1 扩展 | `agent-session.ts:658 _beforeToolCall` → `tool-factory.ts:110` | 路径授权、权限策略、人工审批（可 block/terminate） |
| L2 loop | `agent-loop.ts:728-755` | 执行前统一 hook 点（参数校验之后） |
| L3 文件系统 | `security.ts:51 workspacePath` | containment、符号链接、私有路径 |

三层都要过一遍，且 **L1 与 L3 都是"安全边界"**：L1 依赖扩展是否被正确加载（可被 `noExtensions`/信任策略关掉），L3 才是真正兜底。这就是"授权逻辑藏在扩展里"的结构性风险。

---

## 5. 会话与持久化：双权威

### 5.1 SessionManager 数据模型

`packages/coding-agent/src/core/session-manager.ts`（2013 行）。

- 版本：`41 export const CURRENT_SESSION_VERSION = 3;`；header 43-50（`version?: number`，v1 无版本）。
- 11 种条目（`SessionEntryBase` 57-62：`{type,id,parentId:string|null,timestamp}`）：

| 类型 | 行 | 是否进 LLM 上下文 |
|---|---|---|
| `message` | 64-67 | 是 |
| `thinking_level_change` | 69-72 | 否（状态） |
| `model_change` | 74-78 | 否（状态） |
| `usage` | 80-89 | 否 |
| `compaction` | 91-104（`summary, firstKeptEntryId, tokensBefore, details?, usage?, fromHook?, systemMessage?`） | 是（替代历史） |
| `branch_summary` | 106-116（`fromId, summary, …`） | 是 |
| `custom` | 128-132（`customType,data?`；注释 125 明确"不参与 LLM 上下文"） | 否 |
| `label` | 135-139 | 否 |
| `session_info` | 142-145 | 否 |
| `custom_message` | 159-165（注释 151：转成 user 消息） | 是 |
| `context_edit` | 175-180（`targetId, replacement:{content}|null`，append-only 改写历史贡献） | 是（改写） |

- 上下文重建：439 `sessionEntryToContextMessages`、476 `buildContextEntries`、543 `buildSessionProjection`、576 `buildSessionContext`；projection 类型 209-221。
- 版本迁移：341 `if (version >= CURRENT_SESSION_VERSION) return false;`、350 `migrateSessionEntries`、355 `parseSessionEntries`。
- **JSONL 写入路径**：`1057 newSession()` → 1065 写 `version` → 1079 `fileTimestamp = timestamp.replace(/[:.]/g,"-")` → 1080 `join(sessionDir, \`${fileTimestamp}_${sessionId}.jsonl\`)`。默认 `sessionDir` 来自 `596 getDefaultSessionDir`；**工作台显式传 `join(directory,"sessions")`**（`pi-runtime.adapter.ts:355-357`）。

| 写入行为 | 行 | 说明 |
|---|---|---|
| 懒建文件 | 1166 `_hasConversation()` | 只有出现 user/assistant message 才建文件 |
| 首次全量 | 1172-1185 `_persist` | `openSync(file,"wx")` 写全部 entries |
| 之后追加 | 1187 | `appendFileSync(file, JSON.stringify(entry)+"\n")` |
| 索引维护 | 1191 `_appendEntry` | 同步 `fileEntries`/`byId`/`leafId` |
| 迁移重写 | 1092 → 1124 `_rewriteFile` | 版本升级时整文件重写 |

- 树操作：1404 `getLeafId`、1412 `getEntry`、1419 `getChildren`、1469 `getBranch(fromId?)`、1529 `getTree`、1579 `branch`、1591 `resetLeaf`、1600 `branchWithSummary`、1632 `createBranchedSession`（新文件 + 新 header，**1850-1861 复制分支条目，待核**）。
- 追加 API：1204 `appendMessage`、1217 `appendThinkingLevelChange`、1230 `appendModelChange`、1244 `appendUsage`、1290 `appendCustomEntry`、1304 `appendSessionInfo`、1360 `appendContextEdit`、1441 `appendLabelChange`。

### 5.2 工作台侧的第二套权威

| 组件 | 事实 |
|---|---|
| `apps/server/src/persistence/transcript.ts:31-88` | `SessionManager.open(file)` → `getBranch()` → 转成 `ChatMessage`/`ToolCall`。**自述"transcript 是对话内容的 source of truth"（注释 25-30）**。message id 形如 `user:${entry.id}`（41）/`assistant:${entry.id}`（53）。无 result 的工具调用补 `RESTART_OUTPUT`（5、84-86）。 |
| `apps/server/src/sessions/event-projector.ts:143-197 hydrate` | 有 checkpoint 则重放事件（144-154，不一致抛 409）；否则 168-175 `readTranscriptView(meta.file)` → 177-187 `mergeTranscript(meta, transcript, evidence)`；188-194 transcript 为空时退回 snapshot，两者皆无抛 409（192）。 |
| 同上 `project` 311-356 | 单事务写"事件 + meta + 快照"（324-352）；`message.delta`/`tool.updated` 且距 checkpoint <100 时只存事件（342-346）。 |
| `apps/server/src/persistence/session-projection.ts` | `SESSION_META_VERSION = 3`（11）；`SessionMeta`（36）；`projectSessionMeta`（72）；`mergeTranscript`（152）；`mergeSnapshot`（232）；`LegacyMetadataConflict`（145，v<2 且消息 id 有歧义时拒绝合并 197-198）。 |
| 传输 | `transport/websocket/session-stream.ts:18-27`：先 `subscribe` 再同步发 `session.snapshot`（`agents.get(id)`）。 |

### 5.3 双权威的六条具体表现

1. **两套 id**：内核 `entry.id`（SessionManager 生成）vs 工作台 `message.id`。活流里是 `\`${role}:${randomUUID()}\``（`pi-events.ts:24`），重载后是 `\`${role}:${entry.id}\``（`transcript.ts:41/53`）。**同一条消息在"运行中"和"重启后"拿到不同 id**——前端若用 id 做 key/引用会错位。`pi-events.ts:72-73` 只是在同一进程内尽量复用 pending id。
2. **两套版本号**：`CURRENT_SESSION_VERSION = 3`（内核）与 `SESSION_META_VERSION = 3`（工作台，`session-projection.ts:11`），互不感知；工作台还额外有 `meta.version < 2` 的升级分支（158-167、179-186）。
3. **两套真相排序**：内核 JSONL 是 append-only 事件日志（真相 = 条目序列）；工作台是 "meta + 事件表 + 快照"（真相 = 快照 + 重放）。`hydrate` 里二者**互相兜底**（178-194），各自都能单独失败。
4. **两套提交边界**：内核 `appendFileSync` 每条 entry 一次（1187）；工作台 `withTransaction` 一次提交三样（`event-projector.ts:324-352`）。中间崩溃 → 两份记录不一致，只能靠 `recover()`（251-303，读 transcript 重建）修补。
5. **两套"导航"语义**：内核 `navigateTree` 改 `leafId` 并可写 `branch_summary`（`agent-session.ts:3964`、4110/4125/4128）；工作台另记一条 `pi-console.navigation` custom entry（`pi-runtime.adapter.ts:217-235`）来表达 UI 的导航意图。**同一次回退在文件里留下两种记录**。
6. **两套"消息是否完整"**：内核靠 `message_end` + `_entryIdsByMessage`（`agent-session.ts:1144-1185`）；工作台靠 `mergeTranscript` 对 `complete` 字段（`transcript.ts:45/57` 直接置 `true`）+ toolCall 状态推断（61-81）。**UI 的"流式中"状态只存在于工作台内存**，重启即丢失。

### 5.4 `getBranch` / `navigateTree` 语义（重构时必须保真的行为）

`navigateTree(targetId, options)`（3964）：
- 运行中/压缩中直接抛错（3968/3971）。
- 3995 `collectEntriesForBranchSummary(sessionManager, oldLeafId, targetId)` 收集被放弃的条目。
- 4025 `session_before_tree` 扩展钩子（可 cancel / 提供 summary / 改 instructions+label）。
- 4057-4069 `generateBranchSummary(..., {streamFn: this.agent.streamFunction, retry, callbacks})` —— **摘要生成复用会话的 streamFn**（即分支摘要也走同一模型网关）。
- 4092-4100 目标若是 user 消息，则把编辑器文本挂到其 `parentId` 下（新叶子）；否则叶子 = targetId。
- 4110 `branchWithSummary` / 4125 `resetLeaf` / 4128 `branch`；4137 `_refreshFinalizedContext`；4138 `_restoreToolsFromTranscript`；4141 发 `session_tree`。

---

## 6. 上下文与压缩

### 6.1 三个入口，一个实现

| 入口 | 位置 | 触发 |
|---|---|---|
| 手动 | `agent-session.ts:2764 compact(customInstructions?)` | `/compact`、RPC、扩展 `ctx.compact()` |
| 阈值/溢出 | 2947 `_checkCompaction` → 3097 `_runAutoCompaction("threshold"\|"overflow", willRetry)` | `_handlePostAgentRun`（1884） |
| 请求前 | 776 `_compactBeforeNextAssistantResponse` | `prompt()` 2054-2057、request projection 838、next-turn refresh 905 |

三者都收敛到 `compaction/compaction.ts`：`prepareCompaction`（872）、`compact`（965）、`shouldCompact`（267）、`estimateContextTokens`（196）/`estimateProjectedContextTokens`（227）。`_runDefaultCompaction`（2719-2742）把 12 个参数摊给 `compact(...)`（含 `streamFn`、`retry`、`callbacks`、`env`）——**耦合已经被"参数化"掩饰，但调用方仍需知道模型鉴权、重试设置、summarization 回调**。

### 6.2 token 估算：`Math.ceil(chars/4)` 是全部实现

`compaction/compaction.ts:298-349 estimateTokens(message)`：按消息类型累加字符数（system 含 sections/toolsAdded；assistant 含 text+thinking+toolCall 的 name/args JSON；`bashExecution` = command+output；summary = `summary.length`；image 固定 `ESTIMATED_IMAGE_CHARS = 4800`（276）），**每个分支都以 `return Math.ceil(chars / 4)` 收尾：311、317、330、335、339、344 共 6 处**。

结论：**没有 `CHARS_PER_TOKEN` 常量**。该名字只出现在别处：
- `packages/ai/src/utils/estimate.ts:15` `CHARS_PER_TOKEN = 3.5`
- `packages/codemode` 两处 `CHARS_PER_TOKEN = 4`

即同一个仓库里有 3.5 和 4 两种字符/token 假设，且压缩路径用的是字面量 `4`（分散 6 处，改一处无效）。

### 6.3 压缩算法骨架

- 设置：`CompactionSettings{enabled, reserveTokens:16384, keepRecentTokens:20000}`（120-130）。
- 判定：`shouldCompact(ctx, window, settings) = ctx > window - reserveTokens`（267）。
- 上下文量：`calculateContextTokens(usage)`（140，优先 `usage.totalTokens`）、`estimateContextTokens`（196，最后一次真实 usage + 之后估算）、`estimateProjectedContextTokens`（227）。
- 切点：`findTurnStartIndex`（412）、`findCutPoint`（446）、`prepareCompaction`（872，内部 880 `buildSessionProjection`、897 `tokensBefore`、898 `findProjectedCutPoint`、917 `extractFileOperations`）。
- 摘要：`generateSummary`（645）/`generateSummaryWithUsage`（696）；`compact`（965）在 `isSplitTurn` 时（994）把 history 与 turn prefix 分两次 summarize。
- 文件操作表：`compaction/utils.ts:30 extractFileOpsFromMessage`（含 `nestedCalls`）、47 `addFileOp`、67 `computeFileLists`、77 `formatFileOperations`（`<read-files>`/`<modified-files>`）。
- 序列化：`utils.ts:114 serializeConversation`（`[User]:`/`[Assistant thinking]:`/`[Assistant tool calls]:`/`[Tool result]:`，`TOOL_RESULT_MAX_CHARS = 2000` 94，截断标记 161 区域的 `[... N more characters truncated]`）。
- 分支摘要：`branch-summarization.ts`（382 行，入口 `generateBranchSummary`）。

### 6.4 问题

1. **触发点四散**（§2.2 证据 3），且都要读 `getBranch()`——压缩与存储的读模型强耦合。
2. **估算与真实 usage 混用**：`calculateContextTokens` 用 provider 返回值，`estimateProjectedContextTokens` 用 `ceil(chars/4)`，两者在同一个判定里出现（3056 vs 3081 附近），误差来源不可观测。
3. **压缩期间禁止输入**：`prompt()` 1986-1990 在压缩中直接拒绝；`navigateTree` 3971 同样。这是"状态机耦合"直接变成用户可见的产品限制。
4. **摘要复用会话 streamFn**（4057、2719 传 `this.agent.streamFunction`），所以"压缩能不能跑"依赖会话的模型配置，无法独立配置（虽然有 `_getSummarizationRequestAuth`）。

---

## 7. 模型网关

### 7.1 `ModelRuntime` 如何装配 pi-ai providers

`packages/coding-agent/src/core/model-runtime.ts`（1034 行）：

1. 选项：`CreateModelRuntimeOptions`（108-124）——`authPath`/`modelsPath`/`modelsStore(Path)`/`allowModelNetwork`/`catalogBaseUrl`/`refreshOnCreate`。
2. `static async create`（216-261）：
   - 217 `new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(authPath))`
   - 219 `modelsPath ?? join(getAgentDir(),"models.json")`；220 `ModelConfig.load(modelsPath)`
   - 221-225 存储：`FileModelsStore` / `InMemoryCodingAgentModelsStore`
   - **227-233 内置目录**：`builtinProviderCatalog.builtinProviders().map(p => p.id === "radius" ? p : withRemoteCatalog(p, catalogBaseUrl, builtinModelDataGeneratedAt))`
   - 242 `configureRadiusProviders()`；243 `rebuildProviders()`
   - 254-256 `refreshOnCreate !== false` 时 `await runtime.refresh({allowNetwork: refreshFromNetwork, signal})`（网络开关见 240：`modelNetworkEnabled && allowModelNetwork === true`，并参考 `process.env.PI_OFFLINE`）
3. 类内状态（172-196）：`models: MutableModels`（212 `createModels({credentials, modelsStore})`）、`defaultBuiltins`（210）、`builtins`、`nativeExtensionProviders`、`extensionProviders`、`virtualModels`、`compositionErrors`。
4. 组装：`200-214 private constructor` → `rebuildProviders`（319）把 builtin + config overlay + 扩展注册的 provider 合成为最终 provider 集合；单 provider 走 `composeProvider`（301，`composeModelProvider(providerId, base, config, extension)`）。
5. 可用性：335 `runAvailabilityRefresh`（`models.getAvailable` + 每 provider `checkAuth` + `credentials.list`）。
6. 请求：651 `prepareRequest(model, options)` → 查 provider → `getAuth` → merge headers + `transformHeaders` → baseUrl 覆盖 → `{provider, model, options}`；716 `streamSimple`：718-735 虚拟模型 `resolveModel` 后递归重路由，737-741 否则 **`prepared.provider.streamSimple(prepared.model, transcript, prepared.options)`**；744 `completeSimple`。
7. 扩展注册：884 `registerNativeProvider`、921 `registerProvider`、944 `unregisterProvider`、957 `registerVirtualModel`、996 `resolveModel`、1030 `getPhysicalModel`。工作台经 `ctx.registerProvider` 走这条路（`_bindExtensionCore` 的第三组）。

### 7.2 调用链与 `setDefaultStreamFn`

```
AgentSession.prompt()                        agent-session.ts:1968
  └─ _runAgentPrompt                        agent-session.ts:1822
      └─ Agent.prompt()                     agent.ts:371
          └─ runAgentLoop → runLoop         agent-loop.ts:102/163
              └─ streamAssistantResponse    agent-loop.ts:381
                  └─ config.streamFunction  agent-loop.ts:403
                      └─ sdk.ts:430 闭包: modelRuntime.streamSimple(model, context, requestOptions)
                          └─ ModelRuntime.streamSimple   model-runtime.ts:716
                              └─ provider.streamSimple   model-runtime.ts:737-741
```

- `setDefaultStreamFn(streamSimple)` 在 **`packages/coding-agent/src/core/sdk.ts:46`**（注释 43-45：保留 pre-0.81 回退；Agent core 保持 provider-agnostic，不 import `pi-ai/compat`）。
- 默认值只对"没有显式 streamFn 的 Agent"生效：`agent.ts:236` `this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn()`；`stream-fn.ts:11/15` 存取，17 无配置时 throw `No default stream function configured…`。
- `sdk.ts:411-446` 里显式传了 `streamFn`（→ `modelRuntime.streamSimple`），所以**工作台路径不依赖全局默认**，但全局默认仍被 CLI/其他 mode 使用。

### 7.3 三处"模型权威"

| 权威 | 位置 |
|---|---|
| 会话当前模型 | `AgentSession.model` / `agent.state.model`；`sdk.ts:219-251` 从分支 `model_change` 恢复 |
| 可用模型目录 | `ModelRuntime.getAllModels/getAvailable`（工作台 `pi-runtime.adapter.ts:274-283` 另建一个只读 ModelRuntime 来列模型） |
| 默认模型 | `SettingsManager.getDefaultProvider/Model`（`pi-runtime.adapter.ts:286-294` + `defaultModelPerProvider` 269-271） |

工作台为了"列模型"又 `ModelRuntime.create(...)` 了一次（274-283，`allowModelNetwork:false, refreshOnCreate:false`），与 `createAgentSession` 内部创建的那个（`sdk.ts:198`）是两个实例——**同一进程内多份 provider 目录**，配置变更需要 `prepareForProviderChange`（`coordinator.ts:263`）逐个刷新。

---

## 8. 分层大纲（给画图用）

```
L0 宿主层
   ├─ 浏览器 (apps/web: React + Vite；对 @earendil-works/* 零 import)
   ├─ CLI / TUI (packages/coding-agent/src/main.ts, modes/interactive)
   └─ 操作系统：文件系统、子进程、SSH 目标机、模型 HTTP API

L1 工作台层 (apps/server, private, in-process)
   ├─ 组合根      bootstrap/create-app.ts           (Fastify, 安全头, 路由注册)
   ├─ 传输        transport/http/*, transport/websocket/*
   ├─ 会话编排    sessions/coordinator.ts            (619 行，唯一持有 AgentRuntime 的地方)
   │   ├─ sessions/pi-runtime.adapter.ts             (413 行，SDK 接缝最重)
   │   ├─ sessions/pi-events.ts                      (内核事件 → 工作台事件)
   │   ├─ sessions/tool-factory.ts                    (授权/审批/动态工具，用扩展钩子实现)
   │   └─ sessions/tool-authorization.ts              (审批状态机，5 分钟超时)
   ├─ 持久化投影  sessions/event-projector.ts + persistence/{transcript,session-projection}.ts
   ├─ 工作区      workspaces/{service,workspace-access,command-operations,office-preview}.ts
   ├─ 其他服务    providers.ts(378) packages.ts(361) browser.ts(569) remote-*.ts(406/183)
   └─ 宿主补丁    kernel.ts  (生成 "cordis host" 扩展文件注入内核)

L2 SDK 接缝  ← 编译期直接 import 源码（dev 用 source-resolver），5 包 / 12 文件 / 26+ 符号
   向上暴露：工厂(createAgentSession) + 零件(ModelRuntime/SettingsManager/
             DefaultResourceLoader/SessionManager) + 工具工厂(*ToolDefinition) +
             工具函数(withFileMutationQueue/mime detect) + 扩展工厂(codemode/mcp/tool-search)
   向下依赖：整个 coding-agent barrel（含 CLI/TUI/modes）—— 接缝没有"面"

L3 内核层 (packages/*)
   ├─ loop       agent-core/agent-loop.ts (949) + agent.ts (613)   ← 最干净的一层
   ├─ 会话       coding-agent/core/agent-session.ts (4398)          ← 事实上的"第二内核"
   │             + agent-session-runtime.ts / agent-session-services.ts / sdk.ts (487)
   ├─ 上下文     coding-agent/core/compaction/* (compaction 1119 + utils 163 + branch-summary 382)
   │             + resource-loader.ts (1287, 系统提示/技能/模板/扩展路径)
   ├─ 工具       coding-agent/core/tools/* (read 224, edit, write, bash 435, grep, ls, find,
   │             tool-definition-wrapper 54, file-mutation-queue 54)
   ├─ 模型       coding-agent/core/model-runtime.ts (1034) → pi-ai (providers/credentials/catalog)
   ├─ 扩展       coding-agent/core/extensions/{runner 1426, loader 780, types 1998}
   ├─ 持久化     coding-agent/core/session-manager.ts (2013, JSONL)
   ├─ 表现       modes/{interactive,print,rpc} + tui + chord
   └─ 远端       env (RemoteExecutionEnv / packagedDaemon)

L4 外部依赖
   ├─ 模型 provider HTTP（经 pi-ai providers）
   ├─ MCP servers（经 pi-mcp 扩展）
   ├─ pi-env daemon（SSH 远端工作区）
   └─ npm 包：fastify 5.12.5 / @fastify/websocket / playwright-core 1.64 / typebox / zod / chalk / undici
```

**依赖方向（画图时的箭头）**

```
web ──HTTP/WS──▶ server ──import──▶ coding-agent ──▶ {agent-core, ai, chord, env, tui, mcp, codemode}
                    │                    │
                    └──import──────────▶ pi-ai / pi-agent-core / chord / pi-env   （旁路，见 §1.1）
coding-agent ──▶ agent-core ──▶ ai        （干净方向）
agent-core   ──✗──▶ coding-agent          （反向无依赖，这是唯一守住的分层）
```

**commodity vs 自研（决定"能不能换/能不能删"）**

| 模块 | 性质 | 判断 |
|---|---|---|
| `agent-core` 的 loop（`agent-loop.ts`） | 接近 commodity | 通用水准：loop + 工具批处理 + 并行执行。可替换成本中，**语义已被 AgentSession 深度依赖**（6 个注入钩子） |
| `pi-ai` providers/credentials | commodity | 换 SDK 层最现实的部分，但 `ModelRuntime` 的 overlay/virtual model 逻辑是自研且被扩展系统使用 |
| `SessionManager`（JSONL） | 自研 | 11 种 entry + tree；工作台把它当只读真相源，**换存储要同时改工作台** |
| `AgentSession` | 自研，且是耦合中心 | 4398 行，18 个职责块，无法整体替换，只能逐块拆 |
| `compaction/*` | 自研 | 算法可读、契约已是纯函数；**最适合先拆** |
| `extensions/*` | 自研 | 39 个钩子 + 30 个绑定回调，API 面 ≈ AgentSession 面；拆它要先有 host 抽象 |
| `modes/{tui,interactive,rpc}` | 自研（表现层） | 与内核同仓同 barrel；工作台借 `mode:"rpc"` 走 RPC 语义 |
| `tools/*` | 自研 | 薄，`operations` 注入点已经是干净的接缝（`ReadOperations`/`BashOperations`） |
| `chord` / `env` | 自研基础设施 | chord = 带取消的 context/流；env = 远端执行。工作台绕过包声明直接用 |

---

## 9. 接缝候选与排序

### 9.1 候选表

| # | 候选接缝 | 位置 | 收益 | 风险 | 建议顺序 |
|---|---|---|---|---|---|
| 0 | **门面化 SDK 接缝**：把 `apps/server` 所有 `@earendil-works/*` import 收敛到 `apps/server/src/kernel/*.ts`（`kernel.ts` 已有名字，可扩展成 `kernel/index.ts`） | §1.1 的 12 个文件 | 立刻让"5 包 26 符号"变成单点，后续任何内核改动只需改门面 | 极低（纯搬运 + 重导出） | **第 0 步，先做** |
| 1 | **压缩子系统**：`CompactionController` | `agent-session.ts:2714-3256` + 767-844 + 366-372；依赖 `compaction/*` | AgentSession 掉 ~550 行；三入口合一；契约已是纯函数 | 中低：要搬 settings/事件/持久化调用点，但都在同一文件内 | **第 1 个代码级拆解** |
| 2 | **工具注册表 + 装载**：`ToolRegistry` | 471-479、1483-1575、3495-3604、1809 | 解开"工具可见性 × 系统提示"耦合 | 中：与 `_rebuildSystemPrompt`（1700）连锁 | 2 |
| 3 | **扩展宿主**：`ExtensionHost` | 3258-3700、1284-1362、658-724 | 让扩展 API 不再等于会话 API | 高：绑定面 30 个回调，且工作台授权依赖 `tool_call` | 3（需先有 1、2） |
| 4 | **持久化/投影**：`SessionStore` | 1103-1281、938-1033 | 事件回调里长出持久化的问题根治 | 高：涉及工作台双权威合并（§5.3），要同时改工作台 | 4（与工作台重构协同） |
| 5 | **外层循环**：`RunController` | 1822-1957 | 消除"两层循环/两套队列" | 很高：动 agent-core 契约 | 最后 |
| 6 | **树导航** | 3964-4160 | 独立且可测 | 中 | 可随时插队（无外部依赖） |
| 7 | **bash 执行** | 3828-3934 | 小、边界清楚 | 低 | 可随时插队 |

### 9.2 为什么"压缩子系统"是第一个拆解接缝

1. **契约已经是纯函数，只是调用点散落**。`prepareCompaction(pathEntries, settings)`（`compaction.ts:872`）的输入是 `SessionEntry[]`（不是 SessionManager），输出是 `CompactionPreparation`（772）；`compact(preparation, …)`（965）已经是 12 参函数。也就是说**耦合早已被"参数爆炸"掩盖**，抽取只需要把"谁传入这些参数"从 AgentSession 搬到新类，不需要重新设计。
2. **三个入口共用一个实现**，抽取后行为等价性容易验证：手动（2764）、阈值/溢出（2947/3097）、请求前（776）都要走同一个方法，测试可以按入口逐一对比事件序列（`compaction_start`/`compaction_end`/`session_compact`）。
3. **它的输出面很窄**：只产生 `CompactionResult` + 4 个事件 + 一条 `appendCompaction`（2847/3177）。相比之下，"扩展宿主"的输出面是 30 个回调，"外层循环"的输出面是整个状态机。
4. **它是正确性最热的区域**：token 估算（`ceil(chars/4)` ×6）、overflow 恢复、split turn 两次摘要、`context_edit` 改写（1237）都在这 550 行里，独立成模块后可以单测，不必构造完整会话。
5. **与工作台无关**：工作台只通过 `runtime.compactions()`（`pi-runtime.adapter.ts:155`，数 compaction entry 个数）和事件观察它——**没有 UI 概念泄漏进来**。这一点排除掉"工具授权"（工作台安全边界）和"持久化"（双权威）作为第一步。

### 9.3 拆解前的三个硬约束（写阶段计划时必须写进去）

1. **`AgentSessionEvent` 是公开契约**（`index.ts` 导出、`apps/server/src/sessions/pi-events.ts:3` 消费、10 个测试依赖）。任何重构必须先冻结事件联合（196-237）再动实现。
2. **工作台授权依赖 `tool_call` 同步返回 `{block}`**（`tool-factory.ts:110-127`）。在扩展宿主抽出来之前，`_beforeToolCall` 的语义不能变。
3. **JSONL 是工作台的只读真相源**（`transcript.ts:31-88`）。`SessionManager` 的 entry 类型、`getBranch()`、版本号 3 都是跨层契约，不能单方面改。

---

## 附录 A：证据索引（高频引用）

| 事实 | 位置 |
|---|---|
| 会话类总行数 | `packages/coding-agent/src/core/agent-session.ts` 4398 行 |
| 事件联合 | `agent-session.ts:196-237` |
| 配置 | `agent-session.ts:252-299` |
| 构造函数装 6 个钩子 | `agent-session.ts:513-525` |
| 工具拦截接缝 | `agent-session.ts:652-655`、`658`、`684` |
| 持久化在事件回调 | `agent-session.ts:1103`、`1144-1185` |
| 外层二次循环 | `agent-session.ts:1822-1851` |
| 压缩三入口 | `agent-session.ts:776`、`2764`、`2947`、`3097` |
| 扩展绑定 | `agent-session.ts:3258`、`3360`、`3495` |
| 树导航 | `agent-session.ts:3964`、`4110`、`4125`、`4141` |
| loop 主循环 | `packages/agent/src/agent-loop.ts:163`、`242`、`270` |
| 工具执行 | `agent-loop.ts:508`、`708`、`728`、`811`、`821`、`870` |
| 默认 streamFn | `packages/coding-agent/src/core/sdk.ts:46` |
| SDK 工厂 | `sdk.ts:191`、`411-446`、`461-478` |
| 版本常量 | `core/session-manager.ts:41` |
| JSONL 路径 | `core/session-manager.ts:1079-1080`、`1187` |
| 分支读取 | `core/session-manager.ts:1469`、`1493`、`1579` |
| token 估算 | `core/compaction/compaction.ts:298-349`（`Math.ceil(chars/4)`：311/317/330/335/339/344） |
| 压缩参数 | `core/compaction/compaction.ts:120-130`、`267`、`872`、`965` |
| provider 装配 | `core/model-runtime.ts:216-261`、`227-233`、`301`、`651`、`716-741` |
| 扩展钩子定义 | `core/extensions/types.ts:1569-1636` |
| 扩展绑定契约 | `core/extensions/types.ts:2145-2201` |
| inline 扩展装载 | `core/resource-loader.ts:281-286`、`513-596`、`1135-1158` |
| 工作台接缝 | `apps/server/src/bootstrap/create-app.ts:4`、`sessions/pi-runtime.adapter.ts:3-16`、`sessions/tool-factory.ts:2-10` |
| 工作台装配 | `pi-runtime.adapter.ts:296-397`（311/313/314/336-353/354/355-357/358-385/388-391） |
| 授权钩子 | `apps/server/src/sessions/tool-factory.ts:110-127` |
| containment | `apps/server/src/security.ts:51-77` |
| 工具实现 | `apps/server/src/workspaces/workspace-access.ts:37-44`、`182-207`、`209-233` |
| 远端 bash | `apps/server/src/workspaces/command-operations.ts:12-36` |
| JSONL 读取 | `apps/server/src/persistence/transcript.ts:31-88` |
| 投影/水合 | `apps/server/src/sessions/event-projector.ts:143-197`、`311-356` |
| 消息 id 分歧 | `apps/server/src/sessions/pi-events.ts:24` vs `persistence/transcript.ts:41/53` |
| 事件适配 | `apps/server/src/sessions/pi-events.ts:110-163` |
| 审批状态机 | `apps/server/src/sessions/tool-authorization.ts:54-120` |

## 附录 B：待核清单

1. `apps/server/src/remote-workspaces.ts:24` 从 `pi-env` 引入的具体符号（只读到 import 收尾行）。
2. `session-manager.ts:1632 createBranchedSession` 内部 1850-1861 的分支复制逻辑（grep 命中，未逐行读）。
3. `AgentSession.dispose()`（1393-1414）是否也触发 `session_shutdown` 扩展事件——若是，则与 `pi-runtime.adapter.ts:236-242` 的显式 emit 重复。
4. `ModelRuntime.configureRadiusProviders()`（242）与 `withRemoteCatalog`（227-233）的 network/离线分支细节。
5. `_bindExtensionCore`（3360-3493）中 `setModel`（3429）、`executeTool`、`getCallableTools` 的完整实现分支。
6. `apps/server` 在干净安装（`npm ci`）下能否解析 `@earendil-works/chord` 与 `@earendil-works/pi-agent-core`（未声明依赖，依赖 monorepo hoisting）。
7. `packages/coding-agent/src/index.ts` 导出面与 `packages/coding-agent/src/core/index.ts` 的差异是否还有工作台实际用到的符号（本次以 `apps/server` 的 import 为准，未反向枚举 495 行）。
8. **已确认的死代码**：`apps/server/src/sessions/pi-events.ts:46 adaptRpcEvent` 在 `src` 内没有任何调用点（grep `adaptRpcEvent|adaptSdkEvent|adaptRuntimeEvent` 只命中定义与 `pi-runtime.adapter.ts:32/135`），实际链路是 `adaptRuntimeEvent`（166）→ `adaptSdkEvent`（110）。待核：`JsonAgentSessionEvent`（`pi-events.ts:3` 引入）是否还有其他消费者，若没有则可连同 `adaptRpcEvent` 一起删除。
