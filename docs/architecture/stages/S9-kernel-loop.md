# S9 内核 loop 与编排 — 交棒完成

> 图：`S9-kernel-loop.svg`。周期 5 周。内核动作：把"两层循环 + 两套队列"合成一个 `RunController`，pi 的循环降级为 adapter，编排从第三方扩展收进 `Orchestrator`。

## 1. 一句话目标

让工作台只依赖一个循环所有者与一套消息队列：`RunController` 决定一轮怎么跑、什么时候继续、steer 插在哪；`engine=pi` 与 `engine=own` 是同一个端口的两个实现，可以逐任务切换并逐事件对拍。

## 2. 修改前架构

- 现状图：`S9-kernel-loop.svg` 左半部分。
- 代码入口：`packages/agent/src/agent-loop.ts:163`（`runLoop`）、`packages/coding-agent/src/core/agent-session.ts:1822`（`_runAgentPrompt`）、`:2238`（`_queueSteer`）、`packages/agent/src/agent.ts:191-192`（两套队列）、`apps/server/src/packages.ts:17`（`npm:pi-subagents`）。
- 现状问题（证据）：
  1. 两层循环各自持有退出条件：`runLoop` 里外层 `while (true)`（`agent-loop.ts:179`）、内层 `while (hasMoreToolCalls || pendingMessages.length > 0)`（`:183`）；外面还套着 `AgentSession._runAgentPrompt` 的 `while (!this._agentRunAbortRequested)`（`agent-session.ts:1833`），中间夹 `agent.prompt`（`:1832`）与 `agent.continue()`（`:1836`、`:1841`）。一次 abort 要同时满足两处判定才真正停下。
  2. steer 写两处：`agent-session.ts:2239` 先 `this._steeringMessages.push(text)`，`:2245` 再 `this.agent.steer({...})`，而 `Agent` 自己还有 `steeringQueue`（`agent.ts:191`）。队列顺序由两条写入路径的时序决定，前端能看到两种 `queue_update`。
  3. 编排是外部扩展：`apps/server/src/packages.ts:17` 默认安装 `npm:pi-subagents`，子代理的 spawn/等待/恢复全在第三方代码里，宿主没有事件日志可依，进程重启后无法恢复。
  4. 交棒点缺失：`AgentSession.prompt()` 是唯一入口（`agent.ts:371-384` 转发到 `runLoop`），工作台经 `pi-runtime.adapter.ts` 直接用它，没有任何端口能替换实现。

## 3. 修改后架构

- 目标图：`S9-kernel-loop.svg` 右半部分。
- 新增/修改：
  - `packages/kernel-contracts/src/loop.ts`：`AgentLoop` 端口（`run(turn): AsyncIterable<LoopEvent>`、`steer(text)`、`abort(reason)`）与 `LoopEvent`；事件形状复用已冻结的 `AgentSessionEvent`（`agent-session.ts:196-237`），不新增跨层事件类型（H1）。
  - `packages/kernel-loop/src/run-controller.ts`：`RunController` 拥有 turn 状态机、单一 `MessageQueue`（steering 与 followUp 合并，先进先出带优先级）、abort 与重试；`run-loop.ts` 以 `packages/agent/src/agent-loop.ts:163-220` 为行为基准移植语义，不 import 它。
  - `packages/kernel-orchestrator/`：`Orchestrator.spawn/send/wait`，事件写入 `kernel-events`，重启后按事件日志恢复；第一版只支持同进程子 run。
  - `packages/adapters/legacy-pi/src/loop-adapter.ts`：`PiLoopAdapter implements AgentLoop`，内部仍调 `AgentSession` 的公开 `prompt()`/`steer()`，不碰私有方法。
  - `apps/server/src/sessions/pi-runtime.adapter.ts`：`prompt()` 改为构造 `Turn` 交给 `RunController`；`create-app.ts:130` 的 `kernel.integration` 从 `in-process` 改为 `run-controller`。
- 交互：工作台 → `RunController` →（`engine=own`）`kernel-loop` 或（`engine=pi`）`PiLoopAdapter` → provider 端口；工具调用仍经 S6 的注册表，`tool_call` 仍在 L1 同步 block。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段对它的改动 |
|---|---|---|
| `packages/agent/src/agent-loop.ts` | L3 核心：一轮对话的实际驱动 | 不再被工作台调用，行为被移植进 `kernel-loop` |
| `packages/coding-agent/src/core/agent-session.ts:1822-1957` | L3 会话：外层循环、settle 边界、压缩触发 | 降级为 `engine=pi` 的实现细节，仅 adapter 可达 |
| `apps/server/src/sessions/pi-runtime.adapter.ts` | L2 接缝：工作台与内核的唯一缝 | 改为依赖 `AgentLoop` 端口 |
| `packages/kernel-loop/`、`kernel-orchestrator/` | 目标 L3：循环与编排的唯一所有者 | 全新增，S9 后所有权 85% |
| `npm:pi-subagents` | L7 扩展：当前的编排提供者 | 从默认安装降为可选，能力由 `Orchestrator` 提供 |

## 5. 为什么改（收益与风险）

- 不做的后果：`04-roadmap.md` 的所有权停在 60%，任何"换一个循环策略"的需求都要改上游 `agent-session.ts`；双队列导致 steer 顺序不可预测，`turns per task` 无法归因；子代理失败没有事件可复盘，`pass@1` 的下降找不到原因。
- 做完的收益：`turns per task` 与 `cost per resolved task` 第一次可以按 turn 归因；`compaction per task` 由 `RunController` 自己触发（接管 `agent-session.ts:1893` 的 settle 边界）；子代理任务成功率有基线；pi 可以被整体删除而不影响 `packages/kernel-*` 编译。
- 新风险：双轨期两套实现的工具调用顺序、事件时序可能分叉 → 用同一批 golden traces 逐事件 diff，差异必须逐条解释；移植 `runLoop` 时漏掉重试/错误分支 → 用 `mutation` 式用例（故意让 provider 抛错）覆盖。

## 6. 怎么改（步骤，每步可独立验证）

1. 冻结基准：把 S0 的 20 条 golden traces 扩到 30 条，新增 steer、abort、provider 抛错、工具失败重试四类场景，落在 `apps/server/test/fixtures/golden/loop/`。
2. 定义端口：`packages/kernel-contracts/src/loop.ts` 只写类型与 `LoopEvent`，零依赖；`AgentSessionEvent` 作为事件的唯一形状来源。
3. 实现 `RunController`：先只做"透传"——收到 `Turn` 就交给注入的 `AgentLoop`，自身只记事件；此时 `engine` 两值行为必须完全一致。
4. 实现 `PiLoopAdapter`：包装 `AgentSession.prompt()`，把 `queue_update` 映射到 `LoopEvent`；双轨在这里起步。
5. 移植 `run-loop.ts`：以 `agent-loop.ts:163-220` 为基准逐分支移植，先跑通不带工具的单轮，再跑工具循环，最后跑 steer 插入。
6. 接管队列：`orchestrator`/`session` 只写 `RunController.queue`，删掉 `agent-session.ts:2239` 的直接 push（走 patch 记录）。
7. 接管编排：`Orchestrator.spawn/send/wait` 上线，`pi-subagents` 从 `DEFAULT_PLUGIN_SOURCES`（`packages.ts:14-20`）移除，改为按需安装。
8. 双轨对拍 30 天，按任务类型逐个切 `engine=own`；到期强制单轨，`engine=pi` 只留只读 fallback。

## 7. 验收与度量

| 项 | 命令/方法 | 通过标准 |
|---|---|---|
| trace 一致 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/loop-golden.test.ts` | 逐事件 diff 一致率 >95%，差异有归因记录 |
| 队列语义 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/loop-queue.test.ts` | steer 顺序与 abort 时机用例全绿 |
| 编排 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/orchestrator.test.ts` | spawn/send/wait 通过，重启后可按事件日志恢复 |
| 既有回归 | `npm run test:unit --workspace=@pi-console/server` | 现有用例全绿，无跳过 |
| 质量不降 | `04-roadmap.md` §3 | pass@1 不降；turns per task 涨幅 ≤5% |
| 类型/风格 | `npm run check` | 0 error |
| 边界 | `node scripts/check-kernel-boundaries.mjs` | `packages/kernel-*` 无 pi import |
| 文档 | `node scripts/check-architecture-docs.mjs` | exit 0 |

## 8. 回退（含上游 patch 规则）

- 开关：`PI_KERNEL_ENGINE=pi|own`，默认 `pi` 直到 §7 全绿；单任务级可用工作区配置覆盖。
- 回退步骤：置 `PI_KERNEL_ENGINE=pi` 重启，`RunController` 退化为透传壳，真实循环回到 `PiLoopAdapter`。
- 上游改动规则（用户决策）：允许在 fork 内改 `packages/coding-agent`，但每次改动必须在 `docs/patches/` 留 `S9-<序号>-<slug>.patch`（`git diff` 原文）+ 理由 + 上游 commit + 预期删除时间；上游文件只做调用点替换，不重写逻辑。
- 双轨退出：对拍满 30 天且一致率 >95% 后，删 `PiLoopAdapter` 的写路径，`engine=pi` 仅保留只读回放。
- 演练记录：（待填：日期 + 结果 + 用到的 patch 列表）

## 9. 风险与不做

- 不做：多代理默认开启、worktree 并行（`Orchestrator` 第一版只同进程）；不做跨机恢复。
- 不做：改 `AgentSessionEvent`（`agent-session.ts:196-237` 冻结，H1）；不改 JSONL 只读真相源（H3）。
- 风险：双轨期两份实现同时演进，容易"修一处漏一处"；缓解是所有行为修复先进 `kernel-loop`，再回灌 adapter。
- 风险：`agent-session.ts` 的外层循环被绕过时，`_runBeforeSettleBoundary`（`:1893`）的压缩/记忆刷新可能不再触发；缓解是把 settle 边界显式建模为 `LoopEvent`，并在 §7 用 `compaction per task` 做回归。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 与计划的偏差：（待填）
- 学到的约束：（待填）
