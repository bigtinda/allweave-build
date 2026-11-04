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

前置条件：用户提供一个真实 provider 的 API key，或确认使用本机已有凭据。

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

当前结果：等待真实 provider 凭据。当前环境未检测到 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY` 等。

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

当前结果：待执行。

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
