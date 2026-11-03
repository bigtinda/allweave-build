# 02 内核架构（现状事实 + 缺陷证据）

> 对应图：`02-kernel-architecture.svg`。核实时间 2026-11-03。
> 证据来源：`docs/audit/kernel-map.md`（行号级审计，602 行）。

## 1. 这张图画了什么

三层：

- **L1 工作台**（`apps/server`）：会话编排、事件投影、工具注入、传输。它**不该知道内核内部**，但当前有 12 个文件直接 `import @earendil-works/*`。
- **L2 接缝**：`pi-runtime.adapter.ts` 是名义上的唯一接缝，实际上 `pi-ai`、`pi-agent-core`、`chord`、`pi-env` 从别的文件漏了进来（5 包 / 26 符号 / 33 处）。
- **L3 内核**：`packages/coding-agent` 的 `AgentSession`（4398 行）+ `pi-ai` 模型网关 + 工具面 + 扩展宿主 + 会话持久化。

## 2. AgentSession 的 22 个职责区间（行长 = 债务）

`packages/coding-agent/src/core/agent-session.ts`，4398 行，一个类同时是：

| 区间 | 职责 |
|---|---|
| 196–237 | 事件契约（`AgentSessionEvent`，冻结） |
| 246–364 | 配置类型 |
| 378–483 | 私有字段 |
| 485–526 | 构造装配 |
| 528–651 | 模型与鉴权 |
| 652–764 | 工具拦截 |
| 767–844 | 请求投影、压缩阈值 |
| 846–932 | 边界生命周期 |
| 934–1100 | 事件发射 |
| 1103–1281 | **持久化（在事件回调里直接写 JSONL）** |
| 1284–1362 | 扩展事件映射 |
| 1369–1414 | dispose |
| 1416–1813 | 工具装载、系统提示重建 |
| 1818–2451 | **Prompting 外层二次循环** |
| 2453–2600 | 模型切换 |
| 2602–2712 | thinking 等级与队列 |
| 2714–3256 | **压缩三入口 + 实现** |
| 3258–3700 | **扩展绑定（30 个回调暴露给扩展）** |
| 3701–3827 | 自动重试 |
| 3828–3934 | bash 执行 |
| 3935–4160 | 树导航（rewind/branch） |
| 4161–4336 | 统计导出 |

## 3. 五条耦合证据（不是风格问题，是拆不动的原因）

1. **两层循环**：`packages/agent/src/agent-loop.ts:163` 已有一层循环，`AgentSession._runAgentPrompt`（1818–2451）又包一层；`_queueSteer`（2238）两侧都写队列。
2. **持久化在事件回调**：1103 / 1144–1185 在事件处理里直接 `append` JSONL——所以"改事件"等于"改持久化"。
3. **压缩触发散落四处**：776 / 838 / 905 / 1884，阈值判断与执行分离。
4. **扩展反向依赖**：`_bindExtensionCore`（3360–3493）把 30 个回调交给扩展，扩展可 `setModel`（3429）——扩展能改内核状态。
5. **提示词 × 工具装载耦合**：`_preparePromptAndToolLoadout`（1738）一次决定两件事，导致"换工具集"会破坏 prompt 前缀缓存。

## 4. 内核里"可换、难换、不能换"

| 判断 | 对象 | 理由 |
|---|---|---|
| 可换（先做） | 压缩子系统（2714–3256 + 767–844） | `prepareCompaction`（`packages/coding-agent/src/core/compaction/compaction.ts:872`）已是纯函数，`compact`（965）已 12 参，输出面只有 `CompactionResult` + 4 事件 + `appendCompaction`；工作台只用 `compactions()` 计数 |
| 可换（需先抽象） | 扩展宿主 | 反向依赖 30 个回调，必须先定义端口 |
| 可换（需适配层） | 工具面 | 薄，`operations` 注入点干净（`tool-factory.ts`），但 `tool_call` 同步 `{block}` 是安全边界 |
| 难换 | `pi-ai` 模型网关 | 20+ provider 的 wire 实现与 OAuth；语义被 `ModelRuntime` 深依赖 |
| 不能整体换 | `AgentSession` | 22 个职责互相写字段；只能逐子系统剥离 |
| 跨层契约 | `SessionManager` / JSONL（版本 3） | 既是真相源又是树操作实现，换它等于迁移全部历史会话 |

## 5. 三个硬约束（改内核前必须接受）

- **H1**：`AgentSessionEvent`（196–237）是冻结契约；工作台、测试、扩展都按它适配。
- **H2**：`tool_call` 扩展钩子必须**同步**返回 `{block}`（`apps/server/src/sessions/tool-factory.ts:110-127`）——这是"模型提议、策略决定"的执行点，异步化会打开绕过窗口。
- **H3**：Pi JSONL（`session-manager.ts:41`，版本 3）是会话历史的只读真相源；`transcript.ts:31-88` 依赖它重建。任何新存储都必须能从这里回填。

## 6. 已知缺陷（与阶段对应）

| # | 缺陷 | 证据 | 处理阶段 |
|---|---|---|---|
| P0-1 | 三套运行时并存（classic 在用，durable/protocol 未用） | `apps/` 零 import `pi-durable`/`pi-protocol`/`pi-client` | S9 收敛 |
| P0-2 | 崩溃不恢复 in-flight run 与审批 | `event-projector.ts:68-74`、`tool-authorization.ts:35` | S3 / S5 |
| P0-3 | 无 OS 沙箱 + 项目扩展自动信任 | `create-app.ts`（"No sandbox"）、`pi-runtime.adapter.ts` 的 `setProjectTrusted(true)` | S7 / S8 |
| P0-4 | 每事件写全量快照 | `event-projector.ts` 的 `project`：除 delta 外都 `saveSession` | S3 |
| P0-5 | CJK token 估算失真（`chars/4`、`CHARS_PER_TOKEN=3.5`） | `packages/coding-agent/src/core/compaction/compaction.ts:295-339`、`packages/ai/src/utils/estimate.ts:15` | S4 |
| P1-6 | 压缩请求 `cacheRetention:"none"` | 压缩实现 | S4 |
| P1-7 | 工具结果按字节截断、bash 无默认超时 | `truncate.ts`、`bash.ts:42` | S6/S8 |
| P1-8 | 无任务级评测与观测 | `pi-telemetry` 未接入 | S2 |

## 7. 与代码的核对入口

| 声明 | 代码 |
|---|---|
| 内核单体 | `packages/coding-agent/src/core/agent-session.ts` |
| 接缝 | `apps/server/src/sessions/pi-runtime.adapter.ts` |
| 工具注入与策略 | `apps/server/src/sessions/tool-factory.ts`、`apps/server/src/tool-policy.ts` |
| 压缩 | `packages/coding-agent/src/core/compaction/compaction.ts` |
| 事件适配 | `apps/server/src/sessions/pi-events.ts`、`apps/server/src/adapter.ts` |
| 会话持久化 | `packages/coding-agent/src/core/session-manager.ts`、`apps/server/src/persistence/transcript.ts` |

## 8. 读图要点

1. 蓝色大框里的东西**不是**工作台的模块，是 `packages/` 里的上游代码；工作台只能通过 L2 接缝碰它。
2. 红色标的是"同一份状态有两处写入/读取"的位置：事件 ↔ 投影、JSONL ↔ 内存 run。
3. 绿色虚线是拟删除的路径（RPC 适配、durable 分支），删除动作在 S9。
