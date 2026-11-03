# S2 可观测与成本 — 让每次运行留下证据

> 图：`S2-telemetry.svg`。周期 2 周。内核动作：无（在工作台侧订阅事件、加表、加只读面板；不往内核里埋点）。

## 1. 一句话目标

每次 run 产出可查询的 trace：run / turn / tool / model 四层 span 加真实成本与延迟分位，`/api/usage` 从"run 级 token 汇总"升级为"可归因的成本与延迟报表"，并且 `packages/telemetry` 从零引用变成可选 sink。

## 2. 修改前架构

- 现状图：`S2-telemetry.svg` 左半部分。
- 现状入口：`apps/server/src/sessions/coordinator.ts`、`sessions/run-usage.ts`、`store.ts`、`transport/http/sessions.routes.ts:53`。
- 现状问题（证据）：
  1. 只有计数器差值，没有时间维度：`apps/server/src/sessions/run-usage.ts:6-17` 的 `usageDelta(before, after)` 只做前后快照相减，counter 回退或缺失直接返回 `undefined`；`RunUsage`（`apps/shared/src/protocol.ts:194-204`）里没有任何 span、trace 或工具级耗时字段。
  2. 数据只在 run 结束后产生一次：`apps/server/src/sessions/coordinator.ts:405-429` 在 `finally` 里组装 `finishRunUsage(...)`，写进 `draft.lastRunUsage` 后随 `agent.status` 事件广播。工具执行了多久、模型被调用了几次、重试发生在哪一步，全部丢失。
  3. 没有观测用表：`apps/server/src/store.ts:26-30` 建的五张表是 `workspaces` / `removed_workspaces` / `sessions` / `session_summaries` / `events`，没有 run 与 span 的位置；跨会话查"上周一共花了多少"只能扫 JSONL。
  4. 遥测包没接线：`packages/telemetry`（`@earendil-works/pi-telemetry` 1.1.0）已提供 `TelemetryContext.startSpan` 契约（`packages/telemetry/src/index.ts`）、`NOOP_TELEMETRY_CONTEXT`（`packages/telemetry/src/noop.ts:20`）与 `InMemoryTelemetryContext`（`packages/telemetry/src/memory.ts:192`），但 `apps/` 下 grep `pi-telemetry` 零命中。
  5. 前端只有会话级弹窗：`apps/web/src/features/chat/UsageSummary.tsx:5-21` 算缓存命中率，`apps/web/src/pages/WorkbenchSettingsPanels.tsx:484` 是 `/api/usage` 的唯一消费点，没有成本趋势与延迟分位。

## 3. 修改后架构

- 目标图：`S2-telemetry.svg` 右半部分。
- 新增/修改：
  - `apps/server/src/sessions/trace.ts`：实现 `TelemetryContext`，把 `startSpan({name})` 映射成 run/turn/tool/model 四层，父链靠 span 栈维护；对外只暴露 `beginRun` / `beginTurn` / `beginTool` / `endSpan`。
  - `apps/server/src/store.ts`：新增 `runs(id, session_id, started_at, duration_ms, model, outcome, cost_usd, error_kind)` 与 `spans(id, run_id, parent_id, kind, name, started_at, duration_ms, status, attrs)`，都带 `session_id` 索引；写入与投影复用同一个 `withTransaction`（`store.ts:45-59`）。
  - `apps/server/src/sessions/coordinator.ts`：在已有的 `prompt()` try/finally（`coordinator.ts:387-443`）里开 run span，在 `emit()`（`coordinator.ts:252-261`）里按 `tool.started` / `tool.completed` 开关 tool span。不改控制流，失败也不吞事件。
  - `apps/server/src/transport/http/sessions.routes.ts:53`：`/api/usage` 增加 `since` / `groupBy` 参数，响应补 `cost`、`latencyP50`、`latencyP95`、`errorBreakdown`。
  - `apps/shared/src/protocol.ts`：`SessionUsageRecord`（:184-193）与 `RunUsage`（:194-204）只加可选字段，旧客户端不受影响。
  - `scripts/check-cost-parity.mjs`（新）：拿 20 个 golden trace 的记账结果与 `runs.cost_usd` 对比。
- 交互：`trace.ts` 只消费 `AdaptedEvent`（`apps/server/src/adapter.ts`）与 runtime 事件流，不 import 任何内核符号（S1 的门禁会拦住）；sink 由 `PI_CONSOLE_TRACE` 选择 `off`（NOOP）/ `memory`（`InMemoryTelemetryContext`）/ `file`。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段对它的改动 |
|---|---|---|
| `apps/server/src/sessions/trace.ts` | L3 工作台观测层：runtime 事件流的旁路消费者，不参与决策 | 新建 |
| `apps/server/src/store.ts`（`runs` / `spans`） | L6 持久化：观测数据与投影同库同事务，避免两套时钟 | 加表 + 扩事务 |
| `apps/server/src/sessions/coordinator.ts` | L3 run 生命周期宿主，唯一知道"一次 run 从哪开始到哪结束"的地方 | 插入 span 边界 |
| `apps/server/src/transport/http/sessions.routes.ts:53` | L2 接缝：观测数据的 HTTP 出口 | 扩响应结构 |
| `packages/telemetry` | 跨实现通用的 span 契约，S9 换内核后仍然可用 | 从零引用变为可选依赖 |

## 5. 为什么改（收益与风险）

- 不做的后果：`04-roadmap.md` §3 的八项指标里，`cost per resolved task`、`cache hit rate`、`tool result size p95`、`turns per task`、`tool error rate` 都无法按 run 归因——只能看会话累计值，一次重试或一次压缩就把账搅浑；后续上下文工程与提示词缓存的收益无法证伪。
- 做完的收益：直接支撑 §3 的 5 项指标，成本与延迟首次有 per-run 基线；S3 的崩溃恢复也依赖 run 级记录判断"哪次 run 没跑完"。
- 新风险：span 写入放大 WAL；属性基数失控（把 tool 输入写进 attrs）；最危险的是"为了埋点去改内核事件"——那会破坏 H1 冻结契约。缓解：attrs 只允许枚举值与数字，长度上限 256 字节，`check` 里加一条 schema 校验。

## 6. 怎么改（步骤，每步可独立验证）

1. 先钉基线：`cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/run-usage.test.ts test/usage-observation.test.ts`，记录 `finishRunUsage` 现有输出，确保扩展后是超集。
2. 加表：改 `store.ts` 的建表语句（`store.ts:26-30` 区块），升 `SESSION_META_VERSION`，写迁移；跑 `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/store.test.ts test/session-storage.test.ts`。
3. 写 `sessions/trace.ts`：先只实现 `run` 与 `tool` 两层，`model` 层在步骤 5 接成本时补；进程内 sink 默认 `NOOP_TELEMETRY_CONTEXT`。
4. 接 coordinator：run span 开在 `coordinator.ts:365-368` 取 before 快照的同一处，关在 `finally`（:387-443）；tool span 挂在 `emit()` 的 `tool.started` / `tool.completed` 分支。
5. 接成本：在 model span 结束时用 `pi-ai` 的 `calculateCost(model, usage)` 累加，写 `runs.cost_usd`；`RunUsage.tokens.cost`（`protocol.ts:200`）继续写，作为兼容字段。
6. 扩路由与协议：`/api/usage` 加参数与分位字段；`SessionUsageRecord` / `RunUsage` 只加可选字段；跑 `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/api.test.ts`。
7. 开关与面板：`PI_CONSOLE_TRACE`（经 `kernel/flags.ts` 读取，默认 `off`），前端在用量页加只读的成本趋势与 p95 卡片，不新增写接口。
8. 对账：写 `scripts/check-cost-parity.mjs`，对 20 个 golden trace 比对账面成本。

## 7. 验收与度量

| 项 | 命令/方法 | 通过标准 |
|---|---|---|
| trace 覆盖 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/trace.test.ts` | 每个 run 恰好 1 个 run span；turn 数等于实际请求数；无孤儿 span |
| 成本误差 | `node scripts/check-cost-parity.mjs` | 20 个 golden trace 的偏差均 < 5% |
| 协议兼容 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/api.test.ts test/store.test.ts` | 旧库自动迁移；旧字段仍在，新增字段全为可选 |
| 行为不回归 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/session-coordinator.test.ts test/usage-observation.test.ts` | 全绿，run 结果与用量数值不变 |
| 写放大 | `node apps/server/scripts/benchmark-stream-writes.mjs` | 开启 trace 后 wall clock 增幅 < 10% |
| 指标回填 | `docs/architecture/stages/baseline.json` 与本期实测 | `cost` / `cache hit` / `p95` / `tool result size` 四项前后对比写回 |
| 类型与风格 | `npm run check` | 0 error |

## 8. 回退

- 开关：`PI_CONSOLE_TRACE`，默认 `off`（NOOP sink，只写 `runs` 摘要不写 `spans`）。
- 回退步骤：设 `PI_CONSOLE_TRACE=off` 重启即回到修改前的可观测性；`runs` / `spans` 表保留不删（`CREATE TABLE IF NOT EXISTS` 无副作用），避免二次迁移。
- 演练记录（执行后回填）：（待填）

## 9. 风险与不做

- 不做：不在内核里加埋点钩子。观测只能来自 `apps/server/src/sessions/*` 对既有事件的订阅，H1 的事件联合（`agent-session.ts:196-237`）保持冻结。
- 不做：采样与远程导出（OTLP）。本地单用户，全量写足够；量级由 `benchmark-stream-writes.mjs` 兜住。
- 不做：成本预算与告警。本阶段只出数据，不做策略。
- 风险：`attrs` 写入工具输入会撑爆库并泄漏路径；规则是只写 `toolName`、字符数、状态三类低基数属性。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 与计划的偏差：（待填）
- 学到的约束（写进 `02`/`03` 或 ADR）：（待填）
