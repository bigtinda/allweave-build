# AllWeave Build 架构与内核重构方案

> 基线：`D:/project/pi-main/.pi/worktrees/fix-rebuild`，HEAD `00d2afaa1`（2026-11-03 工作树）。
>
> 检查前置：在全新 worktree 先运行 `npm install --ignore-scripts`。若 `packages/ai/node_modules/openai` 缺失，TypeScript 会退到根目录的 devDependency `openai@6.40.0`，在 `packages/ai/src/api/openai-responses.ts` 报 `prompt_cache_options` / `"fast"` 类型错误；完整安装使用 `openai@7.19.0` 后 `npm run check` 通过。
>
> 方法：逐文件阅读 `apps/server`、`apps/web`、`desktop`、`packages/coding-agent`、`packages/agent`、`packages/ai`、`packages/durable`、`packages/chord`、`packages/env` 的实现与测试，再用静态检索核对导入关系。本文只记录代码里能验证的事实；旧架构文档、审计报告和阶段计划已删除，因为其中关于 `apps/server/src/kernel` facade、12 个 `kernel-*` 包、S0–S9 阶段的描述与当前代码不一致。
>
> 本文是唯一现行架构文档。代码变化后直接改这里，不再新增第二份架构说明。

---

## 0. 结论先行

1. **当前工作台不是“Pi RPC 控制内核”。** 本地 Node 服务在自身进程里直接调用 `createAgentSession()`，会话、模型请求、工具执行都在服务进程内完成；没有独立内核进程，也没有跨进程 RPC。原 `apps/server/src/kernel.ts` 不是内核 facade，它是 doompi 的 Cordis host 安装器；M0 已改名为 `apps/server/src/legacy/doompi-host.ts`。
2. **真正的内核是 `packages/coding-agent` 的 `AgentSession`。** 它 4,398 行，承担会话生命周期、模型运行时、工具注册、上下文构建、压缩、扩展宿主、权限钩子、持久化协调等职责。`packages/agent` 只是它下面的 loop，`packages/ai` 是 provider transport。
3. **工作台在 `AgentSession` 外面又长了一层“半内核”。** `apps/server` 的 `SessionCoordinator`、`EventProjector`、`ToolAuthorization`、`PiAgentRuntime` 负责运行队列、事件投影、审批、工具策略、SQLite 快照；这些本应属于内核，现在跨包重复。
4. **当前有三套可运行 runtime。** ① coding-agent CLI（TUI/print/rpc）；② workbench 的进程内 SDK；③ experimental durable harness（`packages/durable` + `packages/chord`）。第三套不在工作台会话主链路，但通过 `pi-env` 被远程工作区拖进了 `apps/server` 的依赖树。目标架构移除远程工作区，`pi-env`/`chord`/`durable` 随之退出产品依赖。
5. **目标不是“再包一层 Pi”，而是把内核换成自己的。** 新内核只做会话状态机、loop、上下文、工具、策略、事件存储和最小扩展钩子；server 只做 HTTP/WS 与组装，web 只依赖纯协议包。
6. **最终保留的 Pi 部分很小。** 运行时只保留 `pi-ai`（模型 wire protocol/auth/stream）和它的 `pi-telemetry` 依赖；`pi-mcp`、`pi-codemode` 作为可选工具适配器保留。`coding-agent`、`agent`、`tui`、`env`、`durable`、`chord`、`protocol`、`client`、`server` 全部退出工作台运行时。目标不保留 CLI 版本：`coding-agent`/`agent`/`tui` 只作为迁移期的 `PiEngine`/bridge 依赖，M6 完成后整体删除；远程工作区不在目标范围。
7. **轻量和效率是硬约束，不是风格偏好。** 保留 Pi 的进程内、按需加载、流式转发、稳定前缀缓存和少依赖特征；不引入 DI/ORM/消息总线/工作流引擎。内核只允许 `protocol` 一个 workspace 运行时依赖；性能预算见 7.2，任何一项不达标都不得把 `NativeEngine` 设为默认。
8. **迁移顺序必须是“先存储/协议，再会话 actor，再 loop，再上下文/扩展，最后拆 Pi”。** 每一步都能独立发布和回退，不做 big-bang 重写；旧 `AgentSession` 通过 `PiEngine` 适配器保留到新 loop 达到功能与金轨迹对等。

### 关键数字

| 指标 | 当前实测 | 说明 |
| --- | --- | --- |
| `coding-agent/src` | 86,158 行 | 工作台只用到其中一部分 |
| `AgentSession` | 4,398 行 | 单文件承担约 18 类职责 |
| `SessionManager` | 2,013 行 | JSONL v3 会话树 |
| `ResourceLoader` | 1,287 行 | 资源扫描与 Pi package 资源 |
| `PackageManager` | 2,760 行 | npm/Git 扩展安装 |
| `ExtensionRunner` + `types` | 1,560 + 2,273 行 | 约 60 个 hook，类型依赖 TUI |
| 100 会话列表加载 | 旧 108–113 ms；迁移后 7.2–7.8 ms | 当前已有明显改善 |
| 100 条 200 字符 delta 写入 | 311–380 ms；WAL 4.9–8.3 MB | 全量快照模式最差 |
| 100 会话内存 | RSS 154–256 MB | 旧 meta 模式峰值更高 |
| SQLite / JSONL 体积 | 17.25 MB / 21.98 MB | 同一份 100×100 消息数据 |

这些数字来自仓库内 `apps/server/scripts/benchmark-*.mjs` 的本机实测；重构验收沿用同一套场景，避免“感觉更快”。

---

## 1. 产品与仓库边界

### 1.1 部署形态

```text
Windows 桌面
  Electron main (desktop/src/main.ts, 83 行)
    └─ spawn Node 服务进程（apps/server/src/main.ts）
         ├─ Fastify HTTP / WebSocket
         ├─ 静态托管 apps/web/dist
         └─ 进程内 Pi SDK

浏览器开发模式
  Vite dev server (5173)
    └─ /api、/ws 代理到 Node 服务 (8787)

CLI（当前存在；目标删除，不保留 CLI 版本）
  packages/coding-agent
    ├─ interactive (TUI)
    ├─ print / json
    └─ rpc
```

工作台是**本机单用户**：服务默认监听 `127.0.0.1`，校验 Host、Origin、同源请求；没有多用户、云同步、远程登录层。桌面版用一次性关闭令牌关闭服务；浏览器不接触供应商密钥，模型请求由服务端发出。

### 1.2 包与职责

| 位置 | 当前职责 | 运行时是否在工作台链路 |
| --- | --- | --- |
| `apps/web` | React 19、Vite、MUI、Monaco、React Query；通过 `/api` + `/ws` 操作会话 | 是 |
| `apps/server` | Fastify 路由、WebSocket、工作区/文件/Git、浏览器、供应商、扩展包、SQLite 投影、审批 | 是 |
| `apps/shared/src/protocol.ts` | 前后端共享 DTO、事件类型、`applyEvent` reducer | 是（相对路径导入） |
| `desktop` | Electron 主进程、启动/关闭服务、安装包脚本 | 是 |
| `packages/coding-agent` | `AgentSession`、会话 JSONL、设置、资源、包管理、扩展、工具、压缩、CLI modes | 是（SDK 方式） |
| `packages/agent` | `Agent` 类与 `agentLoop` / `agentLoopContinue`；工具执行、重试、steering/follow-up | 是（被 coding-agent 使用） |
| `packages/ai` | 模型类型、provider 适配、auth、stream、模型目录、usage/cost | 是 |
| `packages/tui` | 终端渲染、编辑器、主题、键位 | 仅 CLI；目标删除 |
| `packages/mcp` | MCP 协议客户端/服务端管理 | 是（被 coding-agent 的 MCP 扩展使用） |
| `packages/codemode` | QuickJS-WASI 代码模式执行 | 是（被 coding-agent 的 codemode 扩展使用） |
| `packages/env` | 远程 SSH 执行环境 | 当前仅远程工作区；目标删除 |
| `packages/durable` | 实验性持久化 agent harness（SQLite/JSONL、resume、task graph） | 否（但被 `env` 依赖） |
| `packages/chord` | 应用组合 runtime（facet/service/context） | 否（但被 `env` 和 server 直接 import） |
| `packages/protocol` / `client` / `server` | CBOR RPC 协议、客户端、服务端 | 否（工作台不用） |
| `packages/evals` | 评测工具 | 否（手动运行） |
| `packages/telemetry` | 遥测 | 是（`pi-ai` 依赖） |

### 1.3 实际依赖图

```text
apps/web ──相对导入──> apps/shared/src/protocol.ts
    │
    └─ HTTP/WS ─> apps/server
                    ├─ @earendil-works/pi-coding-agent
                    │    ├─ @earendil-works/pi-agent-core
                    │    ├─ @earendil-works/pi-ai
                    │    │    └─ @earendil-works/pi-telemetry
                    │    ├─ @earendil-works/pi-tui
                    │    ├─ @earendil-works/pi-mcp
                    │    └─ @earendil-works/pi-codemode
                    ├─ @earendil-works/pi-env
                    │    ├─ @earendil-works/chord
                    │    └─ @earendil-works/pi-durable
                    └─ @earendil-works/pi-ai（少量类型）

desktop ──spawn──> apps/server
```

注意两个**未声明依赖**：

- `apps/server/src/workspaces/workspace-access.ts:4` 直接 import `@earendil-works/chord/context`，`command-operations.ts:1` 和 `remote-workspaces.ts:14` 也 import chord，但 `apps/server/package.json` 没有 `@earendil-works/chord`。
- `apps/server/src/workspaces/workspace-access.ts:5` 从 `pi-coding-agent` 取 `withFileMutationQueue`，把一个通用的文件锁实现绑在 Pi SDK 上。

`npm run check:runtime-deps` 只检查公开包，不检查 `apps/*`，所以这两处不会在 CI 里报错。

### 1.4 四条运行路径

| 路径 | 入口 | 内核 | 说明 |
| --- | --- | --- | --- |
| 工作台会话 | `apps/server` `AgentService` | `AgentSession` | 主产品路径 |
| 工作台控制面 | 路由 + `WorkspaceService` / `ProviderManager` / `PiPackageManager` | 部分 Pi 配置 API | 文件、Git、模型配置、扩展安装 |
| CLI | `packages/coding-agent` `main.ts` | `AgentSession` + TUI | interactive/print/json/rpc |
| 实验 durable | `packages/durable` `Harness` | `DurableHarness` | 不在工作台主链路；被 `pi-env` 间接带入 |

“三套 runtime”不是设计选择，而是历史叠加。新架构只保留一套内核，工作台是唯一产品形态；不保留 CLI，移除远程工作区。durable 作为实验归档或删除，不进入产品依赖。

---

## 2. 当前架构

### 2.1 启动与组合根

`apps/server/src/bootstrap/create-app.ts:41` 是服务端组合根：

1. `ConsoleStore(directory)` 打开 `console.sqlite`（`store.ts:17`，`node:sqlite` + WAL）。
2. `RemoteWorkspaceService`、`WorkspaceService`、`ProviderManager`、`BrowserService`、`AppPluginManager`。
3. `AgentService`（`agent.ts:37`）接收 `createSession: options.createSession ?? createAgentSession`；测试可替换 session factory。
4. `PiPackageManager`、`StorageManager`。
5. Fastify 注册 `@fastify/websocket`、安全 hook、错误处理、`/api/health`、`/api/settings`、各路由模块。
6. 关闭时依次关闭 agents、packages、providers、store、remote workspaces。

`/api/health` 和 `/api/settings` 里的 `kernel.version` 直接用了 `pi-coding-agent` 的 `VERSION`。这会把“Pi 版本”误报成“内核版本”；目标架构必须换成新内核版本，并在迁移期同时返回 `piVersion` 供诊断。

### 2.2 工作台会话链路

```text
Web POST /api/sessions/:id/prompt
  └─ AgentService.prompt
       └─ SessionCoordinator.prompt            (coordinator.ts:319)
            ├─ 检查 busy/closing/archived/failed
            ├─ 校验文件引用（WorkspaceTools.check）
            ├─ 记录 Git 快照（非远程）
            ├─ 拼接计划模式提示 + 文件引用
            ├─ 标记 running，创建 run promise
            ├─ runtime.prompt(text)
            │    └─ PiAgentRuntime → AgentSession.prompt  (agent-session.ts:1968)
            │         ├─ 扩展命令 / input hook / 模板展开 / steer/followUp
            │         ├─ 模型与 auth 校验
            │         ├─ 预压缩检查
            │         ├─ before_agent_start
            │         └─ Agent loop → Models.streamSimple
            ├─ 结束后计算 Git changed files、usage、compaction 数、工具结果统计
            └─ 标记 idle，刷新插件相关 agent
```

`SessionCoordinator` 是 660 行的 server 级编排器：运行队列、取消、审批、分支/回退、模型切换、访问模式、插件开发会话、Git 快照、usage 汇总都在这里。它和 `AgentSession` 的职责有重叠，却没有共享状态机。

`PiAgentRuntime`（`pi-runtime.adapter.ts:126`）把 `AgentSession` 包成 `AgentRuntime` 接口；`AgentRuntimeFactory`（`:257`）负责列出模型、默认模型、打开 runtime。适配层本身不厚，但它把 `AgentSessionEvent` 转成 `AdaptedEvent`，再由 `EventProjector` 写 SQLite。

### 2.3 事件与持久化

工作台有**两份会话历史**：

1. **Pi JSONL**：`SessionManager` 以 append-only 树写入 `.pi-console/sessions/*.jsonl`，版本 3；每条 entry 有 `id`/`parentId`，支持分支、compaction、branch summary、custom entry、context edit。
2. **SQLite 投影**：`ConsoleStore` 保存 `sessions`、`session_summaries`（快照）、`events`（gzip 事件）。`EventProjector` 把 `SessionDetail` 快照和事件一起写，启动时只读 meta，按需 hydrate。

事件流：

```text
AgentSessionEvent
  └─ adaptSdkEvent  (pi-events.ts:46)
       └─ EventProjector.project
            ├─ 追加 events 行（gzip）
            ├─ 更新 sessions meta
            └─ 条件写 session_summaries 全量快照
                 └─ EventHub.publish → WebSocket → web applyEvent
```

`EventProjector` 的 hydrate 有四种模式：SQLite 检查点 + 事件重放、旧 v1 快照升级、JSONL transcript 权威合并、快照回退。检查点缺失时会抛 409 “会话流式检查点缺失”。这套逻辑是为了兼容历史数据，但也让“哪份历史是真相”变得不清楚。

`ConsoleStore` 的 `events` 表用全局自增 `id`，不是每会话 `seq`；快照写入 gzip level 1。当前 `EventProjector.project` 在 `message.delta`/`tool.updated` 且距上次检查点少于 100 条时走增量，否则写全量快照。基准显示全量快照模式下 100 条 delta 产生 8.27 MB WAL、耗时 380 ms。

### 2.4 工具、权限与工作区

- `apps/server/src/sessions/tool-factory.ts` 用 `createReadToolDefinition` / `createEditToolDefinition` / `createWriteToolDefinition` / `createBashToolDefinition` 构造 `customTools`，底层走 `WorkspaceTools`。远程工具会把路径改写成项目相对路径，并用 `withFileMutationQueue` 串行化写操作。
- `createWorkbenchTools` 注册 `pi.on("tool_call")`：先 `tools.check` 做路径授权，再 `toolPermission(accessMode, name, readOnlyTools)` 得到 allow/ask/deny。deny 直接返回中文原因；ask 调 `requestApproval`；拒绝时 `{ block: true, reason, terminate: true }`。
- `ToolAuthorization`（`tool-authorization.ts:26`）把待审批项放在 `Map<string, PendingApproval>`，默认 5 分钟超时。审批只存在内存；服务重启后 `EventProjector` 会把非 idle 状态改成 idle，未决审批丢失。
- `WorkspaceFiles` / `WorkspaceTools` 在 `workspace-access.ts`；本地路径用 `security.ts` 的 `workspacePath` 做 realpath、符号链接/junction 拒绝、私有路径拒绝（`.git`、`.pi`、`.env`、`.pi-console`、`node_modules`），文本编辑上限 1 MB，预览上限 256 KB。远程走 `RemoteWorkspaceService` + `pi-env`。
- `AppPluginManager` 是声明式插件（Zod 严格 schema：text/number/date/boolean/select、table/board 视图、导航），不执行用户代码；插件安装/校验作为工具暴露给会话。

### 2.5 上下文、模型与压缩

- `AgentSession` 维护工具注册表、系统提示、资源加载器、扩展 runner、模型运行时、设置、会话管理器。
- `_installAgentRequestProjection`（约 `agent-session.ts:787`）在**每次请求**前重建 `sessionManager.buildSessionProjection()`，合并 canonical messages/tools、解析虚拟模型、检查自动压缩，再返回新的 context/model/thinking。
- `_installAgentNextTurnRefresh`（约 `:900`）在下一轮助手响应前压缩、重建 system prompt options，并注入 prompt/tool-loadout 更新消息。
- `SystemPrompt`（`core/system-prompt.ts`，229 行）拼身份、环境、工具、项目指令、Skills、模式、日期等。
- `ResourceLoader`（1,287 行）扫描 `AGENTS.md`、`.pi/skills`、prompt templates、Pi packages；`SettingsManager`（1,428 行）管理 `settings.json`；`ModelRuntime`（1,034 行）管理 provider/auth/models。
- 压缩在 `core/compaction/compaction.ts`（1,119 行）：默认 `reserveTokens: 16384`、`keepRecentTokens: 20000`；`shouldCompact = contextTokens > contextWindow - reserveTokens`；`estimateTokens` 全部用 `Math.ceil(chars / 4)`，对中文严重低估；`generateSummary` 的请求显式设置 `cacheRetention: "none"`（`:631`）。

### 2.6 扩展与插件

`ExtensionRunner` + `ExtensionAPI` 是当前最重的耦合面：

- 约 60 个 hook：`session_start`、`context`、`before_provider_request`、`tool_call`、`tool_result`、`turn_end`、`agent_end`、`ui_prompt_start`、`footer` 等。
- `registerTool`、`registerCommand`、`registerShortcut`、`getTools/setTools`、`executeTool`、session new/switch/fork、UI 原语。
- `packages/coding-agent/src/core/extensions/types.ts` 直接 import `pi-tui` 的 `Component`、`TUI`、`EditorComponent`、`OverlayHandle`、`KeyId`、`Theme`。这意味着 coding-agent 的“核心”类型依赖终端 UI，不能在没有 TUI 的情况下干净复用。
- 工作台的 doompi/Cordis 支持在 `apps/server/src/legacy/doompi-host.ts`（M0 前名为 `src/kernel.ts`）：读取 `settings.json` 的 packages/extensions，找到 `@agimon-ai/doompi-core` 的 `dist/cordisHost.mjs`，写一个 `pi-console-cordis-host.mjs` 安装器。它和“内核”没有关系，应该归到 app plugin/legacy host。

### 2.7 CLI、桌面与实验路径

- CLI：`packages/coding-agent/src/main.ts`（999 行）解析参数，`modes/interactive`（TUI）、`modes/print`、`modes/rpc`。`sdk.ts`（487 行）给外部嵌入方提供 `createAgentSession` / `AgentSession` / services。
- 桌面：`desktop/src/main.ts` 只有 83 行，负责找空闲端口、spawn 服务、传 `PI_CONSOLE_DESKTOP`/`PI_CONSOLE_SHUTDOWN_TOKEN`、等健康检查、打开窗口；没有内核逻辑。
- 实验：`packages/durable` 22,063 行，自建 Harness、Transaction、SQLite/JSONL storage、resume/fork/task graph；`packages/chord` 8,817 行，自建 facet/service/context/replicated state。两者都没有进入工作台会话主链路，但 `pi-env` 依赖它们，`apps/server` 又直接用 chord context 做后台任务隔离。
- 死路径：`packages/protocol`（869 行 CBOR RPC）、`packages/client`（1,135 行）、`packages/server`（1,958 行）只有自测和 `scripts/browser-smoke-entry.ts` 使用；工作台完全不 import。

---

## 3. 代码解剖与耦合

### 3.1 `AgentSession` 的职责边界

`AgentSession` 的公开方法覆盖了几乎所有产品能力：

- 会话：`prompt`、`steer`、`followUp`、`sendUserMessage`、`abort`、`waitForIdle`、`dispose`。
- 模型：`setModel`、`cycleModel`、`setThinkingLevel`、`cycleThinkingLevel`、`getAvailableThinkingLevels`、`supportsThinking`。
- 工具：`getActiveToolNames`、`getCallableToolNames`、`getAllTools`、`getToolDefinition`、`setActiveToolsByName`、`executeBash`、`recordBashResult`、`abortBash`。
- 上下文：`refreshContext`、`compact`、`abortCompaction`、`setAutoCompactionEnabled`、`getContextUsage`。
- 扩展：`bindExtensions`、`reload`、`hasExtensionHandlers`。
- 持久化/分支：`setSessionName`、`navigateTree`、`getUserMessagesForForking`、`createReplacedSessionContext`。
- 导出/诊断：`getSessionStats`、`exportToHtml`、`exportToJsonl`、`summarizeForBugReport`、`getLastAssistantText`。

内部状态包括 agent 订阅、事件监听器、steering/followUp 队列、pending messages、compaction/retry/branch abort controller、失败响应、bash controller、extension runner、entry id 映射、工具注册表、隐藏声明、system prompt options。构造函数里安装了至少 6 组钩子（工具、下一轮刷新、请求投影、边界、隐藏声明、强制 prompt 投影），并在没有初始工具名时从 transcript 恢复工具。

这不是说这些功能都该扔掉；而是说它们应该被拆成**内核模块**，由明确的状态机驱动，而不是继续堆在一个 4,398 行类里。

### 3.2 `SessionManager` 与双重真相

`SessionManager` 是 JSONL v3 会话树：

- 文件头 `{type:"session", version:3, id, timestamp, cwd, parentSession?}`。
- entry 类型：`message`、`thinking_level_change`、`model_change`、`usage`、`compaction`、`branch_summary`、`custom`、`label`、`session_info`、`custom_message`、`context_edit`。
- `buildSessionPath` 从 leaf 沿 `parentId` 回溯；`buildSessionProjection` 返回 messages/thinking/model；`buildSessionContext` 生成 LLM context。
- 写入是 `appendFileSync`；分支通过移动 leaf 实现。

工作台同时写 JSONL 和 SQLite，导致：

- 启动时要么读 SQLite 快照 + 事件，要么读 JSONL transcript，要么升级旧快照，要么回退；四条路径都要维护。
- 事件投影和 JSONL 可能不同步；检查点缺失会 409。
- 同一份消息有两个序列化格式、两套迁移、两套测试。
- 删除/归档/分支要同时考虑两边。

### 3.3 服务端是“半内核”

`AgentService` 本身很薄，但 `SessionCoordinator` 承担了：

- `busy`/`cancelled`/`runs` 运行状态；
- prompt 输入、文件引用、计划模式提示；
- Git 快照和 changed files；
- usage/compaction/tool result 汇总；
- 审批 `ToolAuthorization`；
- 分支/回退 `navigateToMessage`；
- 插件变更后的 runtime 刷新；
- 模型切换、访问模式、资源列表。

这些和 `AgentSession` 的会话状态机有大量隐含契约（例如“运行中才能审批”“取消后不能再审批”“插件刷新只能在 idle 时做”）。契约没有集中定义，只靠 coordinator 的 if 和注释维持。

`EventProjector` 又是另一个状态机：它决定事件是否应用、是否写快照、是否增量、失败如何恢复。它和 `AgentSession` 的事件语义、`applyEvent` 的 reducer、web 的渲染逻辑一起构成四层事件理解。

### 3.4 扩展与 TUI 的耦合

`core/extensions/types.ts` 把 TUI 类型放进核心 API，导致：

- 任何新的 headless 内核都要么依赖 `pi-tui`，要么维护一套“类型上兼容但运行时不渲染”的桥。
- 扩展作者可以拿到 `TUI`、`Theme`、`Component`，这些对象在 web 工作台没有意义。
- 工作台只能用 `pi.on(...)` 的一小部分 hook；大部分 UI hook 永远不触发。
- 未来如果换前端（web/桌面），扩展 API 会被 UI 形态绑死。

### 3.5 规模表

| 包/应用 | `src` 行数 |
| --- | ---: |
| `packages/coding-agent` | 86,158 |
| `packages/ai` | 27,246 |
| `packages/durable` | 22,063 |
| `packages/tui` | 19,506 |
| `packages/chord` | 8,817 |
| `packages/mcp` | 3,243 |
| `packages/env` | 2,522 |
| `packages/agent` | 2,519 |
| `packages/server` | 1,958 |
| `packages/codemode` | 1,837 |
| `packages/evals` | 1,446 |
| `packages/client` | 1,135 |
| `packages/telemetry` | 935 |
| `packages/protocol` | 869 |
| `apps/server` | 11,986 |
| `apps/web` | 11,888 |
| `apps/shared` | 439 |
| `desktop/src` | 83 |

单文件热点：

| 文件 | 行数 |
| --- | ---: |
| `packages/coding-agent/src/core/agent-session.ts` | 4,398 |
| `packages/coding-agent/src/core/package-manager.ts` | 2,760 |
| `packages/coding-agent/src/core/extensions/types.ts` | 2,273 |
| `packages/coding-agent/src/core/session-manager.ts` | 2,013 |
| `packages/coding-agent/src/core/extensions/runner.ts` | 1,560 |
| `packages/coding-agent/src/core/settings-manager.ts` | 1,428 |
| `packages/coding-agent/src/core/resource-loader.ts` | 1,287 |
| `packages/coding-agent/src/core/compaction/compaction.ts` | 1,119 |
| `packages/coding-agent/src/core/model-runtime.ts` | 1,034 |
| `packages/agent/src/agent-loop.ts` | 949 |
| `apps/server/src/sessions/coordinator.ts` | 660 |
| `apps/server/src/sessions/pi-runtime.adapter.ts` | 413 |
| `apps/server/src/sessions/event-projector.ts` | 357 |
| `apps/shared/src/protocol.ts` | 321 |
| `apps/server/src/store.ts` | 234 |

### 3.6 导入耦合

`apps/server/src` 有 12 个文件、13 条语句从 `@earendil-works/pi-coding-agent` 导入约 30 个符号：

- 会话：`createAgentSession`、`AgentSession`、`AgentSessionEvent`、`SessionManager`、`SettingsManager`、`ModelRuntime`、`DefaultResourceLoader`、`DefaultPackageManager`。
- 工具：`defineTool`、`withFileMutationQueue`、`detectSupportedImageMimeTypeFromFile`、`createReadToolDefinition`、`createEditToolDefinition`、`createWriteToolDefinition`、`createBashToolDefinition`、`createLocalBashOperations`、`BashOperations`、`ToolDefinition`。
- 扩展：`createCodemodeExtension`、`createMcpExtension`、`createToolSearchExtension`、`InlineExtension`。
- 版本/模型：`VERSION`、`CURRENT_SESSION_VERSION`、`defaultModelPerProvider`、`getAgentDir`。

只有 3 个文件 import `pi-ai`（`Type`、`AuthEvent/AuthPrompt/AuthType`、`isModelType`）。这说明**模型层可以直接保留，会话/工具体系是主要替换对象**。

注意深路径：`apps/server/src/providers.ts` 用 `isModelType` 从 pi-ai 的模型工具模块导入；升级 pi-ai 时可能静默编译失败。新网关应把这类类型判断收进 adapter。

---

## 4. 问题清单

### P0：必须在内核替换前解决

**P0-1 内核职责散落在四个包/层**

- 证据：`AgentSession` 4,398 行；`SessionCoordinator` 660 行；`EventProjector` 357 行；`applyEvent` 在 `apps/shared`；`ToolAuthorization` 在 server。
- 后果：改一个会话行为要同时改 coding-agent、server、shared、web；没有单一状态机；无法独立测试。
- 方向：新 `KernelSession` 拥有状态机和事件；server 只做传输/授权；web 只做 reducer/渲染。

**P0-2 双重持久化导致一致性复杂**

- 证据：JSONL v3 + SQLite snapshot/events；`EventProjector.hydrate` 四种模式；检查点缺失 409；`SessionManager` 和 `ConsoleStore` 都写消息。
- 后果：迁移、恢复、分支、删除都要维护两套；故障时不知道哪份是真相。
- 方向：事件日志唯一真相；JSONL 只做导入/导出；快照是缓存。

**P0-3 隐藏的 chord/durable 依赖**

- 证据：`workspace-access.ts:4`、`command-operations.ts:1`、`remote-workspaces.ts:14` import chord；`packages/env/package.json` 依赖 chord + pi-durable；`apps/server/package.json` 未声明 chord。
- 后果：`npm ci` 的 hoist 策略变化可能直接失败；实验 runtime 进入产品依赖；安全/性能边界不清。
- 方向：删除 chord/durable；移除远程工作区与 `pi-env`；CI 增加 app 级依赖检查。

**P0-4 审批不持久，重启即丢**

- 证据：`ToolAuthorization` 的 `approvals` 是内存 `Map`；`EventProjector` 启动时把非 idle 改成 idle。
- 后果：崩溃/重启后用户看不到未决审批，工具调用状态不明；无法审计。
- 方向：审批表 + 事件；重启把 pending 标为 expired；绝不自动批准。

**P0-5 扩展类型依赖 TUI**

- 证据：`core/extensions/types.ts` import `pi-tui` 的 `Component`、`TUI`、`EditorComponent`、`OverlayHandle`、`KeyId`、`Theme`。
- 后果：headless 内核无法干净复用；web 工作台永远只能支持子集；换 UI 成本高。
- 方向：内核扩展 API 不出现 UI 类型；CLI/web 各自实现 `UiPort`；旧扩展通过 bridge。

### P1：性能与可维护性

**P1-1 事件写入放大**

- 证据：每个 delta 都进 SQLite；全量快照模式 100 条 delta 写 8.27 MB WAL、380 ms；检查点模式仍有 4.94 MB、311 ms。
- 后果：长回复时磁盘和 CPU 抖动；SSD 寿命；UI 卡顿。
- 方向：每会话 `seq`、批量写、只在完成/检查点写快照；delta 合并到 16 ms 窗口。

**P1-2 中文 token 估算错误**

- 证据：`compaction.ts:311` 起所有分支 `Math.ceil(chars / 4)`；中文约 1 token/字，实际被低估 3–4 倍。
- 后果：压缩触发太晚，provider 直接 context overflow；中文长会话失败。
- 方向：Unicode 感知估算 + 按模型/脚本校准；用 provider usage 做 EMA 修正。

**P1-3 压缩摘要禁用 cache**

- 证据：`compaction.ts:631` `cacheRetention: "none"`。
- 后果：每次压缩都重新计费/延迟；长会话成本高。
- 方向：摘要请求独立计费可以接受，但不要影响主对话前缀缓存；主链路保持稳定前缀，测量 cache read。

**P1-4 事件协议/投影重复理解**

- 证据：`AgentSessionEvent` 约 27 种；`pi-events.ts` 映射；`AdaptedEvent`；`SessionEvent`；`applyEvent`。
- 后果：新增事件要改四层；UI 和 server 的字段语义容易漂移。
- 方向：一个 `KernelEvent` 联合类型 + 一个 reducer；adapter 只做 provider/engine 到内核事件的转换。

**P1-5 `VERSION` 误导**

- 证据：`/api/health`、`/api/settings` 的 `kernel.version` 用 `pi-coding-agent` 的 `VERSION`。
- 后果：诊断、兼容性判断、发布说明都错。
- 方向：`kernelVersion` + `piVersion` 分开；迁移期两者都返回。

**P1-6 死包与实验包占据认知/构建成本**

- 证据：`protocol`/`client`/`server` 仅自测和 browser smoke 使用；`durable` 22k 行不在工作台；`chord` 8.8k 行只被 env/server 局部使用；`evals` 手动使用。
- 后果：根 `build` 要构建全部包；新人无法判断哪条是产品路径；依赖审计噪声大。
- 方向：归档/删除死路径；删除 `env`/远程工作区；`durable`/`chord` 移到 `experimental/` 或删除。

**P1-7 无操作系统级沙箱**

- 证据：`/api/settings` 明确写 “No sandbox”；工具确认只是审批。
- 后果：获准命令以当前用户权限运行；提示注入/恶意扩展可造成真实损害。
- 方向：把 sandbox 作为独立 `SandboxBackend`，M1–M6 不阻塞；至少明确风险并支持关闭网络/限制目录的可选模式。

### P2：结构/命名

- doompi host 曾名 `apps/server/src/kernel.ts`，实际是 doompi host；M0 已改名为 `legacy/doompi-host.ts`。
- `apps/shared` 没有 `package.json`，web 用 `../../../../shared/src/protocol.ts` 相对导入；应变成包。
- `apps/server` 的 `adapter.ts` 只有 13 行类型，和 `pi-runtime.adapter.ts` 命名冲突。
- `packages/coding-agent/src/core` 同时是 SDK、CLI 核心、扩展宿主、包管理器，边界不清。
- 文档曾把 `apps/server/src/kernel` 当成 seam，导致计划建立在错误前提上；新文档必须只写可验证事实。

---

## 5. 目标架构

### 5.1 原则

1. **一个会话一个状态机。** 运行、审批、压缩、分支、取消都由 `KernelSession` 串行化；server 不再维护第二套 run 状态。
2. **事件日志是唯一真相。** 消息、工具、审批、压缩、usage 都先成为事件；快照只是 reducer 的物化缓存。
3. **内核是库，不是服务。** 进程内调用；没有内核 RPC、没有内核 HTTP、没有内核进程。server 负责传输和授权。
4. **端口只放在真实边界。** 模型、存储、工作区、时钟/ID、遥测。内核内部直接调用具体实现，不做“每个函数一个接口”的 DI 框架。
5. **协议与实现分离。** `protocol` 包只有纯类型 + reducer，不 import Node；web 只依赖它。
6. **不为抽象而抽象。** 3 个新包（protocol/kernel/adapters），不是一个 12 包的微内核；不为未来可能的多租户/云服务预建层。
7. **兼容是适配层，不是泄漏。** 旧 Pi 扩展、旧 JSONL、旧 settings 通过 adapter/bridge 处理；内核类型不出现 `AgentSession`、`pi-tui`、`Fastify`。
8. **先测量再替换。** 每个阶段有金轨迹、故障注入和性能预算；不靠“代码看起来更干净”验收。
9. **失败关闭。** 路径、审批、密钥默认拒绝；崩溃后不自动重放非幂等工具。
10. **删除死路径。** 产品依赖图里只保留被产品使用的包；实验代码放 `experimental/` 或删除。

### 5.1.1 轻量化硬约束

Pi 的优势不是“功能多”，而是单进程、启动快、依赖少、工具循环直接。新内核必须保住这些特征，不能为了“架构正确”把它们换掉。

**结构约束**

- 单 Node 进程、进程内库调用；没有 sidecar、没有内核 daemon、没有内核 RPC/HTTP。
- `packages/kernel` 的运行时依赖只有 `packages/protocol`；不新增第三方运行时依赖。`kernel-adapters` 只允许 `pi-ai`、`typebox`（已有）和 Node 内置模块；新依赖必须记录包体积、冷启动影响和替代方案。
- 不用 DI 容器、ORM、查询构建器、通用事件总线、actor 框架、工作流引擎、BullMQ/Redis。`node:sqlite` 直接写 SQL；会话内直接函数调用。
- 3 个新包是上限；不按“每模块一包”拆分。新增包必须有独立发布/依赖隔离理由。
- 新增内核代码（不含测试）控制在 15k 行以内；超过时先删抽象，而不是继续分层。

**热路径约束**

- 流式 delta 不整段缓冲、不深拷贝会话、不为每个 token 建对象；每个事件只序列化一次。
- 模型请求使用稳定前缀（system + 工具声明 + 历史在尾部追加），正常对话保留 provider prompt cache；压缩调用才降级缓存。
- 会话事件按 16 ms 或 64 条批量落盘；不要每个 delta 写一次事务。
- 工具输出在进入 transcript 前截断；不为“完整审计”把 10 MB 日志塞进上下文。
- 资源、provider、MCP、codemode、扩展按需加载；启动只读会话 meta，不扫工作区、不建全量索引。
- 默认串行执行每会话一个 run；并行只用于只读工具，且不引入全局锁。

**默认值约束**

- system prompt 保持短；工具按会话需要装配，不默认暴露全部工具。
- 不做“每轮重算全部上下文”；只重算变化段，稳定段复用。
- 不在内核里做遥测网络请求、自动更新、包安装或索引重建。
- 任何新抽象如果让热路径 p95 增加超过 1 ms，默认拒绝。

### 5.2 包结构

```text
packages/
  protocol/                 # @pi-console/protocol
    src/
      events.ts             # KernelEvent 联合类型 + 版本
      snapshot.ts           # SessionSnapshot / ChatMessage / ToolCall / Approval
      reducer.ts            # applyEvent(snapshot, event) 纯函数
      wire.ts               # HTTP/WS DTO、错误码

  kernel/                   # @pi-console/kernel
    src/
      contract.ts           # KernelSession / Engine / ports 的公开类型
      session.ts            # actor、状态机、run 队列、订阅
      loop/
        run-turn.ts         # 模型流 → 消息/工具 → 下一轮
        retry.ts            # 限流/错误/overflow 重试
        usage.ts            # token/cost 汇总
      context/
        builder.ts          # system + transcript + 工具声明
        budget.ts           # token 估算/校准/裁剪
        compaction.ts       # 摘要、保留最近、文件操作
        resources.ts        # AGENTS/skills/prompts 索引
      tools/
        registry.ts
        execute.ts          # 策略 → 审批 → 执行 → 截断 → 事件
        builtin/            # read/write/edit/bash/grep/find/ls
      policy.ts             # plan/ask/auto/full + 路径/只读规则
      store/
        types.ts            # EventStore 端口
        sqlite.ts           # 唯一 node:sqlite 使用点
        schema.ts           # 迁移
        batch.ts            # delta 合并/检查点
      gateway/
        types.ts            # ModelGateway 端口
      extensions/
        hooks.ts            # 10 个稳定 hook
        registry.ts
        bridge.ts           # 旧 Pi 扩展适配
      config.ts             # KernelConfig / settings schema
      errors.ts
      telemetry.ts
      index.ts              # 只导出 contract + createKernel

  kernel-adapters/          # @pi-console/kernel-adapters
    src/
      pi-ai-gateway.ts      # 唯一 import pi-ai 的地方
      local-workspace.ts
      mcp-tools.ts          # 包装 pi-mcp
      codemode-tools.ts     # 包装 pi-codemode
      browser-tools.ts      # Playwright
      pi-transcript-import.ts
      pi-extension-bridge.ts

apps/
  server/                   # Fastify、路由、安全、组装；只依赖 kernel/adapters/protocol
  web/                      # React；只依赖 protocol
  shared/                   # 过渡期保留；最终删除，内容并入 protocol
desktop/                    # Electron；不变
```

> 目录冲突已解决：旧 `@earendil-works/pi-protocol`（CBOR RPC）在 M1 移到 `packages/pi-protocol`，保留旧包名以少改 import；`packages/protocol` 现为目标 `@pi-console/protocol`。旧包在 M6 删除。

目标不包含 `apps/cli`、`remote-workspace.ts` 或 `legacy/` CLI。`apps/server/src/legacy/doompi-host.ts` 只保留 doompi 的 app 级 host，不是 CLI。

命名是工作名，可以换成产品 scope；关键是依赖方向：

```text
web ──> protocol
server ──> kernel + kernel-adapters + protocol
kernel ──> protocol + typebox
kernel-adapters ──> kernel + pi-ai + pi-mcp + pi-codemode + playwright-core
protocol ──> 无 Node、无运行时依赖
```

`kernel` 不 import：`pi-coding-agent`、`pi-agent-core`、`pi-tui`、`pi-env`、`chord`、`pi-durable`、`fastify`、`playwright-core`、`react`。`node:sqlite` 只允许在 `store/sqlite.ts`；`node:child_process` 只允许在 `tools/builtin/bash.ts` 和 `adapters/local-workspace.ts`。

### 5.3 核心接口

```ts
// @pi-console/protocol
export type AccessMode = "plan" | "ask" | "auto" | "full";
export type SessionStatus = "idle" | "running" | "approval" | "error" | "interrupted";

export interface SessionSnapshot {
  id: string;
  seq: number;
  status: SessionStatus;
  workspaceId: string;
  branchId: string;
  messages: ChatMessage[];
  tools: ToolCall[];
  approvals: Approval[];
  usage: Usage;
  model?: ModelRef;
  thinking: ThinkingLevel;
  accessMode: AccessMode;
  error?: string;
}

export function applyEvent(snapshot: SessionSnapshot, event: KernelEvent): SessionSnapshot;
```

```ts
// @pi-console/kernel
export interface KernelSession {
  readonly id: string;
  snapshot(): SessionSnapshot;
  subscribe(listener: (event: KernelEvent) => void): () => void;

  prompt(input: PromptInput): Promise<RunResult>;
  steer(text: string): void;
  followUp(text: string): void;
  abort(): void;
  approve(approvalId: string, allowed: boolean): void;

  compact(reason?: "manual" | "threshold" | "overflow"): Promise<void>;
  setModel(ref: ModelRef | null): Promise<void>;
  setThinking(level: ThinkingLevel): void;
  setAccessMode(mode: AccessMode): void;
  branch(fromSeq: number): Promise<string>;
  close(): Promise<void>;
}

export interface AgentEngine {
  run(input: EngineInput, ctx: EngineContext): AsyncIterable<KernelEventBody>;
}

export interface EngineContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  executeTool(call: ToolCall): Promise<ToolResult>;
}
```

`AgentEngine` 产出**未编号**的领域事件；`KernelSession` 负责分配 `seq`/`branchId`/`at`、持久化、再广播。这样 loop 可以单测，不需要 SQLite。

```ts
// @pi-console/kernel
export interface ModelGateway {
  list(): Promise<ModelInfo[]>;
  resolve(ref: ModelRef): Promise<ResolvedModel>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelRequest {
  model: ResolvedModel;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  thinking: ThinkingLevel;
  sessionId: string;
  cacheKey: string;
  maxTokens?: number;
}

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "toolcall"; index: number; id: string; name: string; argsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; reason: "stop" | "length" | "toolUse" | "error" | "aborted"; error?: string };
```

```ts
// @pi-console/kernel
export interface WorkspaceBackend {
  readonly root: string;
  resolve(path: string, opts?: { allowMissing?: boolean }): Promise<ResolvedPath>;
  read(path: string, opts?: { maxBytes?: number }): Promise<Buffer>;
  write(path: string, data: string | Uint8Array, opts?: { revision?: string }): Promise<void>;
  list(path: string): Promise<FileEntry[]>;
  exec(argv: string[], opts: ExecOptions): Promise<ExecResult>;
  readonly git: GitBackend;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly?: boolean;
  parallelSafe?: boolean;
  timeoutMs?: number;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

### 5.4 事件协议

内部用带信封的事件，wire 上保持现有 UI 友好的扁平结构（`session.snapshot` + `SessionEvent`）。信封的好处是版本、序号、会话、分支、时间只出现一次，reducer 可以做穷尽检查。

```ts
export type KernelEventBody =
  | { type: "run.started"; runId: string; model: ModelRef }
  | { type: "message.started"; messageId: string; role: "assistant" }
  | { type: "message.delta"; messageId: string; channel: "text" | "thinking"; delta: string }
  | { type: "message.completed"; messageId: string; finishReason: FinishReason }
  | { type: "tool.started"; toolCallId: string; name: string; input: unknown }
  | { type: "tool.updated"; toolCallId: string; delta: string }
  | { type: "tool.completed"; toolCallId: string; result: ToolResult }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; approvalId: string; allowed: boolean }
  | { type: "approval.expired"; approvalId: string }
  | { type: "context.compacted"; compaction: CompactionRecord }
  | { type: "run.completed"; runId: string; usage: Usage; finishReason: FinishReason }
  | { type: "run.aborted"; runId: string; reason: string }
  | { type: "run.failed"; runId: string; error: KernelError }
  | { type: "session.updated"; patch: Partial<Pick<SessionSnapshot, "title" | "model" | "thinking" | "accessMode">> };

export interface KernelEvent {
  v: 2;
  seq: number;
  sessionId: string;
  branchId: string;
  at: string;
  body: KernelEventBody;
}
```

规则：

- `seq` 每会话单调递增；reducer 忽略 `seq <= snapshot.seq`。
- `message.delta` 可以高频；store 合并写，wire 可以按 16–50 ms 批量发送。
- `message.completed` 才代表可持久化的完整消息；崩溃时未完成的 assistant 消息标 `complete:false`。
- `tool.completed` 是工具结果的唯一真相；`tool.updated` 只是流式输出。
- `approval.requested` 必须先持久化再广播；`approval.resolved`/`expired` 必须落库。
- `session.updated` 只放 UI 元数据；模型/thinking/accessMode 的变化也应有对应事件，避免 UI 猜。
- 协议版本 `v` 与事件类型解耦；新增字段向后兼容，删除/改语义升 `v`。

Wire：

```ts
type ServerFrame =
  | { type: "session.snapshot"; session: SessionDetail }
  | { type: "session.event"; event: KernelEvent };

// 连接：GET /ws/sessions/:id?after=<seq>
// after 在保留窗口内 → 先补发 seq 之后的事件，再实时订阅
// after 太旧/缺失 → 直接发 snapshot
```

当前 `session-stream.ts` 已经是“先同步订阅，再发 snapshot”，没有事件空白；目标保留这个性质，并增加 `after` 补发。背压仍用 4 MB 上限 + 1013 关闭，客户端重连拿最新快照。

### 5.5 状态机与并发

```text
idle ──prompt──> running ──done──> idle
                   │  ▲
                   │  └──approve── approval
                   ├──abort──> idle
                   ├──error──> error ──retry──> running
                   └──crash──> interrupted ──resume──> idle

idle ──compact──> compacting ──> idle
```

规则：

- 每会话同时只有一个 active run；`prompt` 在 running 时进入 steering 队列，不启动第二个 run。
- `steer` 在当前工具批次后注入；`followUp` 在当前 run 结束后的下一轮注入。两者都可通过设置改成 `all` / `one-at-a-time`。
- 审批阻塞**该工具调用**，不阻塞其他已批准的并行只读工具；默认工具执行是 sequential，只有 `parallelSafe` 才并行，最多 4 个。
- 取消：abort 模型流 + 所有运行中工具；发 `run.aborted`；保留已产生消息，标 `complete:false`。
- 工具写操作按 `mutationKey` 串行；同工作区的 shell 命令默认串行，避免互相踩文件。
- 崩溃恢复：读最新快照 + 之后的事件；未闭合 run 追加 `run.failed`（`code:"interrupted"`）；`running` 工具标 `unknown`；pending 审批标 `expired`；绝不自动重放非幂等工具。
- 分支：`branch(fromSeq)` 创建新 `branchId`，复制父分支到 `fromSeq` 的上下文；事件仍按会话 `seq` 全局递增；`activeBranchId` 是会话字段。旧 JSONL 树导入时，每个 leaf 路径映射为一个 branch；无法映射的历史只保留导出文件。

### 5.6 存储

只用 SQLite（`node:sqlite`），WAL，`synchronous=NORMAL`；不引入 Redis/Postgres/向量库。

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  model_json TEXT,
  thinking TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX session_events_branch ON session_events(session_id, branch_id, seq);

CREATE TABLE session_snapshots (
  session_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input BLOB NOT NULL,
  status TEXT NOT NULL,          -- pending | allowed | denied | expired
  expires_at INTEGER NOT NULL
);
CREATE INDEX approvals_pending ON approvals(session_id, status);

CREATE TABLE branches (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  fork_seq INTEGER,
  head_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, branch_id)
);
```

写入策略：

- 事件先入内存队列；`message.delta`/`tool.updated` 每 16 ms 或 64 条合并成一个事务；`message.completed`、`tool.completed`、`approval.*`、`run.*` 立即 flush。
- 快照在 run 结束、每 200 条事件、或每 5 秒（有变更时）写一次；快照与“快照覆盖到的最后一个 seq”同事务。
- 启动只读 `sessions` meta；打开会话时读快照 + `seq` 之后事件；没有快照就从 0 重放。
- WAL 在 idle 时 `wal_checkpoint(TRUNCATE)`；事件保留策略：默认保留全部，压缩后可选归档 `firstKeptSeq` 之前的事件到冷文件（M6 再做）。
- 旧 `console.sqlite` 迁移：`sessions`/`session_summaries`/`events` → 新表；迁移幂等，带 `schema_migrations` 版本；旧库先备份。
- JSONL 只通过 `pi-transcript-import` 导入、通过 `export` 导出；不再作为运行时真相。

### 5.7 工具平面

内置工具：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`。适配器：MCP、codemode、browser、app plugin 工具。

执行流水线：

```text
tool_call
  → schema 校验
  → policy: allow / ask / deny
  → ask: 持久化 approval + 事件 + 等待（超时/取消）
  → workspace.resolve 路径
  → execute(args, { signal, timeoutMs, emitUpdate })
  → 输出截断（maxOutputBytes，默认 64 KB；超限写 spill 文件）
  → tool.completed / tool.failed
```

要求：

- 工具定义在内核，不在 server；server 只提供 `WorkspaceBackend`、`BrowserBackend`、插件工具。
- `readOnly` 工具可并行；写工具按 `mutationKey` 串行；`bash` 默认串行。
- 工具输出永远有上限；不要把 10 MB 日志塞进 transcript。
- `write`/`edit` 带 revision（mtime+size 或内容 hash），冲突返回可重试错误。
- 不在内核里做 npm/git 安装；扩展安装属于 server 的资源管理。
- 工具错误是数据，不是异常：返回 `{ isError: true, content }`，让模型看到并修正。

### 5.8 上下文与压缩

`ContextBuilder` 每轮只构建一次，输入：

- `SessionSnapshot` + 活跃分支事件；
- 模型（contextWindow/maxTokens/thinking）；
- 工具 loadout；
- 资源索引（AGENTS.md、skills、prompt templates、项目指令）；
- 待注入的 steering/followUp/系统消息。

输出：

```ts
interface BuiltContext {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  estimatedTokens: number;
  sections: { name: string; tokens: number }[];
}
```

规则：

- 稳定前缀优先：身份/环境/工具/项目指令在前，易变内容在后；同一轮不要无故重排。
- 工具声明变化时，用一条系统消息告知模型，而不是重写整个 transcript。
- token 估算：CJK 按 0.75–1.0 token/字，拉丁按 ~0.25 token/字符；用最近一次 provider usage 做 EMA 校准；估算误差目标 < 10%。
- 预算：`contextWindow - reserveTokens`；超过时先压缩，压缩失败再裁剪最旧工具输出；永不丢当前用户消息。
- 压缩：摘要旧轮次，保留最近 `keepRecentTokens`；保留文件操作（读过/改过）和未完成 TODO；摘要请求单独计费，但不破坏主对话前缀缓存。
- 资源索引在会话启动时构建，文件变化用 200 ms debounce 增量更新；不要每轮全盘扫描。
- 系统提示由内核构建；server 不拼接 plan-mode 前缀（那是策略/提示层，不是传输层）。

### 5.9 模型网关

`ModelGateway` 是唯一模型入口；`PiAiGateway` 是唯一 import `pi-ai` 的文件。

- `list()`：模型目录 + 用户自定义 provider；`resolve()`：校验 auth、contextWindow、thinking 支持。
- `stream()`：把 `ModelRequest` 转成 `pi-ai` 的 `Context`/`TranscriptContext` + `SimpleStreamOptions`，把 `AssistantMessageEvent` 归一化成 `ModelEvent`。
- auth：`auth.json`/`models.json`；OAuth/API key 由 `pi-ai` credential store 处理；server 的 `ProviderManager` 只做 UI 和文件读写，不直接 stream。
- 错误：限流/超时/5xx/context overflow 分类；重试策略在内核 `retry.ts`，网关只报告可重试性。
- usage/cost：每个 `done` 带 usage；会话汇总；UI 展示缓存读写。
- 迁移期保留 `pi-ai` 的模型目录和 provider 实现；如果未来要零 Pi，逐个 provider 在网关后替换，不影响内核。

### 5.10 工作区（仅本地）

`WorkspaceBackend` 只实现本地工作区：

- 本地：`fs/promises` + realpath + 私有路径规则；`exec` 用 argv，不拼 shell；可选 sandbox。
- 远程工作区明确移除：`apps/server/src/remote-workspaces.ts`、`RemoteWorkspaceService`、`pi-env` 及相关路由/依赖在 M1 停止新增、M6 删除；不实现 `RemoteWorkspaceBackend`。
- Git：`git` 子进程 + `--porcelain=v2`，只读查询；写操作仍走工具审批。
- 文件监听：本地 `fs.watch`；只用于资源索引和 UI 刷新，不作为正确性依赖。
- 浏览器：Playwright 在 server/adapter，生命周期由会话/工具管理；截图/页面内容有大小上限。

### 5.11 扩展

内核只暴露 10 个稳定 hook：

```ts
type KernelHook =
  | "session.start"
  | "session.end"
  | "input"
  | "context"
  | "model.before_request"
  | "model.after_response"
  | "tool.before_call"
  | "tool.after_result"
  | "run.before_turn"
  | "run.after_turn";
```

API：

```ts
interface KernelExtension {
  name: string;
  on?(hook: KernelHook, handler: (payload: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown): void;
  tools?(): ToolDefinition[];
  resources?(): ResourceProvider[];
}
```

规则：

- 内核扩展 API 不出现 `TUI`、`Theme`、`Component`、`Fastify`、`Request`。
- web 的 UI 交互通过 `UiPort`，不塞进内核；不新增 CLI 的 UI 适配。
- 旧 Pi 扩展通过 `PiExtensionBridge`：`pi.on(event, handler)` 映射到最接近的 hook；`registerTool` 映射到 `ToolDefinition`；`ui_prompt_*`/`footer` 等无对应 hook 的事件记录一次诊断并忽略。不要让旧扩展的类型进入内核。
- doompi/Cordis：短期保留 `apps/server/src/legacy/doompi-host.ts`，作为 app 级扩展；长期若要原生支持，定义 `PluginHost` 端口，不要把 Cordis 塞进内核。
- MCP/codemode：作为 `kernel-adapters` 的工具提供者，不进入内核核心；包 `pi-mcp`/`pi-codemode` 可以保留，因为它们是独立协议实现。
- 资源/包管理：`ResourceProvider` 端口；`PiPackageProvider` 复用现有 package manager 直到重写；安装逻辑在 server，不在内核。

### 5.12 权限与安全

- 传输层：Host/Origin/同源校验、桌面关闭令牌、2 MB body、4 KB WS payload；保持现状。
- 工作区：realpath + 符号链接/junction 拒绝 + 私有路径拒绝；错误信息不泄露主机绝对路径。
- 审批：policy 在内核；`plan` 只读；`ask` 默认；`auto` 只对只读/白名单；`full` 全放行但 UI 明确警告。审批持久化、5 分钟过期、重启过期。
- 命令：argv 执行，不经过 shell；需要 shell 的操作由工具显式声明；输出截断；超时杀进程树。
- 密钥：只在服务端；不进日志、不进 web、不进会话事件；provider 错误信息脱敏。
- 沙箱：独立 `SandboxBackend`（Windows Job Object、Linux bubblewrap/landlock、macOS seatbelt），可选；没有沙箱时，文档和 UI 明确“工具以当前用户权限运行”。不要把审批宣传成隔离。

### 5.13 可观测性与配置

- 结构化日志字段：`sessionId`、`runId`、`toolCallId`、`provider`、`model`、`durationMs`、`tokens`、`cacheRead`、`errorCode`。
- 指标：TTFT、tokens/s、工具耗时、审批等待、压缩次数/耗时、事件写入 ms、WAL 大小、会话加载 ms、冷启动 ms、空闲 RSS、内核依赖数、崩溃恢复成功、cache hit。
- `KernelTelemetry` 端口；默认 console/no-op，可接 `pi-telemetry`；不把 OTel 作为内核硬依赖。
- 配置：`KernelConfig` + `settings.json`（版本化迁移）；`auth.json`/`models.json` 保持兼容；未知字段保留。
- 版本：`kernelVersion` 与 `piVersion` 分开；`/api/health` 返回两者，迁移期 UI 可显示。

---

## 6. 迁移方案

### 6.1 策略

采用 strangler（绞杀者）而不是重写替换：

```text
旧：server → AgentSession → agent → pi-ai
新：server → KernelSession → PiEngine → AgentSession   （阶段 2）
              KernelSession → NativeEngine → ModelGateway → pi-ai （阶段 3–4）
```

- `AgentEngine` 是唯一引擎边界；`PiEngine` 包旧 `AgentSession`，`NativeEngine` 是新 loop。
- 一个会话只能由一个引擎处理；通过 `KERNEL_ENGINE=pi|native` 或会话字段选择。
- 新存储先上线，旧 JSONL 只读/导入；不做双写。
- 新协议先 additive：保留 `session.snapshot` + `SessionEvent`，增加 `seq`/`after`；web 的 `applyEvent` 逐步迁到 `protocol` 包。
- 每阶段都有回退开关；默认值在验收通过后才切换。

### 6.2 阶段表

| 阶段 | 目标 | 主要产出 | 预估（1 人） |
| --- | --- | --- | --- |
| M0 | 文档与边界 | 本文、删除旧文档、边界检查脚本 | 0.5–1 周 |
| M1 | 协议 + 存储 | `protocol` 包、事件日志、快照、审批表、WS resume | 2–3 周 |
| M2 | 会话 actor + 旧引擎 | `KernelSession`、`AgentEngine`、`PiEngine`、server 接入 | 3–4 周 |
| M3 | 原生 loop + 工具 | `NativeEngine`、工具注册/执行、local workspace、基础 context | 4–6 周（基础版完成） |
| M4 | 上下文/压缩/网关 | token 预算、CJK 估算、compaction、`PiAiGateway`、settings 迁移 | 3–4 周 |
| M5 | 扩展/MCP/codemode | hook bus、Pi bridge、MCP/codemode adapter、插件开发会话 | 3–4 周 |
| M6 | 移除 Pi | 删除 server 的 Pi import、远程工作区、CLI 包、依赖门禁 | 2–3 周 |

工作台 M0–M6 约 18–25 周（1 人，含缓冲约 6 个月）；2 人并行约 12–16 周。估算不含 provider/扩展的未知兼容问题。不设 M7：目标不保留 CLI 版本，`coding-agent`/`agent`/`tui` 在 M6 随 Pi 一起删除。

### 6.3 阶段详情

#### M0：文档与边界

**状态**：已完成（2026-11-03）。

**目标**：把事实固定下来，防止后续又出现“文档说 kernel facade、代码里没有”的情况。

**改动**

- 删除 `docs/architecture/`、`docs/audit/`、`docs/patches/`、`docs/plugin-architecture.md`、`docs/workbench-ui.md`；保留 `docs/brand/`。
- 删除 `scripts/check-architecture-docs.mjs`，从根 `package.json` 的 `check` 链移除 `check:arch-docs`。
- 新增本文。
- 新增 `scripts/check-kernel-boundaries.mjs`，并加入根 `check` 链：
  - `apps/server` 的 Pi/remote 依赖按“文件 + 包 + 条数”冻结为基线，当前 18 条；新增 import 直接失败，`--enforce` 在基线未清零时失败（M6 门禁）。
  - `packages/kernel/src` 禁止 `pi-*`、`chord`、`fastify`、`playwright-core`、`react`、`react-dom`。
  - `apps/web` 禁止 import `@pi-console/kernel`。
  - `packages/protocol/src` 只有包名为 `@pi-console/protocol` 时才做纯协议检查；当前路径仍是旧的 `@earendil-works/pi-protocol`，M1 释放路径后自动启用。
- 把 `apps/server/src/kernel.ts` 改名为 `apps/server/src/legacy/doompi-host.ts`，测试改为 `apps/server/test/doompi-host.test.ts`；只改路径/导入，不改行为。

**验收**

- `npm run check` 通过（不再依赖已删除的 docs 脚本；先在 worktree 执行 `npm install --ignore-scripts`，确保 `packages/ai` 使用嵌套的 `openai@7.19.0`）。
- 全仓不再有指向已删除文档的链接；README 增加本文入口。
- 边界脚本能列出当前 `apps/server` 的 18 条 Pi/remote import 作为基线，不阻断（M6 才阻断）；新 import 立即失败。
- doompi-host 测试通过，导入路径不再指向不存在的 `src/kernel.ts`。

**回退**：只回滚文档/package.json/rename/边界脚本，无运行时行为影响。

#### M1：协议 + 存储

**状态**：功能已完成（2026-11-04）。故障注入与“100 会话列表/冷启动”基准留到 M2 的运行时接入后补测，因为当前 server 仍保留部分旧的 session 元数据路径。

**实现结果**

- 旧协议已移到 `packages/pi-protocol`；新 `packages/protocol` 为 `@pi-console/protocol`，无运行时依赖，包含 DTO、`SessionEvent`、`applyEvent` 和 4 个 reducer 测试。
- `apps/shared/src/protocol.ts` 转发新协议；`apps/web` 的 18 个文件已改为直接从 `@pi-console/protocol` 导入。
- `packages/kernel` 新增 `SqliteEventStore`：每会话 `seq`、事件/快照/审批/分支表、`withTransaction`、`compact`。只有 `packages/kernel/src/store/sqlite.ts` 可以 import `node:sqlite`，边界脚本已锁定。
- `KernelSessionStore` 接入 `apps/server`：旧库一次性迁移（旧全局 event id -> 每会话 1..N）、16 ms/64 事件批量写、`flushPending`、读前 flush、创建会话立即落盘；`ConsoleStore` 仍作为 SQLite 句柄持有者，旧表保留但不再写。
- 审批已写 `kernel_approvals`：`ToolAuthorization` 通过 `ApprovalStore` 持久化 `pending/approved/denied/expired`；server 启动时把所有遗留 pending 标为 expired。
- WS `/ws/sessions/:id?after=<seq>` 已支持补发；`useSession` 记录最后 `eventId`/`sequence` 并在重连时传入 `after`。
- 额外修复：`latestSeq` 取 sessions 与 events 的最大 seq；`saveSessionMeta` 不再偷偷递增 seq；`session-projection`/`session-runtime` 两个旧测试改为当前版本与归档契约。

**验收结果**

- `npm run check` 全绿（含边界、web、desktop）。
- `apps/server/test/api.test.ts` 9/9；`packages/kernel` store 5/5；旧库迁移测试通过；server 全套 58 pass、3 skipped、1 个既有 workbench-smoke 重连超时未修。
- 100 条 200 字符 delta：12.3 ms，WAL 1,314,312 bytes（目标 <50 ms、<2 MB）；对照旧实现 311–380 ms、4.9–8.3 MB。
- 100 会话列表/冷启动、kill -9 故障注入尚未单独跑，列入 M2 回归。

**目标**：先解决“两份历史”和事件写放大；这一阶段不动 loop，风险最低、收益最直接。

**改动**

- 先释放 `packages/protocol` 路径：当前该目录是旧 CBOR RPC 包 `@earendil-works/pi-protocol`（依赖 chord/typebox，仅被 `packages/client`、`packages/server`、`coding-agent` 的实验 RPC 代码和脚本使用）。把它移到 `packages/pi-protocol`，保留包名 `@earendil-works/pi-protocol`，只更新路径型别名/相对导入；然后在新 `packages/protocol` 建 `@pi-console/protocol`。这一步必须先做，否则边界脚本无法区分新旧协议包。
- 新建 `packages/protocol`，把 `apps/shared/src/protocol.ts` 的 DTO、`SessionEvent`、`applyEvent` 迁入；新增 `KernelEvent` 信封、`seq`、`after` resume、`v:2`。协议包只允许相对导入，不 import Node。
- 新建 `packages/kernel/src/store`：
  - `sessions`/`session_events`/`session_snapshots`/`approvals`/`branches`；
  - 每会话 `seq`，批量 delta，检查点策略；
  - 迁移旧 `console.sqlite`；
  - `EventStore` 端口 + SQLite 实现。
- `apps/server` 改用新 store；`EventProjector` 缩成“调用 kernel store + 广播”的薄层；`SessionDetail` 由 reducer 物化。
- 审批写表：`ToolAuthorization` 改为调用 kernel `ApprovalStore`，重启后 pending → expired。
- WS：`/ws/sessions/:id?after=<seq>`；先补事件，再实时；snapshot 仍保留。
- `apps/web` 改为从 `@pi-console/protocol` 导入；`apps/shared` 保留转发，M6 删除。

**验收**

- 旧库迁移幂等；100 个旧会话可打开；分支/压缩历史可读。
- kill -9 在 stream/tool/approval 中：重启后状态为 `interrupted`，无重复工具执行，审批为 expired。
- 100 条 delta 写入 < 50 ms，WAL < 2 MB（同一基准脚本）。
- 100 会话列表 < 20 ms；冷启动 hydrate < 50 ms。
- 现有 server/web 测试全绿；WS 重连不丢事件。

**回退**：`KERNEL_STORE=legacy|v2`；v2 写新表，legacy 读旧表；迁移前备份 `console.sqlite`。

#### M2：会话 actor + 旧引擎

**状态**：已完成（2026-11-04）。

**目标**：把 server 的运行状态机收进内核，但暂时仍用 `AgentSession` 执行；验证生命周期/事件/审批/取消。

**实际实现（保持轻量，不引入第二套事件总线/审批服务）**

- `packages/kernel/src/session/session.ts`：`KernelSession` 单会话 actor。只有 `idle/running/approval/error/interrupted`、runId、`AbortController`、订阅和一个串行 run 槽；不持有 I/O、数据库或事件投影。
- `packages/kernel/src/session/types.ts`：`AgentEngine` 端口（`run/abort/dispose`）和 `KernelRunContext`；没有 DI 容器、消息队列或远程 actor。
- `apps/server/src/sessions/pi-engine.ts`：`PiEngine` 懒加载并缓存 `AgentRuntime`，`run` 直接委托 `runtime.prompt`，`abort` 委托 `runtime.abort`。事件仍走原 `AgentSession` 适配路径，因此事件序列不变。
- `SessionCoordinator` 只把执行入口切到 `actor.start()`、abort 切到 `actor.abort()`；Git 快照、usage、状态投影、审批 authorizer、插件刷新仍留在 server，避免把传输/工作区逻辑塞进内核。
- 审批进入/退出调用 `actor.enterApproval()/settleApproval()`，审批记录仍由 `ToolAuthorization` + `KernelSessionStore` 负责。
- 重启恢复：`EventProjector` 将非 idle 元数据标为 `interrupted`，`normalizeRestored` 保留该状态；未完成工具标 failed，审批清空。
- `PiEngine.forget()` 与 runtime registry 同步清理，修复 recover/plugin reload 后复用已 dispose runtime 的问题。

**验收**

- prompt/abort/approval/recover/plugin refresh/branch 回归通过；`api.test.ts` 9/9，`chat-controls.test.ts`（含 mid-stream abort）、`session-coordinator.test.ts`、`session-runtime.test.ts` 全绿。
- 双击 prompt 由 `KernelSessionConflict` 阻止（`packages/kernel/test/session.test.ts`）。
- `npm run check` 全绿；server suite 58 pass / 3 skipped / 1 fail。唯一失败是既有的 `workbench-smoke` 断线提示超时（与 M2 改动无关）。
- 100 会话列表 2.97 ms、100 个快照读取 11.48 ms（临时脚本，非正式基准）。
- 未实现 `KERNEL_ENGINE`/`KERNEL_ACTOR` 双路径：M2 默认只有一个 `PiEngine`，回退用 git revert。减少常驻分支和死代码，符合轻量化约束。

**回退**：revert M2 commit；数据格式不变（仍为 `kernel_*` 表 + JSONL transcript）。

#### M3：原生 loop + 工具

**状态**：基础版完成，原生引擎可按需开启；完整验收尚未通过。

已实现（M3 基础版）：

- `packages/kernel/src/engine/loop.ts`：用户消息 → 模型流 → 文本/thinking 事件 → 工具执行 → 工具结果 → 下一轮；最大 24 轮；abort 通过 `AbortSignal` 贯穿模型流和工具。
- `packages/kernel/src/engine/tools.ts`：read/write/edit/ls/grep/find/bash 内建工具；路径 containment、symlink 拒绝、输出 120 KB 上限、bash 超时。
- `packages/kernel/src/engine/types.ts`：内核自有 `ModelGateway`、`NativeMessage`、`NativeTool`、`NativeLoopEvent`，不依赖 Pi 类型。
- `apps/server/src/sessions/native-runtime.ts`：`NativeAgentRuntime` 实现现有 `AgentRuntime`；`PiAiGateway` 把 pi-ai `streamSimple` 事件映射到内核；审批沿用 server 的 `requestApproval`。
- `apps/server/src/sessions/pi-runtime.adapter.ts`：`KERNEL_ENGINE=native` 且满足新会话、无 transcript、非 remote、非插件开发时启用；其余走 `PiAgentRuntime`。
- 工具执行：连续只读调用并行，含写调用回退串行；`retry.ts` 提供可重试错误退避；`policy.ts` 统一 plan/ask/auto/full；`LocalWorkspace` 负责路径、符号链接和每路径写锁。
- 图片输入、金轨迹对比、CJK 预算仍未完成，记录在 `docs/note/M3.md`。
- 验证：`npm run check` 通过；kernel 17/17；`native-runtime.test.ts` 3/3（流式、计划模式拒绝写、流式中断）；server suite 60 pass / 3 skipped / 1 fail（仅既有 `workbench-smoke` 超时）。
- 轻量化：原生路径只新增 server 适配层和 kernel 纯逻辑；未引入新运行时依赖、事件总线、DI、ORM；PiEngine 保留为回退。

**目标**：用自研 loop 替换 `AgentSession` 的执行部分；先覆盖短会话，长会话仍可回退。

**改动**

- `loop/run-turn.ts`：请求 → 流式消息 → 工具调用 → 工具结果 → 下一轮；支持 sequential/parallel、steering/follow-up、abort、turn decision。
- `retry.ts`：provider 错误分类、指数退避、context overflow 触发压缩、最大重试。
- `tools/registry.ts` + `execute.ts` + builtin 工具：read/write/edit/bash/grep/find/ls；输出截断/spill；`mutationKey` 串行。
- `policy.ts`：plan/ask/auto/full；只读白名单；路径检查交给 `WorkspaceBackend`。
- `LocalWorkspace` adapter：从 `workspace-access.ts` 抽离路径/读写/命令；替换 `withFileMutationQueue` 为内核锁。
- `NativeEngine`：用 `ModelGateway` + `ContextBuilder` 基础版（system + transcript + tools，不含高级压缩）。
- `KERNEL_ENGINE=native` 只对新会话/短会话开放；旧会长会话仍 `pi`。

**验收**

- 金轨迹：简单文本、thinking、单工具、并行工具、审批 allow/deny/timeout、abort mid-stream、abort mid-tool、工具错误、图片输入、CJK 输入，事件序列与 `PiEngine` 对等。
- 工具输出/错误/耗时与旧实现等价；路径越界/符号链接拒绝测试通过。
- 内核无 `pi-coding-agent`/`pi-agent-core` import；边界脚本通过。
- TTFT、工具延迟不劣于旧引擎（同一 faux provider 基准）；按 7.2 要求不超过 PiEngine +10%，context build p95 < 10 ms，空闲内存/冷启动不高于 Pi 基线。

**回退**：`KERNEL_ENGINE=pi`；新会话可单独切回。

#### M4：上下文、压缩、模型网关

**目标**：让原生引擎支持长会话和真实 provider，移除 server 对 `ModelRuntime`/`DefaultResourceLoader`/`SettingsManager` 的依赖。

**改动**

- `context/builder.ts`：系统提示 sections、AGENTS/skills/prompts 索引、工具 loadout、稳定前缀。
- `context/budget.ts`：Unicode/CJK 估算、provider usage EMA 校准、裁剪策略。
- `context/compaction.ts`：摘要、保留最近、文件操作、`context.compacted` 事件；摘要请求独立，不影响主前缀缓存。
- `gateway/pi-ai.ts`：`PiAiGateway` 包装 `Models`/`streamSimple`/auth；`apps/server/src/providers.ts` 改用 gateway。
- `SettingsManager` 迁移：`settings.json` 版本化；旧字段读取；未知字段保留。
- 资源加载：`FsResourceProvider` + `PiPackageProvider`；文件变化 debounce。
- 移除 server 里的 `plan-mode` 提示拼接，迁到 context/policy。

**验收**

- 中文 100k 字上下文估算误差 < 10%；压缩后不 overflow；文件操作保留。
- 长会话 cache read > 0；压缩不会让主对话 cache 前缀失效。
- 真实 provider（至少 Anthropic/OpenAI 兼容）auth、模型列表、stream、usage/cost 正常。
- `NativeEngine` 支持 model/thinking 切换、图片、工具 loadout 变化。
- server 不再 import `ModelRuntime`/`DefaultResourceLoader`/`SettingsManager`（或只剩迁移适配）。
- context build p95 < 10 ms；压缩摘要不阻塞主流式事件；正常对话仍命中 provider prompt cache。

**回退**：`KERNEL_CONTEXT=legacy` 用旧 `AgentSession` 的 context/compaction；gateway 可切回 `ModelRuntime` 读取。

#### M5：扩展、MCP、codemode

**目标**：让工作台现有扩展/插件能力在新内核上可用，同时把 UI 类型从内核剥离。

**改动**

- `extensions/hooks.ts` + `registry.ts`：10 个 hook、`registerTool`、`registerResourceProvider`、诊断日志。
- `PiExtensionBridge`：把旧 `pi.on` 事件映射到 hook；`registerTool` 转 `ToolDefinition`；不支持的 UI 事件一次性 warn。
- 把 coding-agent 的 MCP/codemode/tool-search 适配代码迁到 `kernel-adapters`，直接调用 `pi-mcp`/`pi-codemode` 的底层 API，不再经过 `ExtensionFactory`。
- app plugin 工具（plugin_list/plugin_validate 等）改为内核 `ToolDefinition`；plugin development session 用同一套工具。
- doompi/Cordis host 保留在 `apps/server/src/legacy/`，通过 app 级 bridge 接入；不进入内核。

**验收**

- 现有 doompi 扩展、MCP server、codemode、tool-search、app plugin 开发会话可用。
- 旧扩展的 `tool_call`/`tool_result`/`context`/`session_start` 行为等价；不支持的事件有诊断。
- 内核 `extensions` 目录不 import `pi-tui`/`react`/`fastify`。
- 扩展安装/卸载/刷新不会打断运行中的会话（沿用 idle 刷新规则）。
- `kernel`/`kernel-adapters` 的运行时依赖预算不增加；MCP/codemode 按需加载，不在启动时拉起。

**回退**：`KERNEL_EXTENSIONS=legacy` 使用旧 `ExtensionRunner`；MCP/codemode 仍走旧扩展。

#### M6：移除 Pi

**目标**：工作台运行时只依赖 `protocol` + `kernel` + `kernel-adapters` + `pi-ai`（+ 可选 mcp/codemode）。

**改动**

- 删除 `apps/server` 对 `pi-coding-agent` 的所有 import：`createAgentSession`、`AgentSession`、`SessionManager`、`SettingsManager`、`ModelRuntime`、`DefaultResourceLoader`、`DefaultPackageManager`、`VERSION`、工具定义、`withFileMutationQueue`、MCP/codemode 扩展工厂。
- 删除 `PiAgentRuntime`/`pi-events.ts`/`pi-runtime.adapter.ts`；`AgentEngine=NativeEngine` 默认。
- `VERSION` 改用 `kernelVersion`；`/api/health` 增加 `piVersion`（来自 gateway）。
- 删除远程工作区：`apps/server/src/remote-workspaces.ts`、`RemoteWorkspaceService`、远程路由/设置项、`@earendil-works/pi-env`；`pi-env` 删除后 `chord`/`pi-durable` 不再进入 `apps/server` 依赖树。
- 删除 CLI：`packages/coding-agent`、`packages/agent`、`packages/tui` 从根构建和 `package.json` workspaces 移除；不新建 `apps/cli`，不保留 `legacy/` CLI。
- 根 `package.json` 的 `build` 不再构建 `coding-agent`/`agent`/`tui`/`env`/`durable`/`chord`/`protocol`/`client`/`server` 到工作台产物。
- 边界脚本改为硬失败：`apps/server` 禁止上述包；`packages/kernel` 禁止所有 Pi 包。
- 归档/删除死包：`protocol`/`client`/`server` 删除；`durable`/`chord` 移到 `experimental/` 或删除；`evals` 保留为开发工具。

**验收**

- `npm ls --workspace=@pi-console/server` 不再出现 `coding-agent`/`agent`/`tui`/`env`/`chord`/`durable`。
- `rg` 确认 `apps/server/src` 没有 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-env`、`chord`、`pi-durable`。
- 桌面安装包体积下降；启动/会话列表/流式写入达到预算。
- 旧会话导入、新会话导出、分支/压缩/审批/MCP/codemode 全量回归通过；确认远程工作区入口、路由、设置和依赖均已删除。
- `npm run check` + `./test.sh` 通过。

**回退**：保留 M5 分支；把 `KERNEL_ENGINE=pi` 作为一次性救援开关（M6 后仅用于回滚，不再默认发布）。不再保留 CLI legacy 路径。

### 6.4 双引擎与金轨迹

**金轨迹格式**

```json
{
  "name": "tool-approval-allow",
  "input": { "prompt": "read package.json", "accessMode": "ask" },
  "model": [
    { "type": "text", "delta": "I'll read it." },
    { "type": "toolcall", "id": "c1", "name": "read", "args": { "path": "package.json" } },
    { "type": "done", "reason": "toolUse" }
  ],
  "tools": [{ "callId": "c1", "result": "..." }],
  "expected": ["run.started", "message.started", "message.delta", "message.completed", "tool.started", "approval.requested", "approval.resolved", "tool.completed", "run.completed"]
}
```

- 录制：在 `KernelSession` 输入和 `ModelGateway` 输出处录制；不录真实网络。
- 归一化：忽略时间、随机 id、耗时；保留事件类型顺序、消息/工具内容、审批结果、usage 字段。
- 回放：`FauxModelGateway` + `MemoryEventStore` + 临时工作区；`PiEngine` 与 `NativeEngine` 各跑一遍，diff。
- 场景至少覆盖：纯文本、thinking、单工具、并行工具、审批 allow/deny/timeout、abort mid-stream、abort mid-tool、工具错误、overflow compaction、retry、branch、MCP、codemode、图片、CJK 长上下文、崩溃/重启。
- CI 只跑 faux provider；真实 provider 只在手动 release smoke。

**双跑（shadow）**

- 生产默认不同时跑两个引擎（成本/副作用不可控）。
- 在测试/预发布环境，对只读会话可开启 shadow：`NativeEngine` 的结果只写日志，不写 store/不执行工具；用于发现差异。
- 写工具/命令绝不 shadow 执行。

### 6.5 数据迁移

**旧 SQLite → 新 SQLite**

1. 备份 `console.sqlite` 到 `console.sqlite.bak-<timestamp>`。
2. 读 `sessions`/`session_summaries`/`events`；按会话重建 `seq`（旧 `id` 递增）。
3. `session_summaries.data` → 新 `session_snapshots.payload`；`events.data`（gzip）→ `session_events.payload`。
4. 旧 session `file` 保留为 `legacy_file` 元数据，供 JSONL 导入/导出。
5. 迁移在事务中执行；失败回滚并保留旧库；`schema_migrations` 记录版本。

**旧 JSONL → 新事件**

- `SessionManager.open(file).getBranch()` 读活跃路径。
- 映射：
  - `message` → `message.started` + `message.completed`（或直接 `message.completed`，reducer 建消息）。
  - `thinking_level_change`/`model_change`/`session_info`/`label` → `session.updated`。
  - `usage` → `usage.updated`。
  - `compaction` → `context.compacted` + 摘要消息。
  - `branch_summary` → `branch.created` + 摘要。
  - `custom`/`custom_message` → `extension.data`（不进入 LLM context）。
  - `context_edit` → `message.replaced`（保留 targetId）。
- 旧树的分支：每个 leaf 路径导入为一个 branch；只保留活跃路径的消息作为默认 branch，其余 branch 可通过 UI 切换。
- 导入是幂等的：用 `legacy_file + entry_id` 做唯一键；重复导入跳过。
- 导入后 JSONL 只读；新会话不再写 JSONL。导出功能生成同构 JSONL，便于回迁/审计。

### 6.6 兼容层

| 兼容对象 | 方式 | 退出条件 |
| --- | --- | --- |
| 旧 Pi 扩展 | `PiExtensionBridge` 映射 hook；不支持的 UI 事件诊断 | 扩展作者迁移或明确不再支持 |
| doompi/Cordis | `legacy/doompi-host.ts` app 级 host | 原生插件 API 或用户不再需要 |
| 旧 JSONL | 导入器；只读 | 所有活跃会话迁移完成 |
| 旧 settings.json | 读取 + 版本迁移；未知字段保留 | 新 schema 稳定 |
| 旧 auth.json/models.json | `pi-ai` credential store 读取 | 新网关稳定 |
| 旧 `console.sqlite` | 迁移 + 备份 | 迁移验证通过 |

兼容层原则：**只做数据/接口转换，不把旧类型带进内核**。`PiEngine`/`PiExtensionBridge` 是唯一允许 import Pi 的地方（除了 `PiAiGateway`）。不保留旧 CLI 的兼容层。

### 6.7 最终 Pi 足迹

| 包 | 目标状态 | 理由 |
| --- | --- | --- |
| `pi-ai` | 保留 | provider wire/auth/stream/catalog 高变更、非差异化；网关隔离 |
| `pi-telemetry` | 保留（传递依赖） | `pi-ai` 依赖；很小 |
| `pi-mcp` | 可选保留 | 标准协议实现；作为工具适配器 |
| `pi-codemode` | 可选保留 | QuickJS 代码模式；作为工具适配器 |
| `pi-agent-core` | 删除 | 新 loop 取代 |
| `pi-coding-agent` | 删除（M6） | 新内核取代；不保留 CLI |
| `pi-tui` | 删除（M6） | 不保留 CLI |
| `pi-env` | 删除（M6） | 远程工作区移除 |
| `pi-durable` | 归档/删除 | 实验 runtime，不进入产品 |
| `chord` | 归档/删除 | 应用框架，不进入产品 |
| `pi-protocol`/`client`/`server` | 删除 | 工作台不用 CBOR RPC |
| `pi-evals` | 开发工具 | 评测需要 |

最终工作台运行时依赖：

```text
apps/web → @pi-console/protocol
apps/server → @pi-console/kernel + @pi-console/kernel-adapters + @pi-console/protocol
@pi-console/kernel-adapters → pi-ai (+ optional pi-mcp/pi-codemode)
@pi-console/kernel → typebox
```

`pi-ai` 是唯一“Pi 内核”残留；如果未来要零 Pi，`PiAiGateway` 后面可以逐 provider 替换，不影响 `KernelSession`/server/web。

---

## 7. 验收与基准

### 7.1 功能矩阵

| 能力 | PiEngine（基线） | NativeEngine（目标） | 验收阶段 |
| --- | --- | --- | --- |
| 文本流式 | 是 | 是 | M3 |
| thinking | 是 | 是 | M3/M4 |
| 工具调用（串行/并行） | 是 | 是 | M3 |
| 审批 allow/deny/timeout | 是 | 是 | M2/M3 |
| 取消（stream/tool） | 是 | 是 | M3 |
| steer/follow-up | 是 | 是 | M3 |
| 模型/thinking 切换 | 是 | 是 | M4 |
| 图片输入 | 是 | 是 | M3/M4 |
| 压缩/长会话 | 是 | 是 | M4 |
| 分支/回退 | 是 | 是 | M2/M4 |
| usage/cost | 是 | 是 | M4 |
| 文件引用/Git diff | 是 | 是 | M3 |
| MCP/codemode/tool-search | 是 | 是 | M5 |
| app plugin 开发会话 | 是 | 是 | M5 |
| 远程工作区 | 是 | 否（目标移除） | M6 |
| 重启恢复 | 部分（审批丢） | 是 | M1/M2 |
| 旧会话导入/导出 | 部分 | 是 | M1/M6 |

### 7.2 性能预算

| 指标 | 当前 | 目标 |
| --- | --- | --- |
| 100 会话列表 | 108–113 ms（旧）；7.2–7.8 ms（迁移后） | < 20 ms |
| 100 条 delta 写入 | 311–380 ms；WAL 4.9–8.3 MB | < 50 ms；WAL < 2 MB |
| 冷启动 hydrate | ~133 ms 首轮；7.2 ms 后 | < 50 ms |
| 进程冷启动（到 `/api/health` 可用） | 未测 | < 300 ms |
| 100 会话 RSS | 154–256 MB | < 150 MB |
| 空闲会话内存 | 未测 | < 1 MB/会话（不含 transcript/模型缓存） |
| 事件 append p95 | 未测 | < 5 ms |
| 事件编码 p95 | 未测 | < 1 ms |
| context build p95 | 未测 | < 10 ms |
| 工具调度开销 p95 | 未测 | < 5 ms（不含执行） |
| 流式首个 delta 额外开销 | PiEngine 基线 | 不超过 PiEngine +10%，且 < 20 ms |
| 崩溃恢复 | 未测 | < 200 ms |
| 压缩 100k tokens | provider 相关 | < 5 s 额外开销（不含模型） |
| 内核运行时依赖 | Pi SDK 树 | 仅 `protocol`；0 个新增第三方依赖 |
| 生产依赖数量/安装包体积 | 当前基线 | 不增加；目标下降 |

说明：provider 网络/生成时间不计入；基准用 faux provider 和固定工作区；每阶段在 CI 记录。任何一项不达标都不得把 `NativeEngine` 设为默认；回归超过 10% 必须给出原因和修复计划，超过 20% 直接阻断合并。轻量化不是“以后优化”，而是每个阶段的准入条件。

### 7.3 测试矩阵

- **单元**：reducer、token 估算、policy、路径规范化、compaction cut、retry 分类、工具截断。
- **契约**：`KernelSession` 状态机；`AgentEngine` 事件；`EventStore` append/load/checkpoint；`ModelGateway` 事件。
- **集成**：server 路由 + WS；prompt→tool→approval→done；abort；branch；restart。
- **金轨迹**：`PiEngine` vs `NativeEngine` 事件 diff。
- **故障注入**：模型流开始/每个 delta/结束；工具开始/审批前/执行中/结束；store append 前后；WS send；迁移中断。
- **安全**：路径穿越、符号链接/junction、私有路径、审批绕过、Host/Origin、密钥泄漏。
- **性能**：上述基准脚本；内存/句柄泄漏（重复打开关闭 100 次）。
- **UI**：现有 browser smoke + web reducer 测试；重连/背压。
- **兼容**：doompi、MCP server、codemode、旧 JSONL、旧 settings、旧 auth。

### 7.4 完成定义

“Pi 内核已被替换”需要同时满足：

1. `apps/server` 不再 import `pi-coding-agent`/`pi-agent-core`/`pi-env`/`chord`/`pi-durable`。
2. `packages/kernel` 不 import 任何 Pi 包；`packages/protocol` 不 import Node。
3. 事件日志是唯一会话真相；JSONL 只用于导入/导出。
4. 审批重启后仍可审计（pending → expired），不丢失。
5. 中文长上下文估算误差 < 10%，不发生非预期 overflow。
6. 性能预算全部达标；faux provider 下 `NativeEngine` 的 TTFT/工具调度不慢于 `PiEngine` 10%，空闲内存和冷启动不高于 Pi 基线。
7. 功能矩阵中 NativeEngine 全部为“是”，金轨迹 diff 为空。
8. 旧会话可读、可导出；崩溃后可恢复。
9. `npm run check` + `./test.sh` + 桌面 smoke 通过。

---

## 8. 风险与决策

### 8.1 风险

| 风险 | 影响 | 缓解 | 触发信号 |
| --- | --- | --- | --- |
| `AgentSession` 隐藏行为多 | 新引擎行为不一致 | 金轨迹 + 逐阶段对等 + 保留 PiEngine | 事件 diff 非空 |
| 旧扩展依赖 UI 类型 | 扩展失效 | bridge + 诊断 + legacy host | 扩展加载失败/行为差异 |
| provider auth/模型目录复杂 | 登录/模型列表回归 | 先保留 pi-ai 网关 | auth 测试失败 |
| 数据迁移丢历史 | 用户投诉 | 备份 + 幂等 + 双读校验 | 迁移校验和不一致 |
| 事件日志增长 | 磁盘/加载变慢 | 快照 + 压缩 + 归档策略 | DB 超预算 |
| 过度抽象/依赖膨胀 | 启动变慢、内存升高、重蹈框架叠加 | 5.1.1 硬约束 + 依赖门禁 + 热路径 p95 基准 | 内核新增依赖/框架，或 p95 超 1 ms |
| 性能回归被功能验收掩盖 | “功能全过”但体验变差 | 性能作为独立准入门槛；不达标不切默认引擎 | faux 基准慢于 PiEngine 10% |
| 移除远程/CLI 影响现有用户 | 使用方式断裂 | 发布说明 + 明确不兼容；不保留半套兼容层 | 仍有产品入口引用远程/CLI |
| 双引擎期间行为漂移 | 难以定位 | 归一化事件 + 单一 store + 开关 | 同输入不同事件 |
| 范围蔓延（UI/多租户/云） | 延期 | 非目标清单 + 阶段门禁 | 新需求进 M0–M6 |
| Windows 路径/进程差异 | 工具/进程异常 | 专门测试 + Job Object 调研 | CI Windows 失败 |
| 没有沙箱 | 安全事件 | 明确风险 + 可选 sandbox | 用户执行不可信代码 |

### 8.2 决策记录

| ID | 决策 | 理由 | 替代方案（拒绝） |
| --- | --- | --- | --- |
| D1 | 保留 `pi-ai`，替换 `agent`/`coding-agent` | provider 协议高变更、非差异化；网关可隔离 | 一次性重写所有 provider：风险/成本高 |
| D2 | 不采用 chord/durable 作为新内核 | 又一个框架叠在 runtime 上；durable 是第二套 kernel；与“减少层数”矛盾 | 用 durable Harness 替换 AgentSession：仍受 chord/框架约束 |
| D3 | 3 个新包（protocol/kernel/adapters） | 边界清晰、构建简单；避免 12 包微内核 | 每模块一个包：版本/构建/导入开销大 |
| D4 | 事件日志唯一真相，JSONL 仅导入导出 | 消除双写/四模式 hydrate/409 | 继续双写：一致性问题不解 |
| D5 | web 只依赖 protocol | 防止 Node/SQLite 进浏览器包；reducer 共享 | web 直接 import kernel：打包/安全风险 |
| D6 | 内核不依赖 UI/HTTP/DB 具体实现 | 可测试、可复用、web/未来前端共用 | 内核里放 Fastify/TUI：回到当前耦合 |
| D7 | 审批持久化 | 重启可审计、不丢状态 | 内存 Map：当前问题 |
| D8 | 崩溃不自动重放工具 | 非幂等命令可能重复执行 | 自动 resume：危险 |
| D9 | 沙箱后置，不阻塞 M1–M6 | 先解决架构/性能；沙箱是独立安全能力 | 先把沙箱塞进内核：范围爆炸 |
| D10 | 移除 CLI，不保留 legacy | 工作台是唯一产品；保留 CLI 会让 Pi 依赖无法清零 | 保留 legacy CLI：依赖/构建/文档长期分叉 |
| D11 | 每会话单 active run | 状态机简单、事件有序 | 多 run 并发：审批/文件冲突复杂 |
| D12 | 分支用 `branchId`，事件全局 `seq` | 保留回退/分支；排序简单 | 每分支独立文件：迁移/查询复杂 |
| D13 | 轻量优先于抽象 | 保留 Pi 的单进程、低依赖、快启动；抽象必须用性能证明自己 | DI/ORM/通用事件总线/微内核：启动和内存成本高 |
| D14 | 性能不回归才切默认引擎 | 功能对等不代表体验对等；PiEngine 是基线 | 功能验收通过即切换：可能悄悄变慢 |
| D15 | 移除远程工作区与 CLI | 缩小产品面，清掉 `pi-env`/chord/durable 和 TUI 依赖 | 继续维护两套入口：拖慢内核收敛 |

### 8.3 不做什么（非目标）

- 不重写 `apps/web` UI；只改协议导入和必要的 resume 逻辑。
- 不引入新数据库/消息队列/向量库；继续 SQLite + 进程内事件。
- 不做内核 RPC/微服务；内核是库。
- 不做多租户/云同步/远程登录。
- 不做远程工作区，不保留 CLI 版本，不维护 `legacy/` CLI。
- 不做多 agent 编排/任务图作为默认能力；durable 的 task graph 只作参考。
- 不用 Rust/Go 重写；不换 Tauri。
- 不在第一轮替换所有 provider SDK；`pi-ai` 保留。
- 不为“未来可能的需求”预建 12 个包/插件市场/沙箱编排。
- 不保留 Pi 内部 API 兼容；只保留数据/功能/扩展行为兼容。

### 8.4 待确认

1. doompi/Cordis 扩展是否是硬需求？如果是，M5 必须保留 legacy host，且原生插件 API 要能表达它的能力；否则可以只做 bridge。
2. 是否有用户依赖未文档化的 `pi-ai` 深路径/自定义 provider？M4 前做一次导入审计。
3. 旧 JSONL 分支历史是否需要完整保留？如果不需要，导入可只保留活跃路径，降低复杂度。
4. 远程工作区/CLI 移除是否需要一次性迁移提示或导出工具？这是发布体验问题，不改变移除决策。

---

## 9. 附录

### 9.1 关键文件索引

| 主题 | 文件 |
| --- | --- |
| 服务端组合根 | `apps/server/src/bootstrap/create-app.ts:41` |
| AgentService | `apps/server/src/agent.ts:37` |
| 会话编排 | `apps/server/src/sessions/coordinator.ts:47`、`:319`、`:459` |
| Pi runtime 适配 | `apps/server/src/sessions/pi-runtime.adapter.ts:69`、`:126`、`:257` |
| 事件适配 | `apps/server/src/sessions/pi-events.ts:46`、`:102` |
| 事件投影 | `apps/server/src/sessions/event-projector.ts:62`、`:143` |
| SQLite store | `apps/server/src/store.ts:17`、`:26` |
| 审批 | `apps/server/src/sessions/tool-authorization.ts:26`、`:35` |
| 工作区/路径 | `apps/server/src/workspaces/workspace-access.ts:4`、`:29` |
| 协议/reducer | `apps/shared/src/protocol.ts:205`、`:253`、`:268`、`:288` |
| 会话主类 | `packages/coding-agent/src/core/agent-session.ts:485`、`:1968`、`:2764`、`:3606`、`:3660` |
| JSONL 会话 | `packages/coding-agent/src/core/session-manager.ts:183`、`:286`、`:977` |
| 压缩 | `packages/coding-agent/src/core/compaction/compaction.ts:311`、`:631` |
| 扩展类型 | `packages/coding-agent/src/core/extensions/types.ts`、`runner.ts` |
| Agent loop | `packages/agent/src/agent.ts:114`、`:188`；`agent-loop.ts:38`、`:71`；`types.ts:516` |
| 模型 API | `packages/ai/src/models.ts:901`；`types.ts:766`、`:801` |
| 桌面 | `desktop/src/main.ts`（83 行） |
| 前端会话 | `apps/web/src/features/chat/useSession.ts:29`、`:40`、`:42` |
| WS | `apps/server/src/transport/websocket/session-stream.ts` |
| doompi host | `apps/server/src/legacy/doompi-host.ts`（M0 改名，原 `src/kernel.ts`） |

### 9.2 术语

| 术语 | 含义 |
| --- | --- |
| 内核 / Kernel | 会话状态机、loop、上下文、工具、策略、事件存储；不含 HTTP/UI/DB 具体实现 |
| 引擎 / Engine | 一次 run 的执行策略；`PiEngine`（旧）或 `NativeEngine`（新） |
| 事件 / Event | 追加到会话日志的不可变记录；`seq` 排序 |
| 快照 / Snapshot | reducer 从事件物化的当前状态；可重建，不是真相 |
| 金轨迹 / Golden trace | 固定输入 + 固定模型输出 + 期望事件序列，用于新旧引擎对等测试 |
| 端口 / Port | 内核与外部世界的边界接口：模型、存储、工作区、遥测 |
| 适配器 / Adapter | 端口的实现：`pi-ai`、本地工作区、MCP、codemode |
| 审批 / Approval | 对 ask 工具调用的用户决定；持久化、可过期、不可自动批准 |
| 分支 / Branch | 从某个 `seq` 分叉的会话历史；`branchId` 标识 |
| 压缩 / Compaction | 用摘要替换旧上下文，保留最近轮次和文件操作 |

### 9.3 文档清理记录

本次删除：

- `docs/architecture/`：`00-plan.md`、`01-project-architecture.md`、`02-kernel-architecture.md`、`03-target-architecture.md`、`04-roadmap.md`、`README.md`、S0–S9 阶段文档、`stages/history/`、全部 SVG。
- `docs/audit/`：`code-audit.md`、`docs-audit.md`、`harness-assessment.md`、`kernel-map.md`、reachability/refs/assets 脚本与 JSON。
- `docs/patches/README.md`。
- `docs/plugin-architecture.md`、`docs/workbench-ui.md`。
- `scripts/check-architecture-docs.mjs`；根 `package.json` 的 `check:arch-docs`。

删除原因：

- `apps/server/src/kernel` facade 不存在；`kernel.ts` 是 doompi host。
- 12 个 `kernel-*` 包与 S0–S9 阶段计划没有落地，且与当前代码/产品优先级不符。
- 旧审计的行号/结论已被后续改动覆盖；保留会误导。
- 文档门禁脚本只维护旧文档，删除后不再阻塞 `npm run check`。

保留：

- `docs/brand/`：README 使用的品牌资源。
- 根 `README.md`、`apps/README.md`、`desktop/README.md`、`packages/*/README.md`：产品或包说明，不是旧架构文档。
- `packages/coding-agent/docs/`：Pi 上游使用文档，仅作迁移期参考，M6 随 `coding-agent` 删除；新内核文档不复制它们。

维护规则：

1. 只维护本文；阶段完成后更新“当前/目标/验收”，不新增阶段文档。
2. 代码引用用 `path:line`；行号变化时同步更新。
3. 任何“计划中”的路径必须标注阶段（M0–M6），不能写成已存在。
4. 不在本文里复制 provider/框架的上游文档；只写本项目的事实和决策。
