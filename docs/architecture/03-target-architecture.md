# 03 目标架构（自研内核 + 可替换适配器）

> 对应图：`03-target-architecture.svg`（风格同用户给定的目标架构图：四个 surface → 会话协议 v2 → 自研内核 → 适配器 → 存储/沙箱/工作区）。
> 本文是**目标**，不是现状。现状见 `01`/`02`；执行顺序见 `04-roadmap.md` 与 `stages/`。

## 1. 一句话

用绞杀者（Strangler Fig）模式，**不重写 Pi，而是把内核所有权逐步搬到 `packages/kernel-*`**：每一步都保持工作台可发布，Pi 逐步退化为一个可删除的 adapter。

## 2. 图的结构（自上而下五层）

```
四个 surface：Web 工作台 / Desktop 宿主 / CLI+IDE / 第三方 API
        ↓ 同一个会话协议 v2（版本协商、请求关联、多订阅者、resume cursor、事件 schema 显式版本）
自研内核 packages/kernel-*
   AgentLoop · ContextManager · ToolPlane · PolicyEngine
   ModelGateway · EventLog · Orchestrator · Telemetry
        ↓ 只通过端口调用
适配器 packages/adapters-*
   Provider SDKs · MCP · Skills/AGENTS · Remote SSH · Browser · Legacy Pi（过渡期）
        ↓
Event Store / Checkpoints / Sandbox Runtime / Workspace
```

## 3. 八个内核模块（各自"所有者"职责）

| 模块 | 拥有什么 | 不做什么 |
|---|---|---|
| `kernel-contracts` | 事件 schema、端口接口、错误类型（版本化） | 不依赖任何具体 provider/存储 |
| `kernel-events` → `kernel-store` | 事件 append-only 日志、checkpoint、resume | 不做 UI 投影（投影由工作台做） |
| `kernel-context` | 上下文预算、token 估算（CJK 感知）、压缩（cache-safe）、结果 spill | 不直接调模型 |
| `kernel-tools` | 工具注册表、loadout、tool-search、结构化诊断 | 不实现具体工具（由 adapters/工作台注入 `operations`） |
| `kernel-policy` | `tool:path/cmd` 规则、持久审批、显式启用、egress/密钥隔离 | 不执行进程 |
| `kernel-sandbox` | 进程/文件系统隔离（Windows Job Object + WSL2 / macOS Seatbelt / Linux Landlock） | 不做策略判断 |
| `kernel-gateway` | provider 路由、fallback、缓存语义、成本模型、预算 | 不保存凭据（用 adapter 注入） |
| `kernel-loop` | turn 状态机、流式、并行工具、steering、abort、重试分类 | 不认识 Pi 的类 |
| `kernel-orchestrator` | run 队列、并发、subagent/workflow、worktree 并行 | 不做 UI 呈现 |
| `kernel-telemetry` | OTel GenAI span、8 项 harness 指标、任务级 eval | 不做存储后端实现 |

（图中把 `kernel-contracts/events/store` 合并为 `EventLog`，`telemetry` 单列；包的实际拆分以本表为准。）

## 4. 适配器层（薄、可替换、可退役）

| 适配器 | 存在理由 | 退役条件 |
|---|---|---|
| `adapters-providers` | 官方 SDK（anthropic/openai/google/…）与 `pi-ai` 的 api 层复用 | 当 gateway 的 provider 接口稳定且自研 wire 覆盖目标模型 |
| `adapters-mcp` | MCP 协议实现是 commodity | 永久保留（协议本身不是差异化） |
| `adapters-skills` | Skills/AGENTS 语义保留，实现迁入 ContextManager | 语义被 kernel-context 原生支持后 |
| `adapters-remote` | `pi-env` SSH daemon 已是端口 | 保留，必要时换自研 daemon |
| `adapters-browser` | Playwright 实现 | 保留 |
| `adapters-legacy-pi` | 过渡期把 `AgentSession` 包成 `AgentLoop` 端口的一个实现 | S9 完成后删除 |

**硬规则**：`pi` 只允许出现在 `adapters/pi`；删除它不影响 `packages/kernel-*` 的编译与测试。

## 5. 包布局与依赖门禁

```
packages/
├── kernel-contracts/    # 类型与端口，零依赖
├── kernel-events/       # 事件日志（append-only）
├── kernel-store/        # checkpoint / resume（唯一碰 SQLite 的 kernel 包）
├── kernel-context/      # 预算、压缩、spill
├── kernel-tools/        # 注册表与 loadout
├── kernel-policy/       # 规则与审批
├── kernel-sandbox/      # 唯一允许起子进程的 kernel 包
├── kernel-gateway/      # provider 路由与成本
├── kernel-loop/         # turn 循环
├── kernel-orchestrator/ # run 队列与 workflow
├── kernel-telemetry/    # OTel 与指标
├── kernel-testkit/      # faux provider、golden traces、契约测试
└── adapters/
    ├── providers/  mcp/  skills/  remote/  browser/  legacy-pi/
```

门禁（`scripts/check-entry-graphs.mjs` 扩展，S0 起生效）：

1. `kernel-*` 不得 import `pi-*`、`fastify`、`zod`（contracts 除外）、`apps/*`；
2. 只有 `kernel-store` 可以 import `node:sqlite`；
3. 只有 `kernel-sandbox` 可以 `child_process`；
4. `apps/*` 不得 import `packages/coding-agent/src/core/*` 深路径；
5. 依赖图必须无环（现有 `check-entry-graphs.mjs` 扩展）。

## 6. 六条过渡期约束（图中的右栏）

1. **双轨一致性**：同一组 golden traces 同时跑 `pi adapter` 与自研实现，输出差异必须可解释。
2. **每阶段一个 flag**：`PI_KERNEL_*` 开关，可整层回退；开关默认关闭直到该阶段验收。
3. **依赖方向门禁**：见 §5，违规即 `npm run check` 失败。
4. **单一事实来源先行**：先换 store（S3），再换 loop（S9）。
5. **先度量后替换**：没有指标证明收益，不进入下一阶段（`04-roadmap.md` 的指标表）。
6. **生态兼容**：pi 扩展走 shim，不破坏用户现有 skills/packages（S7 的黄金扩展集）。

## 7. 与现状的差别（图底部三条）

1. 内核从"一个 4398 行的类"变成独立包集合：有显式端口与版本化协议，可独立测试、独立发布、按层替换。
2. 沙箱、事件日志、上下文预算、可观测性成为内核一等公民，而不是工作台外挂。
3. Pi 只保留在 `adapters/pi` 与 provider SDK 适配中；删掉它不影响产品；多客户端共享同一协议，Web/Desktop/CLI 不再是三种私有实现。

## 8. 非目标（明确不做）

微服务化、Redis/MQ/向量库、第二套 Agent 框架、默认多代理（token 约 15×、隐式决策冲突）、为 CRUD 造 Repository、把 tags 当认证、把 Tauri 找回来。
