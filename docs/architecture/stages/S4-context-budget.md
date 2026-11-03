# S4 上下文预算 — 让 token 花在刀刃上

> 图：S4-context-budget.svg。周期 2 周。内核动作：改写 token 估算、压缩请求参数与工具结果截断（packages/ai、packages/coding-agent）。不改事件类型，不改工具语义。

## 1. 一句话目标

让"这次请求会花多少 token"有一个来源、可比对、误差可测的实现，并把估算、压缩、结果截断三处隐式预算收成一个显式的 `ContextBudget`。

## 2. 修改前架构

1. 估算存在两套常量，互不相干：`packages/ai/src/utils/estimate.ts:15` 定义 `CHARS_PER_TOKEN = 3.5`；`packages/coding-agent/src/core/compaction/compaction.ts:298-349` 的 `estimateTokens` 在六个分支各自 `return Math.ceil(chars / 4)`（311、317、330、335、339、344），压缩路径完全不引用 ai 包常量。
2. 估算按 UTF-16 码元计：`estimate.ts:38-40` 是 `Math.ceil(text.length / CHARS_PER_TOKEN)`。一个汉字占 1 个码元却约等于 1 个 token，被算成 0.29；中英混排代码库的实际低估为 2–8 倍。`compaction.ts:296` 的注释写的是"conservative (overestimates tokens)"，对 CJK 恰好相反。
3. 压缩请求主动放弃缓存：`compaction.ts:631` 构造摘要请求时写死 `cacheRetention: "none"`，`compaction.ts:632` 又给压缩单独 `sessionId`，父会话已建立的前缀缓存无法复用。
4. 结果截断按行与字节，且只有 bash 落盘：`packages/coding-agent/src/core/tools/truncate.ts:11-12` 是 `DEFAULT_MAX_LINES = 2000` 与 `DEFAULT_MAX_BYTES = 50 * 1024`；`bash.ts:352` 会提示 `Full output: ...`，而 `read.ts:177`、`find.ts:147`、`grep.ts:282`、`ls.ts:141` 只调用 `truncateHead`，截掉的内容没有路径可回取。
5. 预算没有任何显式对象：窗口来自模型元数据，保留量来自 `CompactionSettings.reserveTokens`（`compaction.ts:120-130`），截断来自 `truncate.ts` 的两个模块级常量，三者没有共同的构造点，也没有一处能打印"当前预算"。

## 3. 修改后架构

1. 新增 `packages/ai/src/utils/token-estimate.ts`：按字符类（CJK、拉丁、代码符号、空白）分别计权，导出 `estimateTextTokens` 的替代实现与 `calibrate()`（用真实 usage 反算每模型系数）。`packages/ai/test/token-estimate.test.ts` 用 20 段本仓库真实语料断言误差 ≤15%。
2. `estimate.ts` 保留导出签名，`CHARS_PER_TOKEN` 降级为无统计时的 fallback；`estimateMessageTokens`（46）与 `estimateContextTokens`（97）改为转调新实现，调用方零改动。
3. `compaction.ts` 六处字面量 4 全部替换为对 `estimateTokens` 的单一导入；diff 应只剩六行。
4. 新增 `packages/coding-agent/src/core/context-budget.ts`：`ContextBudget { window, reserve, resultTokens, compactionTokens }`，由模型窗口与设置构造，压缩阈值与截断共用同一实例。
5. `truncate.ts:78` 的 `TruncationOptions` 增加 `maxTokens` 与 `spillTo`；`truncateHead` 在超限时把完整内容写入临时文件并返回 `spillPath`，五个工具统一渲染"已写入 <path>"。
6. `ContextBudget` 成为 `shouldCompact`、`estimateProjectedContextTokens` 与 `truncateHead` 的共同输入，并把 window / reserve / resultTokens 写进每条 trace，S0 建立的指标管线因此能回答"这次为什么压缩"。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 层 | 作用 | 改动 |
| --- | --- | --- | --- |
| token 估算 `packages/ai/src/utils/estimate.ts` | L3 内核（kernel-context） | 所有预算判定、压缩阈值、成本预估的唯一输入 | 换成 CJK 感知实现，旧常量保底 |
| 压缩请求参数 `compaction.ts:619-639` | L3 内核（kernel-context） | 摘要请求的缓存与经济性 | 保留父前缀 cacheRetention 与父 sessionId |
| 结果截断 `truncate.ts` + 五个工具 | L3 内核（kernel-tools） | 工具结果进入上下文的唯一闸门 | 加 token 预算与 spill 落盘 |

L1 工作台本阶段只消费指标（`apps/server/src/sessions/pi-runtime.adapter.ts` 的 usage 投影），不参与预算计算，因此不新增接缝。

## 5. 为什么改（收益与风险）

低估的直接后果不是"多花钱"，而是判断错误：`compaction.ts:267` 的 `shouldCompact` 在真实占用已接近窗口时仍返回 false，请求被 provider 以 `context_length_exceeded` 拒绝，再走 `agent-session.ts:3097` 的 overflow 恢复，代价是一次完整摘要加一次用户可见中断。

缓存是第二个理由：`cacheRetention: "none"` 让每次压缩重付全量输入价，`04-roadmap.md` §3 的 cache hit rate 指标直接受它支配。第三是截断不可逆：read/grep 截断后模型只能重跑更窄的查询，turns per task 上升，而 bash 已经证明 spill 到文件是可行模式。

风险在于估算变准会让压缩更早触发，`compaction per task` 短期上升。这是本阶段唯一允许的行为变化，需要用 `keepRecentTokens` 平衡并在验收里显式记录。

## 6. 怎么改（步骤，每步可独立验证）

1. 新建 `token-estimate.ts` 与语料测试，只加不改；先让新测试绿，旧测试不动。
2. `estimate.ts` 改为转调，保留 `CHARS_PER_TOKEN` 导出以防外部包引用；跑 `packages/ai` 现有估算测试。
3. 替换 `compaction.ts` 六处 `Math.ceil(chars / 4)`，跑压缩测试，确认摘要文本与事件序列不变。
4. 加 `context-budget.ts` 与 `truncateHead` 的 `maxTokens`/`spillTo`，先只接 read 一个工具，手工跑一次大文件读取确认路径可回读。
5. 其余四个工具接入，每接一个跑该工具自己的测试。
6. 改压缩请求的 `cacheRetention` 与 `sessionId`，单跑 `compaction.test.ts` 与 `agent-session-compaction.test.ts`。
7. 把前后指标写进 `04-roadmap.md` §3，作为 S5 的输入。

## 7. 验收与度量

| 项 | 命令 | 通过标准 |
| --- | --- | --- |
| 类型与风格 | `npm run check` | 0 error / 0 warning |
| 估算误差 | `cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/token-estimate.test.ts` | 本阶段新增测试；20 段语料平均误差 ≤15%，单段 ≤25% |
| 估算不回归 | `cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/context-estimate.test.ts` | 全绿 |
| 压缩不回归 | `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/compaction.test.ts test/suite/agent-session-compaction.test.ts` | 全绿，事件序列与 fixture 一致 |
| 截断与落盘 | `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/truncate.test.ts` | 该文件本阶段新增；超限结果带 `spillPath` 且内容可回读 |
| 指标 | `04-roadmap.md` §3 | tool result size p95 降 ≥30%；cache hit rate 不低于 S0 基线 |

## 8. 回退

- `PI_KERNEL_ESTIMATE=legacy`：`estimate.ts` 内部直接走旧的 3.5 常量实现，新模块不被调用。
- `PI_KERNEL_RESULT_SPILL=0`：`truncateHead` 忽略 `spillTo`，行为回到纯截断。
- 压缩请求参数改动只有两行，revert 对应 commit 即可，无数据迁移。

## 9. 风险与不做

- 不做 tokenizer 级精确计数：需要词表与每模型映射，收益小于 5%，维护成本高于本阶段价值。
- 不做 per-provider 计费修正，成本口径仍按 usage 字段。
- 不改 `AgentSessionEvent` 类型，不新增事件。
- 15% 是目标不是保证；语料不足时按 25% 记录并写明缺口，不允许把未达标写成达标。

## 10. 复盘（执行后回填）

- 实际误差：
- 压缩次数变化：
- 未按计划完成的部分与原因：
