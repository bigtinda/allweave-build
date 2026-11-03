# 01 项目架构（现状事实）

> 对应图：`01-project-architecture.svg`。核实时间 2026-11-03，分支 `codex/v1`。
> 本文只描述**现在真实存在的东西**。目标形态见 `03-target-architecture.md`，内核细节见 `02-kernel-architecture.md`。

## 1. 这张图画了什么

一个仓库同时装着两样东西：

1. **上游 Pi**（`packages/`）：一个通用 Agent 工具链（CLI、Agent SDK、模型网关、TUI、MCP、协议栈等）。它把自己当产品，有独立的版本号、构建与发布流程。
2. **AllWeave Build（`apps/` + `desktop/`）**：本仓库的"工作台"产品——Web 界面 + 本地服务 + Windows 桌面壳，把 Pi 的 coding-agent SDK 当**进程内库**使用。

两者之间的关系不是"插件"，而是**同仓库、不同产品边界**：`apps/*` 可以 `import @earendil-works/pi-*`，`packages/*` 不知道 `apps/*` 存在（无反向依赖）。

## 2. 三种部署形态

| 形态 | 进程 | 入口 | 说明 |
|---|---|---|---|
| 开发 | 两个 | `npm run dev:web` | `scripts/dev-web.mjs` 同时起 `node --watch` 后端与 Vite；浏览器访问 `http://127.0.0.1:5173`，Vite 把 `/api`、`/ws` 代理到 `127.0.0.1:8787` |
| Web 生产 | 一个 | `apps/server/src/main.ts` | Fastify 监听 8787，托管 `apps/web/dist`（SPA 回退 `index.html`） |
| 桌面 | 两个（父子） | `desktop/src/main.ts` | Electron 主进程起随包 Node 跑同一个后端，端口随机，`BrowserWindow` 加载服务地址；关闭时 POST `/api/desktop/shutdown` 带一次性 token，再 `taskkill /T /F` |

## 3. apps 三包逐层职责

### 3.1 `apps/web`（48 个 `.ts/.tsx`，共 55 个文件）

- 入口：`index.html`（`zh-CN`，标题"AllWeave Build · 构序"）→ `main.tsx`（QueryClient、Router）→ `App.tsx`（1333 行，壳 + 内联 react-router 路由，无独立路由配置模块）。
- 目录约定：`pages/`（页面级）、`components/`（24 个跨页面组件 + 1 个样式文件）、`features/chat/`（聊天域，唯一被 AST 测试约束的 feature）、`services/`（`api.ts` 是唯一 fetch 入口）、`stores/`（zustand + persist）、`theme/`（主题、手写 spring 动效、个性化）。
- 契约：只从 `apps/shared/src/protocol.ts` 取类型；`features/*` 之间只能经 `index.ts` 互相引用（`apps/web/test/feature-boundaries.test.ts` 用 AST 强制）。
- 实时通道：`features/chat/useSession.ts` 打开 `ws://<host>/ws/sessions/:id`，先收 `session.snapshot`，再按 `applyEvent` 合并增量；断线指数退避重连（1s×2^n，上限 15s）。

### 3.2 `apps/shared`（4 个文件）

- `protocol.ts`（321 行）：**前后端唯一契约**。`SessionSummary`/`SessionDetail`/`ChatMessage`/`ToolCall`/`Approval`/`SessionEvent`/`SocketMessage` + `applyEvent()`。
- `browser.ts`、`plugins.ts`：浏览器命令与 app plugin 的共享类型/工具函数（`packageIdentity` 在 `plugins.ts`）。
- `format.ts`：共享的 `formatDuration()`（重复实现已合并到此）。

### 3.3 `apps/server`（42 个文件：41 个 `.ts` + `office-preview.ps1`）

按"组合根 → 传输 → 领域服务 → 状态"分层：

| 目录 | 文件 | 职责 |
|---|---|---|
| `bootstrap/` | `create-app.ts` | 组合根：建服务、建 Fastify、装安全钩子、注册路由、托管前端 |
| `transport/http/` | `sessions`、`workspaces`、`providers`、`resources`、`app-plugins`、`browser`、`schemas` | REST 协议翻译 + Zod 校验 |
| `transport/websocket/` | `session-stream`、`browser-stream` | 会话事件流、浏览器帧流 |
| `sessions/` | `coordinator`(660)、`pi-runtime.adapter`(413)、`runtime-registry`、`event-projector`(357)、`event-hub`、`tool-authorization`(121)、`tool-factory`(270)、`pi-events`(108)、`run-usage` | 会话状态机、Pi 适配、事件投影、审批、工具注入 |
| `workspaces/` | `service`(473)、`workspace-access`(299)、`command-operations`、`office-preview` | 授权目录、文件/Git、Office 预览 |
| `persistence/` | `transcript`、`session-projection` | 从 Pi JSONL 重建对话、投影合并 |
| 顶层 | `agent`、`providers`、`packages`、`app-plugins`(470)、`browser`(582)、`git`、`remote-workspaces`(440)、`remote-mcp`、`storage`、`security`、`store`、`tool-policy`、`kernel` | 领域服务与基础设施 |

服务端核心对象关系：

```
createApp()
  ├─ ConsoleStore(directory)                     ← node:sqlite，WAL
  ├─ WorkspaceService(roots) ─→ WorkspaceAccess   ← 授权目录 + 本地/远程
  ├─ AgentService ─→ SessionCoordinator
  │                    ├─ AgentRuntimeFactory ─→ Pi SDK（唯一接缝）
  │                    ├─ EventProjector ─→ ConsoleStore
  │                    ├─ EventHub ─→ session-stream（WS）
  │                    └─ ToolAuthorization
  ├─ ProviderManager / PiPackageManager / BrowserService / AppPluginManager
  └─ Fastify + 路由 + 静态前端
```

## 4. 七处数据存储（谁写谁读）

| 存储 | 位置 | 写者 | 读者 | 性质 |
|---|---|---|---|---|
| 工作台元数据 + 事件 + 投影 | `<dataDir>/console.sqlite`（WAL） | `ConsoleStore`（唯一写者经 `EventProjector`） | 服务端启动/查询 | 可重建投影 + 事件日志（保留约 1000 条/会话） |
| 对话正文（真相源） | `<dataDir>/sessions/*.jsonl` | Pi `SessionManager` | `transcript.ts` 只读重建 | append-only、版本 3、树形分支 |
| Pi 配置/鉴权 | `<dataDir>/agent/{settings.json,auth.json,models.json,models-store.json,pi-console-package-state.json}` | Pi SDK / ProviderManager / PiPackageManager | Pi SDK | 凭据、模型选择与包启停状态 |
| 授权根快照 | `<dataDir>/authorized-roots.json` | `WorkspaceService.initialize()` | 服务端启动 | 配置快照 |
| 插件注册与记录 | `<dataDir>/plugins/registry.json`、`plugin-data/<pluginId>/<workspaceId>.json` | `AppPluginManager` | 服务端 | 非对话状态 |
| 上传/导入暂存 | `<agentDir>/imports/`、`<agentDir>/skills/`（默认 `<dataDir>/agent/…`） | 资源导入路由 | 导入流程 | 暂存后由 Pi package 安装接管 |
| 运行期内存 | 进程内 | Coordinator/RuntimeRegistry/ToolAuthorization | 同上 | 崩溃即失（P0 缺陷来源） |

## 5. 关键设计取舍

1. **进程内 SDK 而非独立内核进程**：没有 RPC、没有第二个 Node 进程，调试简单、启动快；代价是内核与工作台共享事件循环与权限（见 02 的缺陷）。
2. **事件协议是前后端唯一契约**：REST 只做命令与查询，实时状态全走 WS + `applyEvent`；好处是前端只实现一次合并逻辑，坏处是服务端必须先投影再广播（写放大，S3 处理）。
3. **声明式 app plugin**：插件只提供 manifest（字段/视图/导航），没有用户代码执行；真正的"可执行扩展"仍走 Pi extension（jiti，宿主权限）。
4. **本地单用户信任模型**：服务只监听 `127.0.0.1`，校验 Host/Origin/同源；没有通用 token、没有多用户、没有 OS 沙箱。
5. **桌面壳只做生命周期**：Electron 不碰业务，只负责端口、数据目录、`workspace-roots.txt`、窗口控制与退出清理。

## 6. 与代码的核对入口

| 声明 | 代码 |
|---|---|
| 组合根 | `apps/server/src/bootstrap/create-app.ts` |
| 单会话状态机 | `apps/server/src/sessions/coordinator.ts` |
| Pi 唯一接缝 | `apps/server/src/sessions/pi-runtime.adapter.ts` |
| 事件投影 | `apps/server/src/sessions/event-projector.ts`、`apps/server/src/store.ts` |
| 前后端契约 | `apps/shared/src/protocol.ts`、`apps/web/src/features/chat/useSession.ts` |
| 安全钩子 | `apps/server/src/bootstrap/create-app.ts` 的 `onRequest`、`apps/server/src/security.ts` |
| 桌面生命周期 | `desktop/src/main.ts`、`desktop/src/preload.ts` |
| 形态与端口 | `scripts/dev-web.mjs`、`apps/web/vite.config.ts`、`apps/server/src/main.ts` |

## 7. 已知与图不一致的地方（S0 修复）

- 图与文档不再出现 `desktop/src-tauri/`（已删除）与 `PI_CONSOLE_TOKEN`（代码 0 读取）。
- Node 版本统一为 `>=22.19.0`（`engines`），不再写"必须 24.3+"。
- 运行期 id 不一致（`pi-events.ts` 用 `randomUUID()`、`transcript.ts` 用 `entry.id`）在 S0/S3 修，修前不要在文档里承诺"id 稳定"。
