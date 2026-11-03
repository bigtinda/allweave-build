# S8 执行隔离 — 授权不等于隔离

> 图：`S8-sandbox.svg`。周期 4 周。内核动作：把 `bash` 的每一次 spawn 收进一个带默认超时、进程树所有权和路径前置校验的执行端口。

## 1. 一句话目标

"用户点了同意"只回答"要不要跑"，不回答"跑坏了能波及什么"。本阶段补上后半句：任何一条命令都有默认超时、有输出预算、有可回收的进程树，且 spawn 前先过工作区校验。

## 2. 修改前架构

- 现状图：`S8-sandbox.svg` 左半部分。
- 代码入口：`packages/coding-agent/src/core/tools/bash.ts:40-43`（schema）、`:99-164`（本地执行）、`apps/server/src/workspaces/command-operations.ts:17`（本地回落到内建后端）、`apps/server/src/sessions/tool-factory.ts:110-119`（授权与路径校验）、`apps/server/src/security.ts:51`（`workspacePath`）。
- 现状问题（证据）：
  1. 超时是可选项：`packages/coding-agent/src/core/tools/bash.ts:42` 的 schema 自己写着 "no default timeout"，`resolveTimeoutMs`（`:27-38`）在调用方不传时返回 `undefined`，`:132-137` 只有拿到值才挂 `setTimeout`。一条 `npm run watch` 能挂到会话结束。
  2. 子进程就是 server 进程：`bash.ts:112` 用 `shellConfig.shell` 直接 `spawn`，`detached` 只在非 Windows 打开（`:114`）；Windows 上没有任何 job 归属，父进程退出不保证子进程退出。工作台自己也承认这点——`apps/server/src/bootstrap/create-app.ts:134-135` 向 UI 报告 "trusted extensions and approved commands run with host permissions. No sandbox."
  3. 路径校验只护 API，不护命令：`apps/server/src/security.ts:51` 的 `workspacePath`（realpath 逐段 containment）只被文件工具与 HTTP 路由调用；`tool-factory.ts:112-119` 的 `tools.check(path)` 也只覆盖 read/write/edit/ls/find/grep，`bash` 工具不带路径参数，直接跳过。
  4. 本地工作区主动放弃执行层：`apps/server/src/workspaces/command-operations.ts:17` 在 `!workspace.remote` 时返回 `undefined`，于是 `tool-factory.ts:79-85` 把 `operations: undefined` 传给工具，落回 SDK 内建的本地后端——也就是上面第 1、2 条那个后端。

## 3. 修改后架构

- 目标图：`S8-sandbox.svg` 右半部分。
- 新增/修改：
  - `packages/kernel-sandbox/`：目标架构里唯一允许 `child_process` 的包。导出 `ExecRequest`、`ExecResult`、`Sandbox` 端口；Windows 实现 + POSIX 占位。
  - `apps/server/src/sandbox/policy.ts`：`SandboxPolicy { level: "off" | "process" | "job", cwd, allowWrite: string[], timeoutMs, maxOutputBytes, maxCommandsPerRun }`，由工作区配置与 `PI_KERNEL_SANDBOX` 合成，默认 `process`。
  - `apps/server/src/sandbox/exec.ts`：实现 SDK 的 `BashOperations`，在 `spawn` 之前做路径校验，在 `spawn` 之后注入默认超时、输出预算与 spill。
  - `apps/server/src/sandbox/job-object.ts`：Windows Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `ActiveProcessLimit`），创建失败时降级为 `taskkill /T /F`（`packages/coding-agent/src/utils/shell.ts:187-208` 已有实现）。
  - `apps/server/src/workspaces/command-operations.ts:17`：删除本地返回 `undefined` 的分支，本地工作区也返回 `SandboxedExec`。
  - `apps/server/src/bootstrap/create-app.ts:134-135`：`isolation` 字段改为实测等级（`off` / `process` / `job`），不再是自述文案。
- 交互：`tool-factory.ts` 的 `tool_call` 授权不变（H2，仍同步返回 `{block}`）；授权通过后，命令进入 `SandboxedExec`，超时与 kill 在 `kernel-sandbox` 内完成，错误文本沿用 `timeout:${timeout}`（`bash.ts:153`），前端现有分类不破。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段对它的改动 |
|---|---|---|
| `packages/coding-agent/src/core/tools/bash.ts` | L3 工具面：命令工具的定义与本地执行 | 只加"可由外部注入 operations"，不改默认行为 |
| `apps/server/src/workspaces/command-operations.ts` | L2 接缝：把工作区能力注入工具 | 本地不再返回 `undefined` |
| `apps/server/src/sandbox/*` | 新增 L5 执行面：策略、进程、预算 | 全新增 |
| `packages/kernel-sandbox/` | 目标 L5：唯一允许 spawn 的边界 | 全新增，S8 起 `child_process` 只在这里 |
| `apps/server/src/bootstrap/create-app.ts` | L1 组合根：把内核能力装配给 HTTP | `isolation` 改为实测值 |

## 5. 为什么改（收益与风险）

- 不做的后果：一条无超时命令等于把会话生命周期交给脚本；`detached` 在 Windows 不生效，孤儿进程会一直占着端口和文件锁；`command-operations.ts:17` 让"本地工作区"成为唯一没有执行层的路径，恰好是最常用的路径。
- 做完的收益：超时 kill 100%、孤儿进程 0；`tool error rate` 里"超时/被杀"成为可分类的一类，而不是笼统的失败；`cost per resolved task` 不再被挂死命令拖长。
- 新风险：默认超时误杀长构建 → 允许单次调用传 `timeout` 覆盖（`bash.ts:42` 已有参数），并给 `npm`/`cargo`/`gradle` 前缀白名单；Job Object 需要 native 依赖 → 不引 addon，改用 `taskkill /T` 降级路径，Job Object 走可选加载。
- 明确不做：命令内部的重定向（`echo x > ../out`）在 Node 层拦不住，本阶段不承诺"命令写不到工作区外"，只承诺"经工具参数给出的路径被拒"。这条差异写进 §7 的验收口径，避免验收造假。

## 6. 怎么改（步骤，每步可独立验证）

1. 先写失败用例：`apps/server/test/sandbox-exec.test.ts`，用 `PI_CONSOLE_BASH_TIMEOUT_MS=300` 跑 `node -e "setTimeout(()=>{},60000)"`，断言 1s 内返回且错误文本以 `timeout:` 开头。
2. 加 `policy.ts`：先只读环境变量，默认 `off`，避免一上线就改行为。
3. 加 `exec.ts` 并实现 `BashOperations`：包装既有 `createLocalShellOperations`（`bash.ts:99-164`）而不是重写；超时、预算、spill 三层在包装层做。
4. 改 `command-operations.ts:17`：本地也返回 operations；`tool-factory.ts:79-85` 的 `undefined` 分支随之消失。
5. 接 Windows 进程树：`job-object.ts` 先只做 `taskkill /T /F` 降级，Job Object 作为第二步增强；`killProcessTree` 已有 win32 分支（`shell.ts:188-192`）。
6. spawn 前路径校验：对 `cwd` 与 `allowWrite` 逐项走 `workspacePath`（`security.ts:51`）；校验失败返回结构化 `{block:true,reason}` 而不是抛错。
7. 切默认值：`PI_KERNEL_SANDBOX=process`，`/api/settings` 的 `isolation` 改为实测等级。

## 7. 验收与度量

| 项 | 命令/方法 | 通过标准 |
|---|---|---|
| 默认超时 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/sandbox-exec.test.ts` | 300ms 用例 100% 被 kill，错误文本 `timeout:` 可解析 |
| 输出预算 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/sandbox-output.test.ts` | 超 50KB 落 spill，回读内容完整，返回体不超预算 |
| 路径拒绝 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/sandbox-paths.test.ts` | 经工具参数给出的越界路径 100% 拒绝 |
| 进程树 | `cd apps/server && node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/sandbox-tree.test.ts` | 父进程退出后子进程 0 残留（Windows 用 `tasklist` 断言） |
| 授权不破 | `npm run test:unit --workspace=@pi-console/server` | `tool_call` 仍同步 block，现有用例全绿 |
| 类型/风格 | `npm run check` | 0 error |
| 边界 | `node scripts/check-kernel-boundaries.mjs` | `child_process` 只出现在 `packages/kernel-sandbox` |
| 文档 | `node scripts/check-architecture-docs.mjs` | exit 0 |

## 8. 回退

- 开关：`PI_KERNEL_SANDBOX=off|process|job`，默认 `off` 直到 §7 全绿，之后默认 `process`。
- 回退步骤：置 `PI_KERNEL_SANDBOX=off` 重启 server，`command-operations.ts` 恢复返回 `undefined` 的旧分支（开关内保留一个版本），执行路径回到 SDK 内建后端。
- 演练记录：（待填：日期 + 结果）

## 9. 风险与不做

- 不做：容器、AppContainer、`bubblewrap`/`sandbox-exec` 集成——只做调研并写 ADR，不进本阶段验收（与 `00-plan.md` §9 一致）。
- 不做：网络 egress 过滤、CPU/内存硬配额；Job Object 的 `ActiveProcessLimit` 只防进程爆炸，不作为资源配额。
- 不做：把 `bash` 工具重写成"命令白名单"；那会破坏 agent 的通用性，本阶段只加边界不加语法限制。
- 风险：`detached: process.platform !== "win32"`（`bash.ts:114`）的语义差异导致 POSIX 与 Windows 的 kill 行为不同；验收必须双平台各跑一次，不能只看 Linux CI。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 与计划的偏差：（待填）
- 学到的约束：（待填）
