# S1 内核门面 — 把内核收进一个出口

> 图：`S1-kernel-facade.svg`。周期 1 周。内核动作：无（只搬运 import 边界，不改任何运行时行为）。

## 1. 一句话目标

`apps/server/src` 对内核的所有引用收敛到 `apps/server/src/kernel/`，工作台与内核之间从"12 个文件各自直连 5 个包"变成"一个目录定义内核长什么样"，越界由 `check` 命令拦截而不是靠 code review。

## 2. 修改前架构

- 现状图：`S1-kernel-facade.svg` 左半部分。
- 现状入口：`apps/server/src/sessions/pi-runtime.adapter.ts`、`sessions/tool-factory.ts`、`workspaces/workspace-access.ts`、`bootstrap/create-app.ts`。
- 现状问题（证据）：
  1. 规模：12 个文件、26 个符号、33 处引用，横跨 `pi-coding-agent` / `pi-ai` / `pi-agent-core` / `chord` / `pi-env`（`docs/audit/kernel-map.md` §1.1）。
  2. 深路径穿透：`apps/server/src/sessions/pi-runtime.adapter.ts:3` 直接 `import { isModelType } from "@earendil-works/pi-ai/utils/model-operations"`，走的是包内部实现路径，minor 版本即可消失；同一符号在 `apps/server/src/providers.ts:4` 却是从公开入口拿的。
  3. 类型擦除后强转：`apps/server/src/sessions/tool-factory.ts:59-78` 三个 `create*ToolDefinition` 的结果全部 `as unknown as ToolDefinition`，注释自述"SDK customTools 擦除 schema 类型"。类型系统在这条接缝上不生效。
  4. 依赖未声明：`apps/server/src/workspaces/workspace-access.ts:4`、`workspaces/command-operations.ts:1` import `@earendil-works/chord`，`apps/server/src/sessions/pi-events.ts:2` import `@earendil-works/pi-agent-core`，两者都不在 `apps/server/package.json` 的依赖里，靠 monorepo 提升解析。
  5. 名字已被占用：`apps/server/src/kernel.ts`（65 行）只是 cordis host 文件生成辅助（`prepareDoomCordisHostExtension`），不是门面；`apps/server/src/kernel/` 目录不存在。

## 3. 修改后架构

- 目标图：`S1-kernel-facade.svg` 右半部分。
- 新增/修改：
  - `apps/server/src/kernel/index.ts`：唯一出口，重导出下面五个模块；`grep` 目标里它是唯一允许出现 `@earendil-works` 的目录。
  - `kernel/sdk.ts`：会话装配符号——`createAgentSession`、`SessionManager`、`SettingsManager`、`DefaultResourceLoader`、`ModelRuntime`、`getAgentDir`、`VERSION`、`withFileMutationQueue`。
  - `kernel/models.ts`：模型面——公开入口的 `isModelType`、`defaultModelPerProvider`、`AuthEvent`/`AuthPrompt`/`AuthType`。
  - `kernel/tools.ts`：工具面——四个 `create*ToolDefinition`、`ToolDefinition`、`InlineExtension`、`defineTool`、以及收敛后的 `toToolDefinition()`（唯一保留强转的地方）。
  - `kernel/events.ts`：事件面——`AgentMessage`、`AgentSessionEvent`。
  - `kernel/env.ts`：执行环境面——`chord` 的 `BACKGROUND_CONTEXT`/`withAbortSignal`、`pi-env` 的远程执行符号。
  - `kernel/extensions.ts`：原 `apps/server/src/kernel.ts` 原样搬入，`index.ts` 重导出 `prepareDoomCordisHostExtension`。
- 交互：12 个调用文件只 import `../kernel/index.ts`；门面本身只做 import + 重导出，不写逻辑（唯一例外是 `extensions.ts` 的既有实现）。内核换实现时改的是门面的转发目标，不是调用点。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段对它的改动 |
|---|---|---|
| `apps/server/src/kernel/*` | L2 接缝：工作台（L1）与内核（L3）之间唯一的编译期边界，承担"内核面"的定义 | 新建 6 个文件 |
| `apps/server/src/sessions/`、`persistence/`、`workspaces/`、`bootstrap/`、`providers.ts`、`packages.ts`、`browser.ts`、`git.ts`、`remote-workspaces.ts` | L1 工作台实现，目前各自记住内核长什么样 | 迁移 import，不改逻辑 |
| `apps/server/package.json` | 依赖声明，决定干净安装能否编译 | 补 `@earendil-works/pi-agent-core` 与 `@earendil-works/chord` |
| `scripts/check-kernel-boundaries.mjs` | 仓库门禁层，`check` 的一部分 | 新建并接入 `check` |

## 5. 为什么改（收益与风险）

- 不做的后果：S9 交棒时要替换 `agent-core` / `coding-agent`，改一个包得摸 12 个文件 33 处；`isModelType` 的深路径让升级 `pi-ai` 变成静默编译失败；两个未声明依赖让 `npm ci` 在 hoist 策略变化时直接崩（`docs/audit/kernel-map.md` §1.1）。
- 做完的收益：不直接改变 `04-roadmap.md` §3 的任何指标（本阶段零行为变化），但它是 S2–S9 的前置——所有"内核动作"阶段从此只改 `kernel/`。
- 新风险：门面变成"第二个内核"（往里写业务逻辑）；`kernel/index.ts` 若重导出整包，等于把桶文件搬到应用侧。缓解：门禁脚本检查 `kernel/` 内除 `extensions.ts` 外无 `apps/` 内部依赖，且每个符号显式列出，不用 `export *`。

## 6. 怎么改（步骤，每步可独立验证）

1. 先钉基线：`cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/adapter.test.ts test/kernel.test.ts test/tool-policy.test.ts`，记录通过数作为搬迁前的行为快照。
2. 拆名字：`git mv apps/server/src/kernel.ts apps/server/src/kernel/extensions.ts`，同步改唯一调用点 `apps/server/src/sessions/pi-runtime.adapter.ts:28`。
3. 建门面：按 §3 写 6 个文件，符号逐个从 `packages/coding-agent/src/index.ts` 摘；`isModelType` 取 `@earendil-works/pi-ai` 公开入口（与 `providers.ts:4` 一致），删掉深路径。
4. 收敛强转：把 `tool-factory.ts:59-78` 三处 `as unknown as ToolDefinition` 换成 `toToolDefinition()`（实现在 `kernel/tools.ts`），调用点不再出现该强转。
5. 逐个迁调用文件：一次一个文件一个 commit，每迁一个跑 `npx tsc --noEmit -p apps/server`；顺序按 `git.ts` → `browser.ts` → `packages.ts` → `persistence/transcript.ts` → `providers.ts` → `sessions/pi-events.ts` → `sessions/tool-factory.ts` → `workspaces/*` → `remote-workspaces.ts` → `bootstrap/create-app.ts` → `sessions/pi-runtime.adapter.ts`（最后，改动最大）。
6. 写 `scripts/check-kernel-boundaries.mjs`：扫描 `apps/server/src` 下除 `kernel/` 外的 `.ts`，命中 `@earendil-works/` 即 exit 1；再校验 `apps/server/package.json` 声明了 `kernel/` 引用的每个包；接进根 `package.json` 的 `check`（放在 `check:ts-imports` 之后）。
7. 补依赖：`apps/server/package.json` 加两个包并 `npm install --package-lock-only --ignore-scripts`；`npm run check` 必须 0 error。

## 7. 验收与度量

| 项 | 命令/方法 | 通过标准 |
|---|---|---|
| import 边界 | `grep -rn "@earendil-works" apps/server/src \| grep -v "kernel/"` | 无输出 |
| 门禁生效 | `node scripts/check-kernel-boundaries.mjs` | exit 0，且根 `check` 已包含它 |
| 类型 | `npx tsc --noEmit` | 0 error |
| 风格 | `npx biome check apps/server/src` | 0 warning |
| 行为表征 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/adapter.test.ts test/kernel.test.ts test/tool-policy.test.ts` | 全绿，与步骤 1 的基线一致 |
| 装配链路 | `cd apps/server; node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/workbench-smoke.test.ts` | 全绿（会话创建、工具授权、流式投影不断） |
| 依赖完整性 | `npm ci --ignore-scripts` 后 `npx tsc --noEmit -p apps/server` | 0 error（证明不再依赖 hoist） |

## 8. 回退

- 开关：无。本阶段不改运行时行为，因此不需要 `PI_KERNEL_*`。
- 回退步骤：`git revert <S1 的 merge commit>` 一步回到 12 文件直连；门面文件整体删除，无残留状态。
- 演练记录（执行后回填）：（待填）

## 9. 风险与不做

- 不做：不收窄内核侧导出面（`packages/coding-agent/src/index.ts` 仍是 495 行全量 barrel）。门面挡在应用侧，内核侧 barrel 收窄属于 S9。
- 不做：不改 `apps/server/test/` 下 10 个直接 `createAgentSession` 的测试文件；门禁只约束 `apps/server/src`。
- 不做：不动 `sessions/pi-events.ts:24` 的 id 合成（`` `${message.role}:${randomUUID()}` ``）。它是 H1 冻结契约的一部分，改了会同时动 `adapter.test.ts` 的 start/end 同 id 断言，留到 S9 与事件契约一起处理。
- 风险：重导出层级过多导致 ESM 循环 import（`kernel/index.ts` ← 调用方，`kernel/*` 之间不互相 import）；缓解是六个模块彼此零依赖，只向 `index.ts` 汇总。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 与计划的偏差：（待填）
- 学到的约束（写进 `02`/`03` 或 ADR）：（待填）
