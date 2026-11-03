# S3 持久化单一事实 — 让崩溃只丢最后一条

> 图：`S3-persistence.svg`。周期 3 周。内核动作：替换（存储）。JSONL 仍是对话真相源（H3），被替换的是工作台侧的第二套权威。

## 1. 一句话目标

`session_events` 成为会话状态的唯一写者与唯一读源，SQLite 里的整份快照降级为可重建的投影；进程被 kill -9 之后，挂起的 run 与审批能被发现并补齐，而不是悄悄变成"空闲"。

## 2. 修改前架构

- 现状图：`S3-persistence.svg` 左半部分。
- 现状入口：`apps/server/src/sessions/event-projector.ts`、`apps/server/src/store.ts`、`sessions/coordinator.ts`、`sessions/tool-authorization.ts`。
- 现状问题（证据）：
  1. 快照是主数据：`apps/server/src/store.ts:26-30` 的五张表里，`sessions(id, data, file)` 存的是整份 `SessionDetail` 的 gzip 正文，`events` 表只是被裁剪的旁路日志（`store.ts:195-208` 会按 `min(eventId-1000, checkpointSequence)` 删旧行）。
  2. 每个非增量事件都写全量：`apps/server/src/sessions/event-projector.ts:342-350` 只在 `message.delta` / `tool.updated` 且距 checkpoint 不足 100 条时走增量，其余事件一律 `saveSession(detail, record.meta.file)`。
  3. 写入有 1 秒窗：`store.ts:179-189` 的 `saveSession` 用 `defer` 合并写，崩溃窗口内的事件只存在于内存。
  4. in-flight 状态纯内存：`sessions/coordinator.ts:58-68` 的 `busy` / `runs` / `updating` 与 `sessions/tool-authorization.ts:39` 的 `approvals = new Map()` 都不落库；审批 5 分钟后过期（`tool-authorization.ts:31` 的 `approvalTimeoutMs = 300_000`），进程一重启这个计时器就没了。
  5. 重启即失忆：`event-projector.ts:68-76` 在构造时把非 idle 状态直接改写成 idle 并保存元数据，不发任何事件——客户端看到"运行中"变"空闲"，但没有任何 tool_result 被补上，也没有 `session.recovered`。
  6. 双权威无共同事务：JSONL 由 `apps/server/src/persistence/transcript.ts:1` 的 `SessionManager` 写，SQLite 由 `EventProjector` 写，两者不在同一事务里，冲突时无法判断谁对。

## 3. 修改后架构

- 目标图：`S3-persistence.svg` 右半部分。
- 新增/修改：
  - `session_events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id, seq, type, payload, created_at)`：append-only，唯一写者是 `EventProjector.project()`（`event-projector.ts:311-356`）；`events` 表删除。
  - checkpoint：每 50 条或每个 turn 边界写一条 `session_summaries`（`store.ts:29` 已有该表，含 `version` / `sequence`），`sessions.data` 降级为 checkpoint 缓存；删除 `event-projector.ts:350` 的全量快照分支。
  - `running_runs(id, session_id, started_at, model, status)` 与 `approvals(id, session_id, tool_call_id, name, input, expires_at, decision)`：`Approval`（`apps/shared/src/protocol.ts:159-165`）补 `sessionId`、`createdAt`、`decision` 三个可选字段。
  - 启动恢复：replay `session_events` → 对 `running` 的 run 补一条 `interrupted` 的 tool_result（内容固定为 `RESTART_OUTPUT`）→ 发一条 `session.recovered`（`EventType` 已有，`protocol.ts:256`），由 `event-projector.ts:251-303` 的 `recover()` 承担。
  - 开关 `PI_CONSOLE_PROJECTION=legacy|events`，默认 `events`，`legacy` 保留一个版本用于对拍与回退。
- 交互：HTTP 层的 `POST /api/sessions/:id/recover`（`apps/server/src/transport/http/sessions.routes.ts:145`）语义不变，只是内部从"重放 JSONL 覆盖快照"变成"重放事件日志 + 补中断结果"。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段对它的改动 |
|---|---|---|
| `apps/server/src/store.ts` | L6 持久化：本地唯一的有状态存储，一张 SQLite 承载投影与事件 | 加 `session_events` / `running_runs` / `approvals`，删 `events` 表 |
| `apps/server/src/sessions/event-projector.ts` | L3 投影：把 `AdaptedEvent` 变成 `SessionDetail`，是写路径的唯一入口 | 改成 append-only + 每 50 条 checkpoint |
| `apps/server/src/sessions/coordinator.ts` | L3 run 生命周期宿主，内存态目前是第二份真相 | run 开始/结束写 `running_runs` |
| `apps/server/src/sessions/tool-authorization.ts` | L3 授权：审批是唯一会"卡住等人"的状态 | `Map` 降级为热缓存，库是真相 |
| `apps/server/src/persistence/transcript.ts` | L6 JSONL，H3 规定的对话真相源 | 不改，但明确它不再是投影的读源 |

## 5. 为什么改（收益与风险）

- 不做的后果：每次崩溃/重启都丢一次 run，客户端的"运行中"永久悬挂；审批在重启后既不会通过也不会过期；`event-projector.ts:68-76` 的静默改写让"服务挂过"这件事在数据里不可见。这些直接抬高 `04-roadmap.md` §3 的 `human intervention rate`。
- 做完的收益：`turns per task` 与 `human intervention rate` 有可复现的基线；写入路径从"每个事件一份全量快照"变成"一次 append"，为 S4 的上下文预算与 S5 的压缩子系统提供稳定底座。
- 新风险：写路径改造最容易静默丢事件；迁移写错会让历史会话回放不出来。缓解：先双写、再切读、最后删旧，每一步都有一致性测试兜住。

## 6. 怎么改（步骤，每步可独立验证）

1. 先加表与双写：`store.ts` 建三张新表（`CREATE TABLE IF NOT EXISTS`），`project()` 在同一 `withTransaction`（`store.ts:45-59`）里既写旧 `events` 也写 `session_events`。跑 `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/stream-checkpoint.test.ts test/session-projection.test.ts`。
2. 双跑观察一周：`PI_CONSOLE_PROJECTION=legacy|events` 双档各跑一次回放，用新脚本 `scripts/compare-projection.mjs` 比对两者产出的 `SessionDetail` 是否逐字段相等；不等即修写入端。
3. 切读路径：`hydrate()`（`event-projector.ts:143-197`）改为优先 replay `session_events`，仅当该会话没有事件行时回退 `mergeTranscript` 的快照路径。
4. in-flight 落库：run 开始时写 `running_runs`，`emit()` 的 `agent.status` 分支更新状态；`tool-authorization.ts:39` 的 `Map` 改为"先写库再返回审批"，写库失败即拒绝审批（fail closed），`approvalTimeoutMs` 保持 300000 不变。
5. 重启恢复：`recover()` 改为 replay → 对残留 `running` 补 `RESTART_OUTPUT` 的 tool_result → 单条 `session.recovered`；把构造器里的静默改写（`event-projector.ts:68-76`）删掉，改为显式发事件。
6. 删旧路径：移除 `event-projector.ts:350` 的全量快照分支、`events` 表的写入与裁剪（`store.ts:195-208`），`sessions.data` 只由 checkpoint 更新。

## 7. 验收与度量

| 项 | 命令/方法 | 通过标准 |
|---|---|---|
| 崩溃恢复 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/crash-recovery.test.ts`（新增，子进程 kill -9） | 恢复率 100%；重启后无 `running` 悬挂；每条中断 run 有 `RESTART_OUTPUT` |
| 写放大 | `node apps/server/scripts/benchmark-stream-writes.mjs` | `fullSnapshotWrites` ≤ 1，WAL 字节相比 S0 基线降 ≥ 80% |
| 回放一致 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/stream-checkpoint.test.ts` | 1002 次 delta 后重启回放与内存投影逐字段相等 |
| 迁移 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/store.test.ts test/session-storage.test.ts` | 旧库可打开并升版；`legacy` 与 `events` 两档回放结果一致 |
| 审批 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/tool-policy.test.ts test/session-coordinator.test.ts` | 重启后 pending 审批被结算为 expired，不残留 |
| 类型与风格 | `npm run check` | 0 error |

## 8. 回退

- 开关：`PI_CONSOLE_PROJECTION`，默认 `events`；设为 `legacy` 即回到"读快照、写快照"的旧路径。
- 回退步骤：设 `PI_CONSOLE_PROJECTION=legacy` 重启即可；`session_events` 继续只写不读（丢弃无害），不回滚表结构，避免二次迁移。
- 演练记录（执行后回填）：（待填）

## 9. 风险与不做

- 不做：跨设备同步、静态加密、事件流压缩与分段。这些不在本阶段目标内，且会稀释"单一写者"这一条。
- 不做：改 JSONL 的写入方（`persistence/transcript.ts`）。H3 规定它是对话真相源，本阶段只让它不再被当作投影读源。
- 不做：会话分叉与树导航的持久化语义调整；`navigateTree` 的行为必须保真，留给 S5。
- 风险：`approvals` 落库后，`input` 字段会把工具参数（可能含密钥）写进 SQLite；规则是写入前按 `tool-policy` 的敏感键过滤，测试 `tool-policy.test.ts` 里加断言。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 与计划的偏差：（待填）
- 学到的约束（写进 `02`/`03` 或 ADR）：（待填）
