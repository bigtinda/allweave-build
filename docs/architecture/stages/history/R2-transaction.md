# 阶段 2：SQLite 原子投影（已完成）

> 完成时间：2026-11-01。本文件是执行记录。

## 1. 目标

把"会话状态"从进程内对象变成**可恢复的持久化投影**：每次状态变化在一个 SQLite 事务里同时写事件日志与会话快照，进程崩溃后能从"快照 + 事件"重放出一致的 UI 状态。

## 2. 做完的改动

| 位置 | 作用 |
|---|---|
| `apps/server/src/store.ts`（234 行） | `ConsoleStore`：`node:sqlite` `DatabaseSync(directory/console.sqlite)`，`PRAGMA journal_mode=WAL` |
| 表结构 | `workspaces(id,data)`、`removed_workspaces(path)`、`sessions(id,data,file)`、`session_summaries(id,version,sequence,data,file)`、`events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id, data)` + 索引 `events(session_id,id)` |
| `withTransaction(operation)`（`store.ts:45`） | `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`；嵌套调用合并到外层事务；**回调必须是同步的**，这是"投影不可重入"的硬约束 |
| `append(event)`（`store.ts:131` 附近） | 先插入空行拿自增 `eventId`，再用 gzip 回填 payload；事件保留窗口 `min(eventId-1000, checkpointSequence)`（`store.ts:205`） |
| `saveSession(detail, file, defer)` | gzip level 1 写入；`defer` 用 1s 定时器批量落盘（`.unref()`，不阻塞退出） |
| `apps/server/src/sessions/event-projector.ts`（357 行） | `EventProjector.project(id, change, mutate)`：`withTransaction { append(event) → applyEvent(draft) → projectSessionMeta → save }`，是"唯一写者" |
| `apps/server/src/persistence/session-projection.ts` | `mergeTranscript` / `mergeSnapshot` / `normalizeRestored`，`SESSION_META_VERSION = 3` |
| `apps/server/src/persistence/transcript.ts`（88 行） | `readTranscriptView(file)`：用 Pi `SessionManager.open(file).getBranch()` 重建对话，是重启后的真相源 |

## 3. 验收

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test apps/server/test/session-projection.test.ts
```

- "boot reads summaries and opens a session body only on demand" 通过；
- "a transcript rebuilds the conversation and merges the UI-only fields" 通过；
- "the coordinator stops a session whose projection cannot be persisted" 通过（写失败 → `failed` + `recoveryRequired`）。

## 4. 结果与遗留

- 得到的能力：启动只读摘要、按需 hydrate；单写者 + 事务；事件保留窗口可配置。
- **遗留缺陷（S3 处理）**：①每个事件写全量快照（除 `message.delta`/`tool.updated` 外都 `saveSession(detail)`），长会话 O(n²) 写放大；②对话正文在 Pi JSONL、投影在 SQLite，两个权威；③in-flight run 与审批只存在内存 Map，崩溃后不恢复。
- **遗留测试失败（S0 处理）**：`session-projection.test.ts` legacy 元数据升级 `actual: 3, expected: 2`。
