# S0 基线固化 — 安全网

> 图：`S0-baseline.svg`。周期 1–2 周。内核动作：无（只加测量与门禁）。

## 1. 一句话目标

在动任何结构之前，让"改坏了能被发现"成立：测试门可重复、任务级有 golden traces、8 项指标能采、文档与代码不一致会让 `check` 失败。

## 2. 修改前架构

- 现状图：`S0-baseline.svg` 左半部分。
- 代码入口：`apps/server/test/*.test.ts`、`apps/web/test/*.test.ts`、`scripts/check-*.mjs`、根 `package.json` 的 `check`。
- 现状问题（证据）：
  1. 测试门不绿：`apps/server/test/session-runtime.test.ts:118` 删除未归档会话报 409；`workbench-smoke.test.ts:133` Playwright 文案超时；`session-projection.test.ts` legacy 元数据升级 `actual: 3, expected: 2`。
  2. 没有任何任务级评测（`packages/evals` 只有 harness，未被产品调用）。
  3. 没有指标采集：`pi-telemetry` 未接入工作台，成本/缓存/压缩次数不可见。
  4. 文档与代码漂移无门禁（本轮清理前有 34 处 Tauri、`PI_CONSOLE_TOKEN` 谎报）。
  5. 没有回退约定：后续每阶段都要 flag，但当前没有任何开关框架。

## 3. 修改后架构

- 目标图：`S0-baseline.svg` 右半部分。
- 新增/修改：
  - `apps/server/test/baseline-*.test.ts`：3 个已知失败的修复或显式 `skip` + 原因（每个 skip 必须引用 issue 或阶段号）。
  - `apps/server/test/fixtures/golden/`：20 个任务级 trace（输入、工具序列、最终消息、成本），由 `kernel-testkit` 的 faux provider 驱动，不调真实 API。
  - `scripts/measure-baseline.mjs`：跑 golden traces，输出 `docs/architecture/stages/baseline.json`（8 项指标）。
  - `scripts/check-architecture-docs.mjs`：路径存在、行号不超过文件行数、声明行数误差 ≤5%、相对链接有效、图引用的文件存在。
  - `apps/server/src/kernel/flags.ts`：`PI_KERNEL_*` 开关读取（默认全关），后续阶段复用。
- 交互：`check` 增加两项（`measure-baseline` 只做校验不跑真实模型；`check-architecture-docs` 必跑）。

## 4. 改的是哪一块，这一块在整体架构中的作用

| 块 | 在整体架构中的作用 | 本阶段改动 |
|---|---|---|
| `apps/server/test/` | L1 工作台回归网，防止内核替换时行为漂移 | 修 3 个失败 + 加 20 个 golden trace 用例 |
| `packages/kernel-testkit`（S0 先放 `apps/server/test/kit/`） | 未来所有阶段的双轨对拍基座 | 新建 faux provider 驱动 + trace 录制/回放 |
| `scripts/` | 仓库门禁层（check 的一部分） | 新增 2 个脚本并接入 `check` |
| `apps/server/src/kernel/flags.ts` | 阶段开关的唯一读取点 | 新建；后续 S1–S9 都用它 |

## 5. 为什么改

- 不做的后果：后面每个阶段都只能靠人工点页面验证；失败无法归因（是改坏了还是本来坏的），S5/S9 的内核替换无法判断"语义是否一致"。
- 收益：`turns per task`、`tool error rate`、`cost per resolved task` 有基线；后续每阶段的前后对比才有意义。
- 新风险：golden trace 若录制真实模型输出会依赖外部 API → 一律用 faux provider + 固定响应，禁止真实 key。

## 6. 怎么改

1. 修 `session-runtime.test.ts:118`：测试改为先 `archive` 再 `delete`（实现语义是"归档后才能永久删除"）；`workbench-smoke` 的等待文案改为状态无关的断言（`data-status="disconnected"`）；`session-projection` 的 `expected: 2` 改为读 `SESSION_META_VERSION`。
2. 加 `apps/server/test/kit/faux-harness.ts`：复用现有 `fauxAssistantMessage`/`fauxToolCall`，录制 `{prompt, tools, response}` 到 JSON。
3. 写 20 个 trace 场景（列表见 `docs/architecture/stages/S0-traces.md`）。
4. 写 `scripts/measure-baseline.mjs`：`node scripts/measure-baseline.mjs --write` 生成 `baseline.json`；CI 模式只校验 schema。
5. 写 `scripts/check-architecture-docs.mjs` 并接入根 `check`。
6. 加 `flags.ts`：`readFlag(name, default)`，只读 `process.env`。

## 7. 验收与度量

| 项 | 命令 | 通过标准 |
|---|---|---|
| 测试门 | `npm run test:unit --workspace=@pi-console/server` | 全绿，允许 0 个无原因 skip |
| 前端测试 | `npm test --workspace=@pi-console/web` | 全绿 |
| 文档门禁 | `node scripts/check-architecture-docs.mjs` | exit 0 |
| 全量检查 | `npm run check` | 0 error |
| 基线 | `node scripts/measure-baseline.mjs --check` | `baseline.json` 存在且 8 项齐全 |

## 8. 回退

- 开关：无（本阶段不改运行时行为）。
- 回退步骤：删除新增脚本与 `check` 中的两行调用即可；测试修复单独 commit，可单独 revert。

## 9. 风险与不做

- 不做：真实模型评测（成本不可控）、覆盖率统计（S2 再接）。
- 风险：把"已知失败"用 skip 掩盖；规则是每个 skip 必须写原因与到期阶段，S9 前清零。

## 10. 复盘（执行后回填）

- 实际耗时：（待填）
- 偏差：（待填）
- 学到的约束：（待填）
