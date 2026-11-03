# S7 扩展宿主与信任 — 把第三方代码关进笼子

> 图：`S7-extension-host.svg`。周期 4 周。内核动作：把"30 个回调直接指向 `AgentSession`"换成"能力端口 + 显式信任门"。

## 1. 一句话目标

让"装一个扩展"成为一次可审计、可拒绝、可回退的决定：未显式信任的扩展不加载；已信任的扩展只能通过版本化端口使用内核能力，拿不到会话对象本身。

## 2. 修改前架构

- 现状图：`S7-extension-host.svg` 左半部分。
- 代码入口：`apps/server/src/sessions/pi-runtime.adapter.ts:313`（信任）、`:314`（宿主补丁）、`:388-391`（`bindExtensions`）、`apps/server/src/kernel.ts:53-63`（生成扩展文件）、`apps/server/src/sessions/tool-factory.ts:110-136`（`tool_call` 授权）。
- 现状问题（证据）：
  1. 项目无条件受信：`apps/server/src/sessions/pi-runtime.adapter.ts:313` 直接 `settingsManager.setProjectTrusted(true)`。本仓库 `.pi/extensions/` 有 4 个真实扩展（`import-repro.ts`、`prompt-url-widget.ts`、`redraws.ts`、`tps.ts`），克隆后开会话即全部执行。
  2. 扩展与内核同进程同权限：`packages/coding-agent/src/core/extensions/loader.ts:576-581` 用 jiti 在 server 进程内 `transform + import`，没有子进程、没有权限降级。
  3. 能力面等于会话面：`packages/coding-agent/src/core/agent-session.ts:3360-3493` 的 `_bindExtensionCore` 把 30 个回调交给 runner，其中 `:3428` 的 `setModel` 允许扩展改内核状态。
  4. 宿主自己写扩展：`apps/server/src/kernel.ts:63` 把生成的 `pi-console-cordis-host.mjs` 写进 agentDir 后当扩展加载；四条装载通道（`bindExtensions`、`extensionFactories`、`additionalExtensionPaths`、`registerTool`）没有一条记录"来源与授权"。

## 3. 修改后架构

- 目标图：`S7-extension-host.svg` 右半部分。
- 新增/修改：
  - `apps/server/src/extensions/trust.ts`：`TrustStore`，读写 `agentDir/trust.json`（`{ cwd, decision, pathHash, updatedAt }`），默认拒绝；复用 `packages/coding-agent/src/core/project-trust.ts` 的 decision 语义，不再走"创建即信任"。
  - `apps/server/src/extensions/host.ts`：`ExtensionHost`（`discover()`、`enable(path)`、`disable(path)`、`grant(path, capability)`、`audit()`）；capability 枚举固定为 `fs.read`、`fs.write`、`bash`、`model`、`net`、`session.write`。
  - `apps/server/src/extensions/policy.ts`：capability → 允许的钩子与工具（无 `bash` 不得注册 `user_bash`，无 `fs.write` 不得注册写类工具）。
  - `apps/server/src/kernel/extensions.ts`：对 `bindExtensions` / `additionalExtensionPaths` 的唯一封装，落在 S1 的门面内。
  - `apps/server/src/extensions/audit.ts`：每次 load / enable / grant / deny 写一条 `extension_audit` 事件，落 S3 的 `session_events` 表。
  - shim：`apps/server/src/extensions/shim/`，把 pi 的 `ExtensionAPI`（`packages/coding-agent/src/core/extensions/types.ts:1569-1636` 的 39 个钩子、`:1643` 的 `registerTool`）映射到上述端口，版本号 `PI_EXTENSION_API=1`。
- 交互：`AgentRuntimeFactory.open()` 先问 `ExtensionHost`，再把允许的扩展路径交给 `DefaultResourceLoader`；`tool_call` 授权仍由 `tool-factory.ts:110-136` 同步返回 `{block}`，语义不变（H2）。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段对它的改动 |
|---|---|---|
| `apps/server/src/sessions/pi-runtime.adapter.ts` | L2 接缝：工作台唯一创建会话的地方 | 删掉 `:313` 的无条件信任，改问 `TrustStore` |
| `packages/coding-agent/src/core/extensions/*` | L3 扩展运行时：发现、加载、钩子分发 | 加 shim 与端口适配，不改加载器本身 |
| `packages/coding-agent/src/core/agent-session.ts:3258-3700` | L3 会话：把内核能力反向暴露给扩展 | 只替换绑定调用点，30 个回调的语义冻结 |
| `apps/server/src/kernel.ts` | L2 宿主补丁：生成扩展文件并注入 | 生成物先登记到信任清单，否则不再注入 |
| `.pi/extensions/`、`.pi/skills/` | L1 项目资源：随仓库分发的可执行配置 | 由信任门统一管，未批准不加载 |

## 5. 为什么改（收益与风险）

- 不做的后果：P0-3 的"项目扩展自动信任"仍在；一次 `git clone` + 会话启动就等于运行仓库里的任意 TypeScript。`tool_call` 授权是工作台注入的 inline 扩展，若扩展装载策略被关掉，这层授权会静默消失（`tool-factory.ts:103-136` 与内核 `_beforeToolCall` 是两处独立判断）。
- 做完的收益：未信任扩展执行数 = 0；扩展故障不再能改模型/会话状态；`human intervention rate` 的分子里多一类"扩展审批"，可度量。对应 `04-roadmap.md` §3 的 `tool error rate`、`human intervention rate`。
- 新风险：生态兼容性下降 → 用黄金扩展集（`apps/server/src/packages.ts:14-20` 的 5 个默认包，含 `npm:pi-subagents`）做兼容率门槛；审批疲劳 → 一次批准按路径哈希复用，改文件即失效。

## 6. 怎么改（步骤，每步可独立验证）

1. 先冻结现状：`apps/server/test/extension-trust.test.ts` 断言"未信任 cwd 下 `loadExtensions` 返回 0 个扩展、`loadExtensionsCached` 不写缓存"；用 `.pi/extensions/redraws.ts` 做 fixture。
2. 加 `trust.ts` + `readFlag("PI_KERNEL_EXT_TRUST")`（`off|explicit|all`，默认 `explicit` 但先按 `all` 发布，见 §8）。
3. 加 `host.ts` 与 `policy.ts`：先只做"发现 + 列清单 + 记录"，不阻断加载，观察一周。
4. 改 `pi-runtime.adapter.ts:313`：从 `setProjectTrusted(true)` 改为 `trust.isTrusted(cwd)`；`pluginDevelopment` 分支保持现状（插件开发工作区是产品自带目录）。
5. 收口装载：`kernel/extensions.ts` 成为 `bindExtensions` 与 `additionalExtensionPaths` 的唯一调用点；`kernel.ts` 生成的宿主扩展先进 `TrustStore` 再注入。
6. 落 shim：`EXTENSION_API=1` 先支持 `tool_call`、`tool_result`、`session_start`、`session_shutdown`、`registerTool` 五个口，其余钩子返回空实现并记 `unsupported` 审计。
7. 黄金扩展集回归：5 个默认包各跑一条最小用例，输出兼容矩阵。

## 7. 验收与度量

| 项 | 命令/方法 | 通过标准 |
|---|---|---|
| 信任门 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/extension-trust.test.ts` | 未信任仓库扩展执行数 = 0 |
| 兼容性 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/extension-compat.test.ts` | 黄金扩展集兼容率 >95% |
| 授权语义 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/tool-policy.test.ts` | `tool_call` 仍同步 block，用例全绿 |
| 类型/风格 | `npm run check` | 0 error |
| 边界 | `node scripts/check-kernel-boundaries.mjs` | exit 0，扩展宿主未绕过 `kernel/` 门面 |
| 文档 | `node scripts/check-architecture-docs.mjs` | exit 0 |
| 指标 | `04-roadmap.md` §3 | 前后值写回基线表，`tool error rate` 不升 |

## 8. 回退

- 开关：`PI_KERNEL_EXT_TRUST=off|explicit|all`，默认 `explicit`；发布首周默认 `all`（等价旧行为）。
- 回退步骤：`PI_KERNEL_EXT_TRUST=all` 后重启 server，`ExtensionHost` 退化为"全放行 + 只记录"，不需要回滚代码。
- 演练记录：（待填：日期 + 结果）

## 9. 风险与不做

- 不做：OS 级隔离（S8）、扩展签名与市场、扩展线程/worker 级权限（Node 无此模型，写进 ADR 说明为什么不做）。
- 不做：重写 `extensions/loader.ts`；本阶段只加门与端口，加载器留到 S9 后再评估。
- 风险：shim 覆盖不全导致生态扩展失效；缓解是"未支持钩子显式报 `unsupported` 而不是静默成功"。
- 风险：改上游 `packages/coding-agent` 的 `ExtensionBindings` 类型会波及 CLI 三种 mode；规则同 S9——只做调用点替换，每次改动在 `docs/patches/` 留 `.patch` 与理由。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 与计划的偏差：（待填）
- 学到的约束：（待填）
