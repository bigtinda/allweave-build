# 阶段 4：Pi runtime adapter + registry（进行中）

> 开始时间：2026-11-01。本文件是执行记录 + 剩余工作。

## 1. 目标

把"工作台如何使用 Pi SDK"收敛到**一个适配器**：`SessionCoordinator` 只认识 `AgentRuntime` 接口，不认识 `AgentSession`；每个会话一个 runtime 实例，由 registry 持有、按空闲回收。

## 2. 已完成的改动

| 位置 | 作用 |
|---|---|
| `apps/server/src/sessions/pi-runtime.adapter.ts`（394 行） | `SessionFactory = typeof createAgentSession`；`AgentRuntime` 接口（`prompt`/`abort`/`usage`/`compactions`/`subscribe`/`model`/`setModel`/`listModels`/`resources`/`navigate`/`dispose`）；`AgentRuntimeFactory.open(input)` |
| `apps/server/src/sessions/runtime-registry.ts` | 按会话 id 持有 `PiAgentRuntime`，`get`/`set`/`delete`/`close`；空闲回收与 provider 变更时批量 dispose |
| 运行时装配 | `ModelRuntime.create({authPath, modelsPath, modelsStorePath, allowModelNetwork:false})`；`SettingsManager.create(cwd, agentDir)` + `setProjectTrusted(true)`；`DefaultResourceLoader`（扩展/技能/提示模板）；`SessionManager.open(transcriptFile…)` 或 `.create(cwd, sessionsDir)` |
| 工具选择 | 插件开发会话：`noTools:"all"` + 只读/编辑/写入/插件工具；远程会话：`noTools:"builtin"` + `tools:["+read","+bash","+edit","+write"]` + `excludeTools:["ls","find","grep"]` |
| `apps/server/src/sessions/pi-events.ts`（109 行，清理后） | `adaptSdkEvent`/`adaptRuntimeEvent` 把 Pi 事件映射为 `AdaptedEvent`；`chatMessage()` 生成 UI 消息 |
| `apps/server/src/agent.ts` | `AgentService` 薄门面：只做委托与参数整形 |

## 3. 验收

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test apps/server/test/session-runtime.test.ts
```

已通过：SDK adapter 保留流式消息身份/thinking/工具失败；provider reload 后 dispose 并重建；失败初始化不缓存。

## 4. 结果与遗留

- 得到的能力：Pi 成为工作台里**唯一一个可替换的接缝**，Coordinator 与 HTTP 层不再直接 `import` Pi。
- **未完成的收口**：①接缝没有"面"——`apps/server` 里 12 个文件、26 个符号、33 处直接引用 5 个 `@earendil-works/*` 包（含 `pi-ai`、`pi-agent-core`、`chord`、`pi-env`），且 `pi-agent-core`/`chord` 未写进 `apps/server/package.json`；②`adaptRpcEvent` 已删，但 `JsonAgentSessionEvent` 相关 RPC 路径仍需确认无用；③运行时 id 不一致：`pi-events.ts` 用 `randomUUID()` 生成消息 id，`transcript.ts` 用 Pi `entry.id`，运行中与重启后 id 不同（S0/S3 修）。
- 下一步：S1 先做"内核门面"（`apps/server/src/kernel/` 统一出口），再谈把 Pi 当可删除适配器。
