# 运行时候选评估（阶段 2）

状态：决策完成，未安装候选依赖
日期：2026-11-04

## 1. 评估口径

每个候选记录：

- 许可证：是否允许闭源/商业分发，是否有 copyleft 传染。
- 维护状态：最近发布、提交活跃度、是否维护分支。
- 适配成本：接入 API、替换现有抽象、测试、回滚所需人日。
- 运行约束：Node 版本、原生模块、WASM、进程模型。
- 结论：采用、回退、仅记录。

人日为粗略估算，按 1 人熟悉当前代码库计算。阶段 2 只做 API 对照和代码走查，不安装依赖，避免改动 lockfile。

## 2. MCP

### 2.1 候选 A：官方 TypeScript SDK v2

| 项 | 值 |
|---|---|
| 包 | `@modelcontextprotocol/client` / `server` / `core` |
| 版本 | 2.4.0（2026-10-23） |
| 许可证 | Apache-2.0（新贡献）；仓库含 MIT 旧代码 |
| Node | >=20 |
| 维护 | 官方当前稳定线，2026-07-28 规范 |
| 传输 | stdio、Streamable HTTP、OAuth、Node/Bun/Deno |
| 适配成本 | 中，约 3–5 人日 |

适配面：

- 新 `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport`。
- `listTools()` / `callTool()` 的返回结构与现有 `McpToolInfo`/`McpCallResult` 接近，但内容块和错误类型需要映射。
- OAuth 使用 `AuthProvider`/`OAuthClientProvider`；现有 `packages/mcp/src/oauth/*` 需要改接或删除。
- 连接生命周期、关闭、超时、取消需要按新 API 重写 `connectServer`。
- 传输实现可删除，`McpToolClient` 和 `createMcpNativeTools` 保持。

风险：

- v2 是较新的稳定线，边缘行为（会话恢复、SSE 重连、OAuth 刷新）需要真实服务器验证。
- 包拆分后 API 与 v1 差异大，迁移文档需要逐项对照。

### 2.2 候选 B：官方 TypeScript SDK v1

| 项 | 值 |
|---|---|
| 包 | `@modelcontextprotocol/sdk` |
| 版本 | 1.32.2 |
| 许可证 | MIT |
| Node | >=18 |
| 维护 | v1 维护线，v2 发布后至少 6 个月安全/缺陷修复（至 2027-01 左右） |
| 传输 | stdio、Streamable HTTP、HTTP+SSE、OAuth |
| 适配成本 | 低–中，约 2–3 人日 |

适配面与 v2 类似，但使用 `@modelcontextprotocol/sdk/client/index.js`、`client/stdio.js`、`client/streamableHttp.js`。生态示例多，行为成熟；代价是维护线而非当前主线。

### 2.3 决策

主选 v2.4.0，回退 v1.32.2。

理由：

- 项目要求“优先官方 SDK”，v2 是官方当前稳定线，生命周期更长。
- 现有 `McpToolClient` 很小，替换客户端不会影响 kernel 和工具转换。
- 2 天时间盒内如果 OAuth/传输无法达到现状，立即切 v1，不保留双实现。

拒绝：

- 继续维护 `packages/mcp` 自定义 JSON-RPC 客户端：协议面扩大后维护成本高于官方 SDK。
- 只换传输、保留自定义客户端：仍是半套实现，不能解决协议演进。

## 3. 沙箱

### 3.1 候选 A：保留 `quickjs-wasi` + Worker

| 项 | 值 |
|---|---|
| 包 | `quickjs-wasi` |
| 版本 | 已装 3.6.2；最新 3.6.3 |
| 许可证 | MIT |
| 运行 | WASM，无原生编译；Node >=22 |
| 维护 | 活跃发布 |
| 适配成本 | 低，约 1–2 人日（加固与测试） |

现状：

- `packages/sandbox` 已实现 host + 每次执行新建 `node:worker_threads` Worker + 新 QuickJS VM。
- 支持 `timeoutMs`、`memoryLimitBytes`、`AbortSignal`、嵌套只读工具、JSON 返回。
- 已有 `CodemodeSandbox` 测试与 `createCodemodeNativeTool` 适配。

风险：

- QuickJS 与宿主之间是 JSON 桥，超大对象有序列化成本。
- 需要继续验证内存上限、abort、worker 退出和 wasm 缺失路径。

### 3.2 候选 B：`quickjs-emscripten`

| 项 | 值 |
|---|---|
| 包 | `quickjs-emscripten` |
| 版本 | 0.32.0 |
| 许可证 | MIT |
| 运行 | WASM，多 variant；Node >=? 需按 variant 确认 |
| 维护 | 仓库活跃（2026 年仍有提交），GitHub 无正式 releases |
| 适配成本 | 中–高，约 4–6 人日 |

适配面：

- 需要选择 wasm variant 并处理打包资源。
- 需要重写 host bridge（`newRuntime`、`setMemoryLimit`、`setInterruptHandler`、`evalCode`/asyncify）。
- 现有 `CodemodeSandbox` 的 worker 协议、工具调用、输出/错误模型都要重做。
- 收益仅是替换底层 VM 封装，安全模型不变。

### 3.3 拒绝的方案

- `isolated-vm`：原生编译，跨平台安装成本高，和“无新增原生依赖”冲突。
- 远程沙箱/容器：违反本地单进程和“嵌入项目”的要求。
- `vm2`：已停止维护，历史沙箱逃逸问题多。

### 3.4 决策

保留 `quickjs-wasi` + Worker，不替换。阶段 4 只做边界加固和测试，不重写执行模型。

## 4. 模型层

### 4.1 候选 A：保留现有 `packages/model` + `ModelGateway`

| 项 | 值 |
|---|---|
| 代码 | `packages/model`，约 199 文件 / 27k 行 |
| 许可证 | 仓库 MIT（含上游 MIT 归属） |
| 依赖 | 官方 provider SDK：OpenAI、Anthropic、Google、Bedrock 等 |
| 适配成本 | 低，约 0.5–1 人日（契约收口） |

现有能力：

- 多 provider、OAuth、API key、Bedrock、代理、自定义 headers。
- 模型目录、context window、thinking level、usage/cost。
- `ModelGateway` 已把 provider 流映射为 `NativeModelEvent`。
- server 的 `NativeModelRuntime` 负责凭据与模型选择。

风险：

- 27k 行自有维护成本高，provider API 变更需要跟进。
- 但这属于“模型传输”而非 agent 运行时，替换收益不等于风险。

### 4.2 候选 B：Vercel AI SDK

| 项 | 值 |
|---|---|
| 包 | `ai` |
| 版本 | 7.0.162（2026-11-03） |
| 许可证 | Apache-2.0 |
| Node | >=22 |
| 维护 | 非常活跃 |
| 适配成本 | 高，约 8–15 人日 |

适配面：

- `streamText`、`tool`、provider 包、消息/part 模型与现有 `NativeMessage` 不同。
- 需要重做 OAuth（Anthropic/OpenAI 订阅登录）、Bedrock、代理、自定义 headers。
- 需要重做模型目录、context window、thinking、usage/cost、错误分类。
- 现有 `packages/model` 的 provider 兼容层和测试大部分不能复用。

结论：只记录，不在 1.2.1 采用。若未来要减少自有 provider 代码，先做独立分支的 2 周 spike，不阻塞当前版本。

### 4.3 候选 C：直接使用各 provider 官方 SDK

这就是现状。保留。

### 4.4 决策

保留现有模型层，阶段 5 只做契约封装、错误分类和 usage 规范化。不引入 Vercel AI SDK。

## 5. 汇总

| 层 | 采用 | 回退 | 不采用 | 预计人日 |
|---|---|---|---|---:|
| 模型 | 现有 `packages/model` | 无 | Vercel AI SDK | 0.5–1 |
| MCP | 官方 v2.4.0 | 官方 v1.32.2 | 自定义客户端 | 3–5 |
| 沙箱 | `quickjs-wasi` + Worker | 无 | quickjs-emscripten / isolated-vm / 远程 | 1–2 |

## 6. 阶段 2 未验证项

以下必须在阶段 3/4 用代码验证，不能只凭文档下结论：

- MCP v2 的 OAuth 刷新、Streamable HTTP 重连、服务器崩溃行为。
- MCP v2 内容块与现有 `McpContentBlock` 的完整映射。
- `quickjs-wasi` 内存上限在 64 MiB 下的实际错误形态。
- 连续 100 次沙箱执行的 worker/内存泄漏。
- 模型错误分类对现有 UI 提示的影响。

## 7. 参考

- https://github.com/modelcontextprotocol/typescript-sdk
- https://www.npmjs.com/package/@modelcontextprotocol/client
- https://www.npmjs.com/package/@modelcontextprotocol/sdk
- https://github.com/justjake/quickjs-emscripten
- https://www.npmjs.com/package/quickjs-wasi
- https://github.com/vercel/ai
- https://www.npmjs.com/package/ai
