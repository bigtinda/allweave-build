# S5 压缩子系统抽取 — 三个入口收成一个控制器

> 图：S5-compaction.svg。周期 3 周。内核动作：改 `packages/coding-agent/src/core/agent-session.ts`（上游文件），改动以 patch 形式留档于 `docs/patches/`。

## 1. 一句话目标

把散在 AgentSession 里的压缩触发、阈值投影与摘要编排收进一个 `CompactionController`，三个入口共用同一条实现，`agent-session.ts` 净减 ≥500 行，而 `AgentSessionEvent` 序列逐字节不变。

## 2. 修改前架构

1. 触发点四处，各自拼参数：`packages/coding-agent/src/core/agent-session.ts:783` 与 `:839` 调 `_runAutoCompaction("threshold", false)`，`:1884` 与 `:2056` 调 `_checkCompaction(...)`；手动入口是 `:2764` 的 `compact(customInstructions?)`。
2. 阈值投影重复实现：`_exceedsCompactionThreshold`（`:767-774`）算一次，`_installAgentRequestProjection`（`:787-844`）在 `:838` 又判一次，两者都依赖 `estimateProjectedContextTokens`。
3. 参数以长列表透传：`_runDefaultCompaction`（`:2719-2742`）调 `compact(...)` 时逐项传 model、apiKey、headers、streamFn 等十一个实参，`:2740` 显式传 `sessionId = undefined`；`compact` 本身已是 12 参（`packages/coding-agent/src/core/compaction/compaction.ts:965`）。
4. 事件在四处各发一次：`compaction_start` 在 `:2767` 与 `:3119`，`session_compact` 在 `:2859` 与 `:3189`，`compaction_end` 在 `:2878`、`:2891`、`:3024`、`:3205`、`:3222`，`session_compact_failed` 在 `:1055`。任何一处漏发，工作台就停在"压缩中"。
5. 与存储读模型强耦合：`prepareCompaction(pathEntries, settings)`（`compaction.ts:872`）要求调用方先拿到 `getBranch()` 的结果，压缩逻辑因此无法脱离会话对象单测。

## 3. 修改后架构

1. 新增 `packages/coding-agent/src/core/compaction/compaction-controller.ts`：`class CompactionController`，构造入参 `{entries, settings, estimator, events, store}`，唯一出口 `run(reason): Promise<CompactionResult>`，内部只发四个事件（`compaction_start`、`session_compact`、`session_compact_failed`、`compaction_end`）并调用一次 `store.appendCompaction`。
2. `agent-session.ts` 的三个入口各剩 5–10 行：收集 entries、调 `controller.run()`、把 `CompactionResult` 写回。`_runDefaultCompaction` 与 `_runAutoCompaction` 的重复段落删除，`:783` 与 `:839` 合并为一次调用。
3. `prepareCompaction`（`compaction.ts:872`）与 `CompactionPreparation`（`:772`）保持原签名，作为 controller 的内部纯函数；`compact`（`:965`）的 12 参签名先在 controller 内部收成 options 对象，再逐步改调用方。
4. 等价验证通过后，controller 原样迁到 `packages/kernel-context/src/compaction/`，`packages/coding-agent` 只保留 adapter；迁移不在本阶段的验收范围内时，留给 S9。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 层 | 作用 | 改动 |
| --- | --- | --- | --- |
| 三个入口 `agent-session.ts:767-844`、`2714-3256` | L3 内核（会话） | 决定何时压缩、压缩后如何续跑 | 收敛到 controller |
| 摘要编排 `compaction/compaction.ts:872`、`:965` | L3 内核（上下文） | 切点、摘要、文件操作提取 | 函数不动，签名收成 options |
| 事件与落盘 `session_compact` + `appendCompaction` | L2 接缝 | 工作台唯一的进度来源 | 契约冻结，由 controller 单点发出 |

L1 工作台只读 `runtime.compactions()`（`apps/server/src/sessions/pi-runtime.adapter.ts:155`），本阶段不改它，也不改 `AgentSessionEvent` 类型（`agent-session.ts:196-237`）。

## 5. 为什么改（收益与风险）

压缩是"第一个拆解接缝"的样板：输出面窄（一个结果、四个事件、一次落盘），与工作台零耦合，而正确性最热（六处估算、overflow 恢复、split turn 两次摘要、context_edit 改写）。三份实现意味着三个测试面和三套恢复语义，实测已经漂移：请求前入口固定传 `willRetry = false`（`:783`），自动入口传真实值（`:3205`），两者对"失败后是否重试"的判断并不相同。

收益是可测的：入口合一后，"哪条路径触发了压缩"只需看 `reason` 字段；行数下降让 `02-kernel-architecture.md` 里 AgentSession 的职责区间表可以真正收敛。

风险在于压缩是用户数据路径。事件顺序一变，前端就会卡住或重复渲染；因此本阶段的原则是先等价保真、后谈优化，任何"顺手改好"的行为变更都推到 S7。

## 6. 怎么改（步骤，每步可独立验证）

1. 冻结契约：在 `test/suite/agent-session-compaction.test.ts` 旁新增 fixture，录下三条入口各自的 `AgentSessionEvent` JSON 序列（含 `willRetry` 差异）。
2. 新建 `compaction-controller.ts`，先定义端口接口（`CompactionPort`：`loadEntries` / `estimate` / `emit` / `append`），第一阶段只做转发：内部仍调 `prepareCompaction` 与 `compact`，不改变任何判定。
3. `_runAutoCompaction`（`:3097`）改为调 controller，跑 fixture 对比，diff 必须为空。
4. 手动入口 `compact()`（`:2764`）改接，同上；确认 `customInstructions` 仍能透传。
5. 请求前入口（`:776`）与投影内判定（`:838`）改接，删掉重复的 `_exceedsCompactionThreshold` 调用点。
6. 删除死代码，做双轨对比：新旧实现各跑一遍 fixture，事件与摘要文本必须一致，再记录 `(Get-Content packages/coding-agent/src/core/agent-session.ts).Count` 的前后值。
7. 生成 patch：docs/patches/ 已建（见 docs/patches/README.md），执行本阶段时生成本次 patch；git diff -- packages/coding-agent > docs/patches/S5-01-extract-compaction-controller.patch，并在登记表写明上游基线 commit、文件清单、升级时的重打步骤。
8. 若时间允许，把 controller 迁到 `packages/kernel-context`，`coding-agent` 侧只留 adapter；否则登记为 S9 遗留项。

## 7. 验收与度量

| 项 | 命令 | 通过标准 |
| --- | --- | --- |
| 事件等价 | `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-compaction.test.ts` | 全绿，fixture diff 为空 |
| 压缩单测 | `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/compaction.test.ts test/compaction-serialization.test.ts test/compaction-summary-reasoning.test.ts` | 全绿 |
| 行数 | `(Get-Content packages/coding-agent/src/core/agent-session.ts).Count` | ≤ 3898（基线 4398 减 500） |
| 服务端回归 | `npm run test:unit --workspace=@pi-console/server` | 全绿 |
| 静态门禁 | `npm run check` 与 `node scripts/check-architecture-docs.mjs` | 0 error |
| 指标 | `04-roadmap.md` §3 | compaction per task 不升，cost per resolved task 不升 |

## 8. 回退

- 运行时开关 `PI_KERNEL_COMPACTION=legacy`：controller 整体绕过，三个入口回到旧路径；旧实现保留一个版本，S9 后才删。
- 代码回退：`git apply -R docs/patches/S5-01-extract-compaction-controller.patch`，patch 头记录基线 commit，避免误打到已变更的文件。
- 上游升级冲突：按"调用点替换"原则重打，不重写 controller；`docs/patches/README.md` 记录每次重打的结果。

## 9. 风险与不做

- 不做摘要算法与提示词改动（属 S7）、不改 `reserveTokens = 16384` / `keepRecentTokens = 20000` 默认值、不做压缩与请求并行。
- 风险：行数目标会诱导过度合并。以事件等价为第一验收，行数为辅；达不到 500 行就如实记录差额与原因。
- 风险：patch 与上游漂移。每次升级 `packages/coding-agent` 依赖都要重放并跑 fixture，冲突不得静默跳过。
- 不修改 `AgentSessionEvent`（`agent-session.ts:196-237`），controller 复用现有类型。

## 10. 复盘（执行后回填）

- 实际减少行数：
- 事件序列差异：
- patch 重打次数与冲突点：
