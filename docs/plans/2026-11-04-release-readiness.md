# 发布就绪计划

状态：进行中
开始日期：2026-11-04
目标：在不增加内核复杂度的前提下，验证当前原生内核可发布、可回归、可在干净环境运行。

## 基线

- 重构阶段 M0–M6 完成，M5 仅 MCP OAuth 未验证。
- `apps/server` Pi import 为 0，`check:kernel-boundaries --enforce` 生效。
- `npm run check` 通过。
- kernel + server 已运行测试 89/89。
- 完整非 e2e 套件尚未运行；真实 provider、桌面打包、codemode bundled 尚未验证。
- 最近提交：`928aac1c7`。

## 阶段 1：完整回归（进行中）

命令：

```bash
./test.sh
npm run check
npm run benchmark:kernel
```

验收：

- 记录完整测试的通过/失败/跳过数量。
- 失败项区分“本次回归”和“既有环境问题”。
- `npm run check` 与 benchmark 通过。
- 测试产物不写入仓库，`git status` 干净。

当前结果（2026-11-04）：

- 完整非 e2e 套件：**3032 pass / 874 skipped / 0 fail**（合计 3906）。
- `npm run check`：通过。
- `npm run benchmark:kernel`：100 会话列表 0.25 ms、100 delta 8.38 ms / 98,912 B WAL、100 消息 context 0.62 ms；TTFT 0.02 ms、4 个 20 ms 只读工具 35.76 ms。
- 运行条件：
  - `TMPDIR` 必须指向不含 `.agents/skills` 的目录，否则 `test.sh` 主动退出。本次使用 `TMPDIR=D:/pi-test-tmp`。
  - 先执行 `npm run build:offline`。`npm run build` 会访问 models.dev，本机网络超时。
- 修复的回归：
  - 删除引用已删除 CLI 脚本的 `scripts/local-release.mjs` 与测试断言。
  - `kernel-adapters` 测试改用 `scripts/source-resolver.ts`，避免依赖未构建的 dist。
  - `Markdown` 从 `features/chat` 移到 `components`，修复 Web feature boundary 测试。
- 阶段状态：**完成**。

## 阶段 2：真实 provider 验证

前置条件：使用内置 `minimax-cn` provider，API key 通过 `MINIMAX_CN_API_KEY` 或界面写入 `auth.json`。

provider 配置：

- provider：`minimax-cn`
- 协议：`anthropic-messages`
- base URL：`https://api.minimaxi.com/anthropic`（内置；如账号仅支持新域名，可改自定义 provider 为 `https://api.minimax.cn/anthropic`）
- 模型：`MiniMax-M3`（1M 上下文，text+image），备用 `MiniMax-M2.7`（204k 上下文）

当前结果：已通过内置 `minimax-cn` + `MiniMax-M3` 完成首轮真实调用；API Key 由界面写入 `auth.json`。

实测（2026-11-04，`MiniMax-M3`，`thinkingLevel=off/low`）：

| 场景 | 结果 | 记录 |
|---|---|---|
| 流式文本 | 通过 | “OK”，3.19 s，input 11,363 / output 3 |
| 多工具调用 | 通过 | `ls` + `read` 并行，10/11 ms，6.24 s，结果进入下一轮 |
| 审批拒绝 | 通过 | `ask` 模式下 write/bash 均被拒绝，工具标记 failed，run 回到 idle |
| 流式中断 | 通过 | 运行中 abort，1.47 s 回到 idle，无悬挂 run |
| 图片输入 | 通过 | 1×1 PNG 进入 provider context，5.20 s，返回颜色描述 |
| prompt cache | 通过 | 第二轮 `cacheRead=11,264`，后续 11,130/11,145；成本按缓存价计 |
| 上下文压缩 | 未执行 | 1M 窗口，真实触发成本过高；仅单测覆盖 |

发现并修复：`NativeAgentRuntime` 原先用最近一次请求的 usage 覆盖累计值，导致第二轮 `lastRunUsage` 为 `unavailable` 且会话 token 倒退。现在 gateway 在一次 run 内累加各模型轮次，runtime 再累加到会话总量；`apps/server/test/usage-observation.test.ts` 增加两轮回归断言。

未完成：20 轮长会话 RSS、TTFT 与旧 Pi 基线对比（PiEngine 已删除，需保留历史数据或重新建立基线）、真实上下文压缩。

测试矩阵：

| 场景 | 验收 |
|---|---|
| 流式文本 | 增量到达，最终 complete，usage 有值 |
| 单工具调用 | 工具执行一次，结果进入下一轮 |
| 多工具调用 | 只读并行，写工具串行 |
| 审批拒绝 | 工具标记失败，模型收到拒绝原因 |
| 流式中断 | 状态回到 idle，无悬挂 run |
| 图片输入 | 图片进入 provider context |
| 上下文压缩 | 触发 compaction，下一轮可继续 |
| prompt cache | cacheRead/cacheWrite 有真实值 |

指标：

- TTFT、工具调度延迟、上下文构建 p95。
- 长会话 RSS、连续 20 轮稳定性。
- 对比基线：TTFT 偏差 ≤10%，无重复工具调用、无丢失工具结果。

阶段状态：**进行中**。基础场景已通过；长会话与基线指标待测。

## 阶段 3：MCP OAuth

选项：

1. 有真实 OAuth MCP server：完成授权、刷新、重连、工具调用。
2. 没有：明确标记“暂不支持 OAuth”，文档记录 `headers` Bearer token 替代方案。

当前状态：blocked，等待真实 server。

## 阶段 4：桌面打包验证

命令与检查：

```bash
npm run build
```

- 打包 Electron，在干净 Windows 用户下安装、启动、退出。
- 验证 server 子进程、端口、数据目录、升级/卸载。
- 验证 codemode bundled worker/wasm 路径。
- 验证 Chrome DevTools MCP 在打包环境可用。

验收：

- 安装包可启动并完成一轮对话。
- 无缺失运行时文件、无绝对路径依赖。
- 卸载后无残留进程/端口。

当前结果：**安装包已生成，payload 验证通过；安装/升级/卸载自动化未执行**。

已执行（2026-11-04）：

- `build-installer.ps1` 生成 `desktop/dist/AllWeaveBuild-1.1.7-windows-x64-setup.exe`（120 MB），SHA-256 `bf194b49ee05f45fbf5bbcbb744acd3c570dc54b7c3f92ef17e8811a3d830228`。
- 直接启动 `installer-payload/shell/AllWeaveBuild.exe`：创建 `data/console.sqlite`、生成 `shell/node.exe` 硬链接，`/api/health`、`/api/workspaces`、`/api/sessions`、`/api/app-plugins` 均 200，Web UI 正常加载。
- packaged payload 执行 codemode：`return 1 + 1` 返回 `2`，worker 与 QuickJS wasm 路径正常。
- packaged payload 连接 Chrome DevTools MCP：注册 32 个工具，`new_page` 打开 `https://example.com` 成功。

未执行：

- `desktop/test-installer.ps1` 的安装、升级、降级拒绝、运行中锁、卸载测试。脚本要求干净用户配置；本机已有 `AllWeave Build` 安装和快捷方式，直接运行会失败并可能干扰现有安装。
- 安装后的真实用户数据升级验证。

下一步：在干净 Windows 用户（或虚拟机）运行 `test-installer.ps1`；若接受先卸载现有安装，可在本机执行。

## 阶段 5：产品取舍

需要明确：

- CLI：默认不做；如需要，只做薄 HTTP/WS 客户端。
- 远程工作区：已删除；如需要，作为独立后端重新设计。
- doompi/Pi UI 扩展：明确不支持。

## 阶段 6：稳定性收尾

- 崩溃恢复、审批超时、断线重连。
- 大工具输出、长会话、并发会话。
- 日志与诊断。
- 性能基准纳入发布门禁。

## 发布门禁

- `./test.sh` 全绿，或失败项有明确记录且非本次引入。
- `npm run check` 通过。
- 真实 provider 场景矩阵通过。
- 桌面安装包在干净环境通过。
- `docs/note/` 无未解释的 open 项。

## 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| 完整测试存在未发现的回归 | 发布阻塞 | 阶段 1 全量运行 |
| 真实 provider 行为与 faux 不一致 | 运行时错误 | 阶段 2 场景矩阵 |
| 打包缺少 worker/wasm | codemode 不可用 | 阶段 4 专项验证 |
| MCP OAuth 无验收环境 | 功能缺口 | 阶段 3 明确降级 |
