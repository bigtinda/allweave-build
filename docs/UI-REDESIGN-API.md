# AllWeave Build 后端接口与界面重构说明

本文档面向 UI/UX 设计 agent：描述产品形态、全部后端接口、实时事件协议、数据模型，以及每个界面功能依赖哪些接口、受哪些状态和限制约束。

目标是让设计稿**只依赖真实存在的能力**，不设计服务端没有的功能（例如远程主机、多人协作、登录页）。

---

## 1. 产品与运行模型（设计前提）

| 项目 | 事实 |
| --- | --- |
| 产品 | AllWeave Build：本地单用户 AI 编程工作台（Web / Electron 共用同一前端） |
| 架构 | 单进程 Node 服务；前端只通过 `HTTP /api` + `WebSocket /ws` 访问；无独立 CLI，无 agent 子进程 |
| 存储 | SQLite（`console.sqlite`）+ 工作区文件；会话事件与审批由内核持久化 |
| 用户 | 单用户、无登录、无账号体系；服务只监听本机，校验 Host/Origin |
| 语言 | 界面以中文为主 |
| 模型 | 服务端直接调用模型供应商；浏览器永不下发 API Key |
| 桌面模式 | Electron 外壳额外提供 `POST /api/desktop/shutdown`，Web 模式没有 |

设计含义：

- 不需要设计登录、注册、团队、权限角色、云端同步、远程机器管理。
- 界面需要在**同源本地应用**的前提下工作，可假设网络极低延迟，但模型流式输出可能持续数十秒到数分钟。
- 所有破坏性操作（命令、写文件、自定义工具）默认需要用户审批。

---

## 2. 全局 API 约定

- 前缀：`/api`；WebSocket：`/ws/...`
- 编码：JSON；图片/文档以 base64 字符串传输
- 成功：`200/202` + JSON；失败：非 2xx + `{ "error": "人类可读消息" }`
- 常见状态码：
  - `400` 请求校验失败 / 前置条件不满足（如未配置模型）
  - `403` 工作区目录未授权
  - `404` 资源不存在（含审批已过期）
  - `409` 状态冲突（正在运行、文件已被外部修改、文件过大需预览等）
  - `413` 文件超过可编辑上限
  - `415` 二进制文件不可作为文本读取
  - `501` 平台不支持（文件夹选择框仅 Windows）
  - `500` 服务端错误
- 客户端请求封装（`apps/web/src/services/api.ts`）：`api<T>(path, body?, method)`；`body === undefined` 时默认 GET，否则默认 POST；POST 会触发全局“网络活动”指示。
- 动态路径参数：`id` 为 UUID（会话/工作区/审批），插件 id 为 `/^[a-z][a-z0-9-]{2,48}$/`。

---

## 3. 核心领域概念

### 3.1 工作区（Workspace / 项目）

用户授权给 agent 的本地目录。所有会话、文件、Git、插件数据都挂在某个工作区下。

```ts
Workspace {
  id: string;
  name: string;
  path: string;
  remote?: { host: string };      // 历史字段，远程工作区已移除
  kind?: "plugin-development";    // 系统内置“插件开发”工作区
}
```

- 系统工作区“插件开发”固定存在，用于开发 App 插件；它**不能创建普通会话、不能重命名、不能删除**。
- 根目录之外的目录必须显式授权（`authorize: true`）才能加入。
- 文件列表默认隐藏 `node_modules`、`.git`、`.pi`、`.allweave`、`.env`、`.env.*`。

### 3.2 会话（Session / 任务）

一次对话式任务。分为普通会话与“插件开发会话”。

```ts
AgentStatus = "idle" | "running" | "approval" | "error" | "interrupted";
ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
AccessMode = "plan" | "ask" | "auto" | "full";
```

状态语义：

| 状态 | 含义 | 界面表现 |
| --- | --- | --- |
| `idle` | 空闲，可发送新消息 | 正常输入 |
| `running` | 模型/工具执行中 | 流式输出、可中止、可 steer（追加指令） |
| `approval` | 等待用户批准工具调用 | 显示审批卡片 + 倒计时（5 分钟） |
| `error` | 上次运行失败 | 展示错误、允许重试 |
| `interrupted` | 服务重启/中断后遗留 | 展示“继续”入口（resume） |

访问模式（权限档位）：

| 值 | 名称 | 行为 |
| --- | --- | --- |
| `plan` | 计划模式 | 只读工具可用，其余拒绝；回答偏计划 |
| `ask` | 变更前确认 | 所有非只读操作都要审批 |
| `auto` | 自动编辑 | 写文件自动允许，命令等仍需审批 |
| `full` | 完全访问 | 全部允许 |

只读工具（`read`/`ls`/`find`/`grep`）在除 `plan` 外始终允许。插件开发会话只允许 `ask`。

### 3.3 审批（Approval）

```ts
Approval { id; toolCallId; name; input; expiresAt }
```

- 有效期 5 分钟；过期后服务端发 `approval.expired`，审批接口返回 404。
- 审批决定只有 `approved: true | false`。
- 同一会话可能同时存在多个审批。

### 3.4 用量（Usage）

```ts
SessionUsageRecord { id; workspaceId; title; updatedAt; model?; tokens?; lastRunUsage?; runs: RunUsage[] }
RunUsage {
  startedAt; durationMs; model?; outcome: "completed" | "aborted" | "error";
  status: "available" | "unavailable";
  tokens?: { input; output; total; cacheRead?; cacheWrite?; cost? };
  compactions?; toolResultCharacters; toolResults: { name; characters }[];
}
```

用于用量页：按会话、按天、按模型统计 token 与费用；单会话最多保留 500 条运行记录。

### 3.5 App 插件（用户自定义小型业务应用）

```ts
AppPluginManifest {
  manifestVersion: 1;
  id; name; version; description;
  fields: { id; label; type: "text"|"number"|"date"|"boolean"|"select"; required; options? }[]; // 1..24
  views: { id; title; type: "table"|"board"; groupBy? }[];                                      // 1..8
  navigation: { id; title; viewId }[];                                                          // 1..8
}
AppPluginRecord { id; values: Record<string, string|number|boolean>; createdAt; updatedAt }
InstalledAppPlugin { digest; enabled; installedAt; manifest }
AppPluginRegistry { revision; plugins: InstalledAppPlugin[] }
```

插件数据按“工作区 × 插件”隔离：每个工作区独立记录，单文件 ≤4MB、≤5000 条。

---

## 4. 接口总览（按功能域）

> 共 9 组、约 60 个端点。所有路径省略前缀 `/api`。

### 4.1 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ status: "ok", kernel: string }`，用于启动探活 |
| GET | `/settings` | 运行信息（只读），见下 |
| POST | `/desktop/shutdown` | 仅桌面模式：关闭应用（需外壳注入的 `x-allweave-shutdown-token`，不要在界面提供入口） |

`GET /settings` 返回：

```json
{
  "mode": "local-single-user",
  "roots": ["D:/work"],
  "kernel": { "version": "1.2.1", "integration": "in-process" },
  "agentDirectory": "...",
  "credentialStorage": "auth.json and models.json in the workbench configuration directory",
  "approvals": "Every command, file mutation and custom tool requires confirmation",
  "isolation": "Authorized file APIs; approved commands run with host permissions. Code-mode scripts run in an in-process QuickJS sandbox.",
  "authentication": "Server credentials and environment variables; never sent to the browser"
}
```

### 4.2 会话

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/sessions` | – | `SessionSummary[]`，按 `updatedAt` 降序，含已归档（需前端过滤） |
| GET | `/sessions/:id` | – | `SessionDetail` |
| POST | `/sessions` | `{ workspaceId, title? }` | `SessionDetail` |
| PATCH | `/sessions/:id` | `{ title }` | `SessionDetail` |
| POST | `/sessions/:id/archive` | – | `SessionSummary` |
| POST | `/sessions/:id/restore` | – | `SessionSummary` |
| DELETE | `/sessions/:id` | – | `{ deleted: true }`（必须先归档） |
| POST | `/sessions/:id/messages` | 见下 | `202 { accepted: true, title }` |
| POST | `/sessions/:id/steer` | `{ text }` | `202 { accepted: true }` |
| POST | `/sessions/:id/resume` | – | `202 { accepted: true }` |
| POST | `/sessions/:id/abort` | – | `{ stopped: true }` |
| POST | `/sessions/:id/compact` | `{ keepRecentTokens? }` | `{ compacted, dropped, estimatedTokens }` |
| POST | `/sessions/:id/recover` | – | `SessionDetail` |
| POST | `/sessions/:id/recall` | `{ messageId }` | `{ session, text, references }` |
| POST | `/sessions/:id/branch` | `{ messageId }` | `SessionDetail` |
| POST | `/sessions/:id/approvals/:approvalId` | `{ approved: boolean }` | `{ accepted: true }` |
| PUT | `/sessions/:id/model` | `{ provider, modelId, thinkingLevel? }` | `SessionDetail` |
| PUT | `/sessions/:id/access-mode` | `{ accessMode }` | `SessionDetail` |
| GET | `/usage` | – | `SessionUsageRecord[]` |
| GET | `/models?sessionId=` | – | `ModelOption[]` |
| WS | `/ws/sessions/:id?after=n` | – | 快照 + 事件流（见第 5 节） |

#### 发送消息 `POST /sessions/:id/messages`

```json
{
  "text": "把登录页改成两栏布局",
  "attachments": [{ "name": "note.md", "content": "..." }],
  "references": ["src/pages/Login.tsx"],
  "images": [{ "name": "shot.png", "mimeType": "image/png", "data": "<base64>" }],
  "interrupt": false
}
```

限制：

- `text` 1–100000 字符；`attachments` ≤6 个，每个 name ≤200、content ≤100000；`references` ≤20，每项 ≤4096；`images` ≤4 张，单张 ≤8MB，支持 png/jpeg/gif/webp。
- 第一条消息会自动生成标题（截断 48 字符）。
- `interrupt: true`：先中止当前运行，再发送新消息。
- 插件开发会话不允许文件引用。
- 未配置模型时返回 400：`未配置模型。请先配置供应商凭据并选择模型。`
- 运行中直接发送会 409（前端应改为禁用发送或走 `interrupt`）。

#### 其他会话行为

- `steer`：运行中追加一条用户指令，不打断当前流。仅 `running`/`approval` 可用。
- `resume`：仅 `interrupted` 可用，会发送固定续跑提示“继续上一次未完成的任务……”。
- `abort`：取消当前运行与待审批项，状态回 `idle`。
- `compact`：压缩上下文，运行中 409 `请先停止运行中的会话，再压缩上下文`；返回丢弃条数与估算 token。
- `recover`：会话投影损坏时从 transcript 重建，运行中 409。
- `recall`：把某条用户消息回退到输入框（回填 `text` + `references`），并中止当前运行。
- `branch`：从某条 assistant 消息处截断，形成新分支（原地重写会话）。
- `archive`：运行中 409 `请先停止 Agent，再归档会话`。
- 删除：未归档 409 `请先归档会话，再从归档管理中永久删除`。
- `GET /sessions` 返回**全部**会话（含归档，摘要里带 `archivedAt`）。主列表、归档页、用量页都由前端自行过滤，设计时需要区分“当前项目 / 全部 / 已归档”。

### 4.3 工作区与本地目录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/local-folders?path=` | 目录浏览；无 path 时返回盘符/根 |
| POST | `/local-folders/pick` | 系统文件夹选择框；仅 Windows，否则 501 |
| GET | `/workspaces` | `Workspace[]` |
| POST | `/workspaces` | `{ path, name?, authorize? }` → `Workspace` |
| PATCH | `/workspaces/:id` | `{ name }` → `Workspace` |
| DELETE | `/workspaces/:id` | `{ deleted, sessionsDeleted }` |
| GET | `/workspaces/:id/git` | `GitChanges` |
| GET | `/workspaces/:id/git/diff?path=&staged=` | `{ text, binary }` |
| POST | `/workspaces/:id/git/index` | `{ path, staged, revision }` → `GitChanges` |
| POST | `/workspaces/:id/git/commit` | `{ message, revision }` → `{ output }` |
| POST | `/workspaces/:id/git/branches` | `{ action, name, revision, base? }` → `GitChanges` |
| GET | `/workspaces/:id/files?path=.` | `FileEntry[]` |
| GET | `/workspaces/:id/file?path=&preview=` | `FileContent` |
| PUT | `/workspaces/:id/file` | `{ path, content, revision }` → `FileContent` |
| GET | `/workspaces/:id/image?path=` | `{ base64, mime }` |
| GET | `/workspaces/:id/document?path=` | `{ base64 }`（Office 预览） |

`LocalFolderListing`：

```ts
{ currentPath?: string; parentPath?: string; roots: LocalFolder[]; directories: LocalFolder[] }
```

`GitChanges`：

```ts
{
  branch: string;
  branches: string[];
  head: string;
  indexRevision: string;   // 每次变更后变化，用于提交/暂存的乐观并发
  files: { path: string; index: string; working: string; conflict: boolean }[];
}
```

`FileContent`：`{ path, content, revision, truncated? }`。

约束：

- 文本文件 >1MB 必须以 `preview=true` 读取，返回内容截断到 256KB；直接读取返回 413 `Only text files up to 1 MB can be edited`。
- 二进制返回 415。
- 保存必须带 `revision`；不匹配返回 409 `The file changed on disk. Reload before saving.`。
- 图片 ≤10MB；Office 文档 ≤20MB。
- 提交/暂存/切分支都带 `revision`；有运行中会话时切分支 409 `此项目有任务正在执行，请停止任务后切换分支。`
- 目录授权：根目录之外需 `authorize: true`，否则 403。

### 4.4 浏览器（内嵌 Chromium，按会话隔离）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sessions/:id/browser` | `BrowserSnapshot \| null` |
| POST | `/sessions/:id/browser` | 执行 `BrowserCommand`，返回新快照 |
| POST | `/sessions/:id/browser/input` | 用户交互（pointer/type/press/scroll/resize），`{ accepted: true }`，不回帧 |
| WS | `/ws/browser/:id` | `frame` / `state` / `error` 事件 |

```ts
BrowserSnapshot {
  url; title; text; image;            // image 为当前视口截图 base64
  width; height; tabId;
  tabs: { id; url; title }[];
  dialog?: { type; message; defaultValue };
  clipboard?: string;
}
```

命令集合：`navigate`、`resize`（320–1280 × 200–800）、`snapshot`、`back`、`forward`、`reload`、`close`、`click`（selector 或坐标）、`pointer`、`fill`、`hover`、`select`、`check`、`drag`、`wait`、`newTab`、`switchTab`、`closeTab`、`dialog`、`copy`、`type`、`press`、`scroll`。

设计要点：agent 与用户共享同一个页面；用户手动操作通过 `/input` 发送；截图流通过 WS 推送；多标签页需要 UI 支持。

### 4.5 模型供应商与登录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/providers` | `ProviderOption[]` |
| POST | `/provider-logins` | `{ providerId, type: "api_key" \| "oauth" }` → `ProviderLoginView` |
| GET | `/provider-logins/:id` | 轮询登录状态 |
| POST | `/provider-logins/:id/answer` | `{ answer }`（验证码/选项） |
| DELETE | `/provider-logins/:id` | 取消登录 |
| DELETE | `/providers/:providerId/credentials` | 登出 |
| POST | `/providers/custom` | 添加自定义 OpenAI/Anthropic 兼容供应商 |

`ProviderOption`：

```ts
{
  id; name;
  category: "主流模型供应商" | "中国模型与订阅计划" | "模型聚合与网关"
          | "云平台与托管服务" | "本地与自定义服务" | "其他与扩展供应商";
  modelCount; configured; authSource?;
  apiKey?: { name; interactive };
  oauth?: { name; label; subscription };
}
```

登录状态机：`running → waiting → succeeded | failed | cancelled`。

`ProviderLoginView`：`{ id, providerId, type, status, prompt?, notifications[], error? }`。

- `prompt` 可能是：文本输入、密钥输入、手动输入授权码、下拉选择。
- `notifications` 可能是：提示信息、授权链接、设备码（含验证地址/间隔/有效期）、进度。
- 登录任务保留 15 分钟，通知最多 20 条。
- 前端在 `running`/`waiting` 状态每 600ms 轮询一次，结束后停止；不要在浏览器保存密钥。

自定义供应商请求体：

```json
{
  "id": "my-gateway",
  "name": "My Gateway",
  "baseUrl": "https://example.com/v1",
  "api": "openai-completions",
  "models": [{ "id": "gpt-4o", "name": "GPT-4o", "reasoning": false, "contextWindow": 128000, "maxTokens": 8192 }]
}
```

`api` 枚举：`anthropic-messages`、`openai-completions`、`openai-responses`、`google-generative-ai`、`google-vertex`、`azure-openai-responses`、`bedrock-converse-stream`、`openai-codex-responses`、`allweave-messages`。

### 4.6 存储与资源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/storage` | 存储占用摘要 |
| POST | `/storage/compact` | 压缩数据库，返回新摘要 |
| GET | `/models?sessionId=` | 可用模型（sessionId 可选；传了会按该会话的工作区授权校验） |
| GET | `/skills?sessionId=` | 技能/扩展/诊断（sessionId 必填） |
| POST | `/skills/import` | 导入技能压缩包（≤300 文件，总 12MB） |

技能导入请求：`{ files: [{ path, base64 }] }`，`files` 1–300 项，单文件 base64 ≤10MB，请求体上限 12MB。

```ts
StorageSummary {
  categories: { id: "sessions"|"agent"|"database"|"other"; label; path; bytes; files }[];
  totalBytes;
  disk?: { totalBytes; freeBytes };
  sessions: { id; title; status; updatedAt; bytes }[];
}
Resources { skills: SkillInfo[]; extensions: string[]; diagnostics: string[] }
SkillInfo { name; description; filePath; status: "loaded" }
SkillImportResult { name; filesImported }
```

### 4.7 App 插件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/app-plugins` | `AppPluginRegistry` |
| POST | `/app-plugins/development-session` | 打开/创建插件开发会话 → `SessionDetail` |
| POST | `/app-plugins/install` | `{ manifestJson }` → 安装 |
| POST | `/app-plugins/import` | `{ workspaceId, manifestPath? }` → 从项目导入 |
| POST | `/app-plugins/:id/enable` | 启用 |
| POST | `/app-plugins/:id/disable` | 停用 |
| DELETE | `/app-plugins/:id` | 卸载 |
| GET | `/workspaces/:workspaceId/app-plugins/:pluginId/records` | 记录列表 |
| POST | 同上 | 新建记录（body = 字段值对象） |
| PATCH | `.../records/:recordId` | 更新记录 |
| DELETE | `.../records/:recordId` | 删除记录 |

插件的界面由 manifest 完全描述：字段类型（文本/数字/日期/布尔/单选）、视图（表格/看板）、导航。宿主前端负责渲染，不存在插件自定义 HTML/JS。

---

## 5. 实时协议

### 5.1 会话 WebSocket `/ws/sessions/:id?after=n`

连接后先收到完整快照：

```ts
{ type: "session.snapshot", session: SessionDetail }
```

随后是增量事件：

```ts
SessionEvent {
  type: EventType;
  sessionId; eventId; messageId?; timestamp;
  message?; tool?; conversation?; compaction?; summary?; approvals?; tokens?; tokenScale?; error?;
  recoveryRequired?; lastRunUsage?;
}
```

| 事件 | 载荷 | UI 用途 |
| --- | --- | --- |
| `session.started` | summary | 新会话建立 |
| `session.updated` | summary | 标题/模型/状态变更 |
| `session.recovered` | summary | 投影重建完成 |
| `message.delta` | `message`（部分文本/思考） | 流式渲染，按 id upsert |
| `message.completed` | `message`（含 `changedFiles`） | 落定消息、展示改动文件 |
| `tool.started` / `tool.updated` / `tool.completed` | `tool`（`status`: approval/running/completed/failed） | 工具卡片 |
| `approval.requested` | `approvals[]` + `tool` | 审批面板 |
| `approval.expired` | `approvals[]` | 关闭审批卡片 |
| `agent.status` | `summary.status` | 顶栏状态、按钮可用性 |
| `agent.error` | `error` | 错误条 |
| `context.compacted` | `compaction { dropped, estimatedTokens }` | 上下文压缩提示 |
| `conversation.rewound` | `conversation { messages, tools }` | recall 后整体替换 |
| `conversation.branched` | `conversation` | branch 后整体替换 |

客户端规则：`eventId ≤ session.sequence` 丢弃；消息按 `message.id`、工具按 `tool.id` upsert；`conversation` 覆盖整个消息/工具列表；活动日志保留 150 条。

断线重连：带 `after=<最后 eventId>` 重连，服务端补发；仍以快照为准。

一次典型对话的时序：

```
POST /sessions/:id/messages  → 202
WS  agent.status(running)
WS  message.delta × n            （流式文本/思考）
WS  tool.started                 （工具开始）
WS  approval.requested           （需要审批时）
    POST /approvals/:id          （用户允许/拒绝）
WS  tool.completed
WS  message.completed            （含 changedFiles）
WS  agent.status(idle) + session.updated（含 tokens / lastRunUsage）
```

### 5.2 浏览器 WebSocket `/ws/browser/:id`

```ts
type BrowserStreamEvent =
  | { type: "frame"; image: string; tabId; width; height }
  | { type: "state"; snapshot: BrowserSnapshot | null }
  | { type: "error"; error: string };
```

---

## 6. 数据模型（设计所需）

### 6.1 会话详情

```ts
SessionDetail {
  id; workspaceId; title; purpose?; archivedAt?;
  status: AgentStatus; updatedAt;
  model?: ModelOption; thinkingLevel; accessMode;

  messages: ChatMessage[];
  tools: ToolCall[];
  approvals: Approval[];
  activity: { id; type; timestamp; description }[];
  sequence: number;

  tokens?: { input; output; total; cacheRead?; cacheWrite?; cost? };
  tokenScale?: number;
  error?: string;
  recoveryRequired?: boolean;
  lastRunUsage?: RunUsage;
}
```

`ChatMessage`：

```ts
{
  id; role: "user" | "assistant";
  text; thinking; complete; timestamp;
  error?; changedFiles?: string[];
  input?: { text; references };        // 用户消息的原始输入
  images?: { name; mimeType; data }[];
  toolCalls?: { id; name; input }[];
  toolResults?: { toolCallId; name; output?; isError?; timestamp? }[];
}
```

`ToolCall`：`{ id; name; input; output?; status; startedAt; durationMs? }`。

`ModelOption`：`{ id; provider; name; reasoning; available }`。

### 6.2 实体关系

```
Workspace 1─n Session 1─n Message
                    1─n ToolCall 1─1 Approval
                    1─n RunUsage
                    1─n Activity
Workspace 1─n AppPluginRecord (按 plugin)
Registry 1─n InstalledAppPlugin 1─1 Manifest
```

---

## 7. 功能地图：界面任务 → 接口

| 界面能力 | 接口 |
| --- | --- |
| 启动/健康检查 | `GET /health` |
| 项目列表/新增项目/重命名/移除 | `GET/POST/PATCH/DELETE /workspaces`、`GET /local-folders`、`POST /local-folders/pick` |
| 会话列表（当前项目/全部/搜索） | `GET /sessions`（客户端过滤标题） |
| 新建会话 | `POST /sessions` |
| 打开会话、历史消息 | `GET /sessions/:id` + `WS /ws/sessions/:id` |
| 发送消息（文本/引用/附件/图片） | `POST /sessions/:id/messages` |
| 流式回答、思考过程、工具执行 | WS：`message.delta`、`tool.*`、`agent.status` |
| 中止 | `POST /sessions/:id/abort` |
| 运行中追加指令 | `POST /sessions/:id/steer` |
| 审批工具 | `POST /sessions/:id/approvals/:approvalId` + `approval.requested/expired` |
| 编辑上一条并重发 | `POST /sessions/:id/recall` |
| 从某条回答分叉 | `POST /sessions/:id/branch` |
| 重命名会话 | `PATCH /sessions/:id` |
| 归档/恢复/永久删除 | `POST .../archive`、`POST .../restore`、`DELETE /sessions/:id` |
| 切换模型/思考等级 | `GET /models`、`PUT /sessions/:id/model` |
| 切换权限档位 | `PUT /sessions/:id/access-mode` |
| 上下文压缩 | `POST /sessions/:id/compact` |
| 中断恢复 | `POST /sessions/:id/resume`、`POST /sessions/:id/recover` |
| 用量统计 | `GET /usage`、`SessionDetail.tokens/lastRunUsage` |
| 文件树/文件预览 | `GET /workspaces/:id/files`、`GET /workspaces/:id/file` |
| 编辑并保存文件 | `PUT /workspaces/:id/file`（带 revision） |
| 图片预览 | `GET /workspaces/:id/image` |
| Office 文档预览 | `GET /workspaces/:id/document` |
| Git 变更/暂存/提交/分支/差异 | `/workspaces/:id/git*` |
| 内置浏览器 | `/sessions/:id/browser`、`/ws/browser/:id`、`/browser/input` |
| 供应商配置/登录/登出 | `/providers`、`/provider-logins*`、`DELETE /providers/:id/credentials` |
| 自定义供应商 | `POST /providers/custom` |
| 技能库/导入 | `GET /skills`、`POST /skills/import` |
| 存储清理 | `GET /storage`、`POST /storage/compact` |
| 插件开发会话 | `POST /app-plugins/development-session` |
| 插件安装/启用/停用/卸载 | `/app-plugins*` |
| 插件业务数据（表格/看板） | `/workspaces/:workspaceId/app-plugins/:pluginId/records*` |

---

## 8. 现有信息架构（重构基线）

路由（`apps/web/src/App.tsx`）：

- `/` 欢迎/新建会话
- `/sessions/:id` 会话工作台
- `/skills` 技能库
- `/plugin-development` 插件开发
- `/plugins/:pluginId/:viewId` 插件业务页
- `/settings`：`providers`、`plugins`、`packages`、`storage`、`system`、`browser`、`subagents`、`usage`、`archive`

现有主要区域：

1. 左侧栏：会话搜索/列表、项目树、新建会话、主题切换、设置入口。
2. 会话页三栏：消息时间线（中）、工作区面板/文件/Git/浏览器（右）、输入区（底）。
3. 输入区：文本、`@` 文件引用、附件（≤6）、图片（≤4）、模型选择（按供应商分组、分页 10 个）、思考等级、权限档位、发送/中止。
4. 消息区：用户消息（含图片/引用/附件）、assistant 流式文本与思考折叠、工具卡片（运行/完成/失败/审批）、改动文件列表、错误、recall/branch 操作。
5. 顶部：会话标题、状态、用量、模型。
6. 设置：供应商登录矩阵、插件管理、包、存储占用、系统信息、浏览器设置、子智能体、用量（token 热力图/每日趋势/模型分布）、归档管理。其中“包 / 子智能体 / 浏览器”等子页没有对应后端接口（仅前端本地偏好或展示），重构时不要假设存在服务端数据。

注意：前端仍残留远程主机相关调用（`/remote-hosts/*`），服务端已移除；**新设计不要包含远程工作区/远程主机功能**。

---

## 9. 状态与按钮可用性矩阵（必须遵守）

| 操作 | idle | running | approval | error | interrupted |
| --- | --- | --- | --- | --- | --- |
| 发送消息 | 可用 | 409（需 `interrupt` 或禁用） | 409 | 可用 | 可用（或先 resume） |
| steer | 不可用 | 可用 | 可用 | 不可用 | 不可用 |
| abort | 不可用 | 可用 | 可用 | 不可用 | 不可用 |
| 审批 | 不可用 | 不可用 | 可用（5 分钟倒计时） | 不可用 | 不可用 |
| resume | 不可用 | 不可用 | 不可用 | 不可用 | 可用 |
| compact | 可用 | 409 | 409 | 可用 | 可用 |
| 归档 | 可用 | 409 | 409 | 可用 | 可用 |
| 删除 | 仅已归档 | – | – | – | – |
| 改模型/权限 | 可用 | 409 | 409 | 可用 | 可用 |
| recall/branch | 可用 | 会先中止 | 会先中止 | 可用 | 可用 |
| 编辑文件 | 可用 | 可用（需处理 revision 冲突） | 可用 | 可用 | 可用 |

其他约束：

- 插件开发会话：不能用 `POST /sessions` 创建；只能 `ask` 模式；不能重命名/删除。
- 同一工作区切 Git 分支前必须没有运行中的会话。
- 审批卡片需要明确展示工具名、参数、风险、剩余时间，以及“拒绝/允许”。

---

## 10. 设计可用的真实状态与文案

空态/异常态建议覆盖：

| 场景 | 后端信号 | 建议界面 |
| --- | --- | --- |
| 未配置模型 | 400 `未配置模型。请先配置供应商凭据并选择模型。` | 引导到供应商设置 |
| 会话运行中重复发送 | 409 `Agent is already running` | 输入区禁用或提示“追加/打断” |
| 归档运行中会话 | 409 `请先停止 Agent，再归档会话` | 归档按钮禁用 + 提示 |
| 删除未归档会话 | 409 `请先归档会话，再从归档管理中永久删除` | 删除入口仅在归档页 |
| 文件被外部修改 | 409 `The file changed on disk. Reload before saving.` | 冲突对话框：重新加载/覆盖 |
| 文件过大 | 413 `Only text files up to 1 MB can be edited` | 只读预览模式 |
| 二进制文件 | 415 | “无法以文本打开” |
| 目录未授权 | 403 | 授权确认弹窗 |
| 审批过期 | 404 `Approval expired or not found` | 收起卡片并提示已过期 |
| 服务重启导致中断 | status `interrupted` / `recoveryRequired` | “继续任务”/“修复会话” |
| 插件开发工作区 | `kind: "plugin-development"` | 特殊入口，不显示“新建会话/重命名/删除” |

---

## 11. 明确的“不要设计”清单

后端不存在、不要出现在新界面：

- 登录/注册/账号/团队/成员/角色
- 云端同步、远程工作区、远程主机、SSH
- 多用户实时协作、分享链接
- 会话导出为文件（无接口）
- 插件自定义页面/脚本（插件只能由 manifest 描述字段与视图）
- 终端模拟器（工具命令输出只作为工具结果展示）
- 通用文件上传（仅技能导入与消息附件/图片）
- 修改系统设置（`/settings` 只读；没有写入接口）
- 设置里的“包管理 / 子智能体 / 浏览器”没有后端接口，只能做本地偏好或静态说明

---

## 12. 附录：完整端点清单

```
GET    /api/health
GET    /api/settings
POST   /api/desktop/shutdown                (desktop only)

GET    /api/sessions
GET    /api/usage
POST   /api/sessions
GET    /api/sessions/:id
PATCH  /api/sessions/:id
POST   /api/sessions/:id/archive
POST   /api/sessions/:id/restore
DELETE /api/sessions/:id
POST   /api/sessions/:id/messages
POST   /api/sessions/:id/steer
POST   /api/sessions/:id/resume
POST   /api/sessions/:id/abort
POST   /api/sessions/:id/compact
POST   /api/sessions/:id/recover
POST   /api/sessions/:id/recall
POST   /api/sessions/:id/branch
POST   /api/sessions/:id/approvals/:approvalId
PUT    /api/sessions/:id/model
PUT    /api/sessions/:id/access-mode

GET    /api/local-folders
POST   /api/local-folders/pick
GET    /api/workspaces
POST   /api/workspaces
PATCH  /api/workspaces/:id
DELETE /api/workspaces/:id
GET    /api/workspaces/:id/git
GET    /api/workspaces/:id/git/diff
POST   /api/workspaces/:id/git/index
POST   /api/workspaces/:id/git/commit
POST   /api/workspaces/:id/git/branches
GET    /api/workspaces/:id/files
GET    /api/workspaces/:id/file
PUT    /api/workspaces/:id/file
GET    /api/workspaces/:id/image
GET    /api/workspaces/:id/document

GET    /api/sessions/:id/browser
POST   /api/sessions/:id/browser
POST   /api/sessions/:id/browser/input

GET    /api/providers
POST   /api/provider-logins
GET    /api/provider-logins/:id
POST   /api/provider-logins/:id/answer
DELETE /api/provider-logins/:id
DELETE /api/providers/:providerId/credentials
POST   /api/providers/custom

GET    /api/storage
POST   /api/storage/compact
GET    /api/models
GET    /api/skills
POST   /api/skills/import

GET    /api/app-plugins
POST   /api/app-plugins/development-session
POST   /api/app-plugins/install
POST   /api/app-plugins/import
POST   /api/app-plugins/:id/enable
POST   /api/app-plugins/:id/disable
DELETE /api/app-plugins/:id
GET    /api/workspaces/:workspaceId/app-plugins/:pluginId/records
POST   /api/workspaces/:workspaceId/app-plugins/:pluginId/records
PATCH  /api/workspaces/:workspaceId/app-plugins/:pluginId/records/:recordId
DELETE /api/workspaces/:workspaceId/app-plugins/:pluginId/records/:recordId

WS     /ws/sessions/:id?after=n
WS     /ws/browser/:id
```
