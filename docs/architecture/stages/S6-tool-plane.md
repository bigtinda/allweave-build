# S6 工具面重构 — 可见性、策略、执行三件事分开

> 图：S6-tool-plane.svg。周期 3 周。内核动作：工作台策略与审批改为数据驱动，内核工具装载抽出注册表；`tool_call` 的同步返回契约不变。

## 1. 一句话目标

把"模型能看到哪些工具"、"一次调用能不能执行"、"批准之后怎么执行"拆成三个可独立测试的组件，策略从代码变成规则表，审批从内存 Map 变成可重放记录。

## 2. 修改前架构

1. 可见性、系统提示、执行三者互锁：`packages/coding-agent/src/core/agent-session.ts:1527-1531` 的 `_setActiveTools` 在末尾直接调 `_rebuildSystemPrompt`；`_preparePromptAndToolLoadout`（`:1738-1750`）在 `:1742` 又把 `_applyToolLoadout` 的结果写回 `options.selectedTools`；同一份工具集合在 `getAllTools`（`:1495-1506`）、`_getCallableTools`（`:1562-1567`）、`_applyToolLoadout`（`:1575-1578`）各算一遍。
2. 注册表与提示片段在同一个方法里重建：`_refreshToolRegistry`（`:3495`）在 `:3560-3564` 组装 `_toolRegistry`，同时在 `:3538-3545` 生成 `_toolPromptGuidelines`；字段声明在 `:472`。想改工具可见性就要动这个 200 行方法。
3. 策略是硬编码集合：`apps/server/src/tool-policy.ts:3-4` 定义 `readOnlyTools` 与 `fileMutationTools` 两个 `Set`，全部逻辑是 `:8-17` 的 17 行三元分支。新增"某目录禁止写"必须改 TS 并重新发布。
4. 审批只在内存：`apps/server/src/sessions/tool-authorization.ts:39` 是 `private approvals = new Map<string, PendingApproval>()`，`:31` 写死 `approvalTimeoutMs = 300_000`。进程重启后待审批全部消失，无法回答"为什么同一命令问了两次"。
5. 执行拦截藏在插件钩子里：`apps/server/src/sessions/tool-factory.ts:110-136` 的 `pi.on("tool_call")`，`:112-119` 先做路径检查并返回 `{block:true, reason}`，`:122` 调 `toolPermission`，`:126-134` 走 `input.requestApproval`。

## 3. 修改后架构

1. `packages/kernel-tools/src/registry.ts`（新增）：`ToolRegistry` 负责注册与 `exposure`（沿用现类型 `"direct" | "model-only" | "codemode" | "deferred" | "hidden"`，见 `packages/coding-agent/src/core/extensions/types.ts:516`）以及 `promptSnippet`；`loadout(mode, policy)` 是纯函数，返回 `{tools, snippetText}`，不读会话状态。
2. `packages/kernel-policy/src/engine.ts`（新增）：`PolicyEngine.evaluate({tool, mode, path, command})` 返回 `{decision, sandbox, reason, ruleId}`；规则来自 `apps/server/policies/default.json`，默认 deny，未命中即拒绝并记录 `ruleId`。
3. `apps/server/src/tool-policy.ts` 退化为适配层：`toolPermission()` 签名不变，内部转调 engine，`apps/server/test/tool-policy.test.ts` 的 24 行断言不改也要通过。
4. `apps/server/src/sessions/approval-store.ts`（新增）：审批写入 S3 的 `approvals` 表，键为 `toolCallId` 加参数 hash；`ToolAuthorization` 的 `Map` 换成 store，超时策略从常量改为可配置。
5. `tool-factory.ts:110-136` 只保留翻译职责：把 engine 的 decision 翻成 `{block:true, reason}` 或 `input.requestApproval`，仍是同步返回，符合 `02-kernel-architecture.md` 的 H2 约束。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 层 | 作用 | 改动 |
| --- | --- | --- | --- |
| 工具装载 `agent-session.ts:1416-1813`、`:3495-3564` | L3 内核 | 决定模型看到哪些工具与提示文本 | 抽成 `ToolRegistry`，纯函数 loadout |
| 策略 `apps/server/src/tool-policy.ts` | L1 工作台（治理接缝） | 一次调用 allow / ask / deny | 数据驱动，保留原签名 |
| 审批 `apps/server/src/sessions/tool-authorization.ts` | L1 工作台（治理接缝） | 人在环的唯一状态 | 落库，可重放 |

本阶段横跨 L1 与 L3：策略与审批在工作台侧，工具装载在内核侧，新增的 `kernel-tools` / `kernel-policy` 位于两者之间的治理接缝（`00-plan.md` 记为 L5 治理）。边界不变：内核不读工作台的规则文件，engine 由工作台注入。

## 5. 为什么改（收益与风险）

第一条是权限变更的成本。加一条"`src/secrets` 只读"在今天是改 TS、跑 check、发版；产品上这是配置，不是代码。策略表化之后，改一条规则等于改一个 JSON 文件，验收里"改策略零代码"就是这条的可执行形式。

第二条是可解释性。审批 Map 重启即空，用户点过"允许"再刷页面会被二次询问，且没有记录能说明为什么问两次。落库之后同一次 `toolCallId` 可命中已有决定，重放测试能证明它。

第三条是可见性与提示的一致性。`promptSnippet` 既在工作台注册插件工具时给出（`tool-factory.ts:219`），也在内核 `_refreshToolRegistry` 里汇总（`:3538-3545`），两处不一致时模型会调用不存在的工具，表现为工具错误率上升。

风险是策略外置后规则写错会静默放行。因此 engine 默认 deny、启动时校验规则 schema、每次决策带 `ruleId` 入事件日志。

## 6. 怎么改（步骤，每步可独立验证）

1. 先抽工作台侧（低风险）：新建 `PolicyEngine` 与 `policies/default.json`，把 `tool-policy.ts` 的四个分支转成六条规则，`toolPermission()` 改为转调。原测试不改，必须全绿。
2. 决策入日志：每次 allow / ask / deny 带 `ruleId` 与工具名写进事件流，工作台"为什么被拦"直接显示规则 id。
3. 审批落库：新建 `approvals` 表与 `ApprovalStore`，`ToolAuthorization` 换存储；新增重放测试（同一 `toolCallId` 第二次请求不弹窗）。
4. 抽 `ToolRegistry`：把 `_getToolExposure`（`:1554-1556`）、`_getCallableTools`（`:1562-1567`）、`_applyToolLoadout`（`:1575-1578`）搬进 registry，行为等价用 `getAllTools()` 的 JSON 快照对比。
5. `loadout` 下沉为纯函数，`_preparePromptAndToolLoadout`（`:1738`）改为调用；`_rebuildSystemPrompt`（`:1700`）生成的提示文本 diff 必须为空。
6. 一键 diff：新增 `scripts/tool-loadout-diff.mjs`，输出两个 access mode 下的工具清单差异，供评审与回归使用。
7. 沙箱级别透传：engine 返回 `sandbox` 字段，执行层本阶段只读取不使用，实装留给 S8。

## 7. 验收与度量

| 项 | 命令 | 通过标准 |
| --- | --- | --- |
| 策略等价 | `npm run test:unit --workspace=@pi-console/server` | `tool-policy.test.ts` 未修改且全绿 |
| 规则可配 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/policy-engine.test.ts` | 本阶段新增测试；改 JSON 加一条 deny 后断言变化，无编译 |
| 审批重放 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/approval-store.test.ts` | 本阶段新增测试；同 `toolCallId` 二次请求命中已有决定 |
| 工具清单 diff | `node scripts/tool-loadout-diff.mjs --mode ask --mode full` | 本阶段新增脚本；差异为空，或逐条列出并有原因 |
| 提示文本不变 | `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-prompt.test.ts test/suite/agent-session-tool-orchestration.test.ts` | 全绿，系统提示与工具声明快照一致 |
| 静态门禁 | `npm run check` | 0 error |
| 指标 | `04-roadmap.md` §3 | tool error rate 不升，human intervention rate 下降 |

## 8. 回退

- `PI_KERNEL_TOOL_PLANE=legacy`：`tool-factory.ts` 直接调旧 `toolPermission`，registry 返回旧 `_applyToolLoadout` 的结果，engine 不参与。
- 审批表回退只切读路径，新表保留不删；旧 `Map` 实现留一个版本。
- `policies/default.json` 版本化存放，回退即恢复上一版文件，无需改代码。

## 9. 风险与不做

- 不做具体工具实现的重写（read / grep / bash 仍在 `packages/coding-agent/src/core/tools/`），本阶段只动"谁能用、能不能用"。
- 不做跨进程审批仲裁，也不做多人协作下的审批合并。
- 不做前端改版，只补 `ruleId` 展示所需字段。
- 风险：默认 deny 会打断现有插件工具（`plugin_*`），迁移期用显式 allowlist 加 ask 兜底，逐条转正。
- 约束：`tool_call` 钩子必须同步返回 `{block}`（`tool-factory.ts:110-127`），engine 不能变成异步 RPC。

## 10. 复盘（执行后回填）

- 规则条数与误拦率：
- 审批重放命中率：
- 工具清单 diff 的意外差异：
