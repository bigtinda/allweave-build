# 运行时端口契约（阶段 1）

状态：冻结，供阶段 3–5 实现
日期：2026-11-04
适用版本：1.2.1

## 1. 分层

```text
packages/kernel
  NativeModelGateway / NativeTool / NativeMessage / NativeUsage
        ^
        | 只依赖这些类型
packages/kernel-adapters
  ModelPort / McpPort / SandboxPort 的实现
        ^
        | 第三方 SDK 只出现在这里
packages/model | 官方 MCP SDK（kernel-adapters 内） | packages/sandbox
```

规则：

- kernel 不 import `@allweave/model`、`@allweave/sandbox`、`@modelcontextprotocol/client` 或任何 provider SDK。
- 第三方类型不能出现在 `NativeModelRequest`、`NativeTool`、`NativeToolResult` 中。
- 端口错误必须可分类；原始错误文本保留在 `message`/`cause` 中，不要求 kernel 解析。
- 所有端口方法都接受 `AbortSignal`，取消必须传递到最底层并释放资源。

## 2. 模型端口

现有 kernel 契约（`packages/kernel/src/engine/types.ts`）保持不变：

```ts
export interface NativeModelRequest {
  system: string;
  messages: NativeMessage[];
  tools: NativeTool[];
  signal: AbortSignal;
}

export type NativeModelEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "done"; result: NativeModelResult }
  | { type: "error"; error: string };

export interface NativeModelGateway {
  stream(request: NativeModelRequest): AsyncIterable<NativeModelEvent>;
}
```

适配层新增统一错误与能力描述；不改变 kernel 的事件类型：

```ts
export type ModelErrorKind =
  | "auth"
  | "rate_limit"
  | "context_length"
  | "network"
  | "aborted"
  | "provider";

export interface ModelErrorInfo {
  kind: ModelErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
  provider?: string;
  model?: string;
}

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsPromptCache: boolean;
}
```

映射要求：

| 场景 | kind | retryable |
|---|---|---|
| 401/403、凭据缺失 | `auth` | false |
| 429、配额 | `rate_limit` | true |
| 上下文超限 | `context_length` | false |
| DNS/连接重置/5xx | `network` | true |
| 调用方取消 | `aborted` | false |
| 其他 provider 错误 | `provider` | false |

`NativeUsage` 保持现有字段：`input`、`output`、`cacheRead?`、`cacheWrite?`、`total`、`cost?`。缺失值不要填 0；累计由 gateway 在一次 run 内完成。

验收：

- 文本、thinking、tool call、usage、abort、provider 错误六类测试。
- kernel 中 `rg '@allweave/model'` 为空。

## 3. MCP 端口

MCP 适配层对内核只暴露 `NativeTool`。内部客户端契约保持当前结构：

```ts
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
}

export interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpToolClient {
  listTools(): Promise<McpToolInfo[]>;
  callTool(
    name: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallResult>;
}
```

连接层：

```ts
export interface McpConnection {
  name: string;
  client: McpToolClient;
  close(): Promise<void>;
}

export interface McpConnector {
  connect(name: string, config: McpServerConfig, signal: AbortSignal): Promise<McpConnection>;
}

export interface McpManager {
  tools: NativeTool[];
  diagnostics: string[];
  close(): Promise<void>;
}
```

映射要求：

- 工具名：`mcp__<server>__<tool>`，只保留 `[A-Za-z0-9_-]`，总长不超过 64。
- `readOnlyHint === true` 才标记只读；未知注解按可写处理。
- 内容块：`text` 直接拼接；`image`/`audio` 渲染为占位文本；`resource_link`/`resource` 渲染为 URI/文本；未知类型渲染为 `[type]`。
- `structuredContent` 追加为 JSON 文本。
- `isError` 透传，不把工具错误升级为连接错误。
- 单服务器连接失败只写 `diagnostics`，不阻止其他服务器。
- `close()` 幂等；关闭后调用工具返回规范化错误。

配置：

- agent 级：`<agentDir>/mcp.json`
- 项目级：`<cwd>/.allweave/mcp.json`（阶段 3 从 `.pi/mcp.json` 迁移）
- 合并规则：项目覆盖同名服务器；`enabled: false` 删除；缺 `command`/`url` 记录诊断并删除。

验收：

- stdio 握手、列表、调用、服务器退出。
- HTTP 头透传、401、超时。
- OAuth 未授权 → 授权 → 重连。
- 关闭幂等；关闭后调用报错。
- 单服务器失败不影响其他服务器。

## 4. 沙箱端口

执行契约保持 `CodemodeSandbox` 的语义，适配层只暴露一个工具：

```ts
export interface SandboxExecuteInput {
  code: string;
  signal: AbortSignal;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

export type SandboxErrorKind = "script" | "timeout" | "aborted" | "sandbox";

export interface SandboxError {
  kind: SandboxErrorKind;
  name?: string;
  message: string;
  stack?: string;
}

export type SandboxExecuteResult =
  | {
      ok: true;
      value: unknown;
      output: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      calls: Array<{ name: string; status: "ok" | "error" | "cancelled"; durationMs: number }>;
    }
  | {
      ok: false;
      error: SandboxError;
      output: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      calls: Array<{ name: string; status: "ok" | "error" | "cancelled"; durationMs: number }>;
    };

export interface SandboxPort {
  execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
  close(): Promise<void>;
}
```

不变量：

1. 每次执行使用新的 Worker 和新的 QuickJS VM；不复用 VM。
2. 脚本不能访问 `fs`、`net`、`process`、`child_process`、`fetch`、`WebSocket`、`import()`。
3. 只注入显式传入的只读工具；写工具在构造 `CodemodeSandbox` 前过滤。
4. 超时、内存上限、调用方 abort 都以终止 worker 结束；不能只靠脚本自觉退出。
5. 返回值必须 JSON 可序列化；函数、Symbol、循环引用、BigInt 返回 `script` 错误。
6. 宿主工具抛错在脚本中变成 `Error`，脚本可选择捕获；未捕获则整次执行失败。
7. `close()` 幂等；关闭后执行返回 `aborted` 或 `sandbox` 错误，不挂起。

默认值：

| 参数 | 默认 |
|---|---|
| `timeoutMs` | 适配层 60_000；`CodemodeSandbox` 宿主默认 300_000 |
| `memoryLimitBytes` | 64 MiB |
| 嵌套工具 | 仅 `readOnly === true` |
| worker | 每次执行新建，结束后 terminate |

验收：

- 无限循环触发 `timeout`。
- 大数组分配触发内存错误或 `sandbox`。
- abort 在 1 秒内结束。
- 写工具不可见。
- 工具抛错、返回非 JSON、worker 启动失败、wasm 缺失。
- 连续执行 100 次后无 worker 泄漏。

## 5. 错误与日志

- 端口只返回分类错误；UI 展示 `message`，日志可记录 `cause`。
- 不记录 API key、Authorization、OAuth code、完整工具输入（含密钥时）。
- MCP 诊断包含服务器名和阶段（connect/list/call/close），不包含环境变量值。
- 沙箱错误包含脚本栈，但不包含宿主路径以外的敏感信息。

## 6. 验收矩阵

| 层 | 单元 | 集成 | 回归 |
|---|---|---|---|
| 模型 | 事件映射、usage、错误分类 | 两轮工具调用、abort | 现有 server 测试 |
| MCP | 内容/名称/注解映射 | 本地 stdio + HTTP + OAuth | `createMcpManager` 调用方不变 |
| 沙箱 | 超时/内存/取消/序列化 | 嵌套工具、写工具过滤 | codemode 工具测试 |

## 7. 变更规则

- 修改端口签名必须先更新本文档，再改实现。
- 不允许在 kernel 中为适配器加分支（例如 `if (provider === ...)`）。
- 不允许为了兼容旧实现保留两套 MCP 客户端；替换用提交回滚。
- 新增第三方依赖必须固定精确版本，并通过 `check:pinned-deps` 与 `check:runtime-deps`。
