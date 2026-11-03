# 阶段 5：SessionCoordinator、授权与事件（计划）

> 前置：阶段 2–4。预计 2–3 周。本文件是计划 + 完成条件。

## 1. 目标

让"一次运行"成为显式状态机：单会话单运行、冲突拒绝、审批可持久化、事件是唯一对外通道。拆掉 `AgentService` 里仍未收敛的旁路。

## 2. 修改前架构

```
HTTP/WS ──► AgentService ──► SessionCoordinator ──► RuntimeRegistry ──► Pi AgentSession
                                   │
                                   ├─ ToolAuthorization（内存 Map，300s 超时）
                                   ├─ EventProjector（SQLite 事务）
                                   └─ EventHub ──► session-stream（WS）
```

问题：审批只存在内存；`busy`/`cancelled`/`updating` 三个 Set 与 `runs` Map 分散；`pi-events.ts` 的运行中 id 与 transcript id 不一致；`sessions.routes.ts` 用 202 + 轮询语义，但客户端没有 resume cursor。

## 3. 修改后架构

```
HTTP/WS ──► SessionRoutes ──► SessionCoordinator（状态机，单写者）
                                   ├─ RunStateStore（busy/run/cancel/approval，持久化）
                                   ├─ ToolAuthorization（approval 落库，重启恢复）
                                   ├─ EventProjector ──► EventHub ──► WS(snapshot + 增量 + resume cursor)
                                   └─ RuntimeRegistry
```

## 4. 改哪一块、在整体架构中的作用

| 块 | 作用 | 改动 |
|---|---|---|
| `sessions/coordinator.ts`（619 行） | 工作台与内核之间的唯一编排者 | 抽出 `RunState` 对象；把审批超时/取消与 run 生命周期绑定；删除跨层直接调用 |
| `sessions/tool-authorization.ts`（121 行） | 工具调用的"人审"关卡 | 审批记录落 `ConsoleStore`；`expiresAt` 与定时器统一（已修 C20）；恢复后补 `interrupted` 结果 |
| `sessions/event-projector.ts`（357 行） | 事件 → 投影的唯一写者 | 只对需要增量的事件写全量快照；`session.recovered` 语义收紧 |
| `sessions/pi-events.ts`（109 行） | Pi 事件 → 工作台事件 | 运行中 id 改为 Pi 的稳定 id（`entry.id`），与 `transcript.ts` 对齐 |
| `transport/websocket/session-stream.ts`（60 行） | 单会话事件流 | 增加 `resume`（last eventId）与背压关闭码约定 |
| `transport/http/sessions.routes.ts`（170 行） | 会话 REST | 审批/恢复接口语义与状态机对齐；202 语义在文档中写清 |

## 5. 为什么

- 崩溃后 in-flight run 与审批丢失是当前 P0（`event-projector.ts:68-74`、`tool-authorization.ts:35`）；审批丢失会让用户重启后"看起来在跑、实际已死"。
- 运行中/重启后消息 id 不同，导致前端按 id 合并时出现重复或丢失。
- 单写者与 resume cursor 是后面 S9"多 surface 同一协议"的前提。

## 6. 怎么改（步骤）

1. 写表征测试：一个会话并发两次 `prompt` 必须 409；审批挂起时进程重启后状态为 `error` 且带 `interrupted` 工具结果。
2. 引入 `RunStateStore`（先内存 + SQLite 双写），把 `busy/cancelled/runs` 收进去；Coordinator 只读写它。
3. 审批记录落库（`approvals` 表或 `session_summaries.data` 内嵌），启动时把未决审批标记为 expired 并补工具结果。
4. 消息 id 统一为 `entry.id`；补一条"运行中 → 重启 → 继续"的回归测试。
5. WS 增加 `resume`：客户端带 `lastEventId`，服务端用 `store.loadSessionEvents(id, after)` 回放。
6. 删掉 `AgentService` 中与状态机重复的方法（保留纯委托）。

## 7. 验收与度量

- 并发 prompt 409、审批重启后恢复、resume 回放三条表征测试通过。
- `npm run check` 无错误；`apps/server/test` 全绿。
- 指标：崩溃后会话可恢复率 100%；恢复耗时 < 1s（本地 1000 事件回放）。

## 8. 回退

`PI_CONSOLE_RUN_STATE=memory` 开关回到旧路径；审批落库失败时降级为内存并记日志（一个版本后移除）。

## 9. 风险

- 审批落库会引入"审批表与投影表不一致"的新双权威；必须先定 owner（建议投影表内嵌，避免第二张表）。
- resume 回放与快照的边界要写清，否则客户端会二次应用事件。
