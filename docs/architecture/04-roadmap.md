# 04 路线图与度量

> 对应图：`04-roadmap.svg`。阶段细节见 `stages/S0..S9`；每阶段一张"修改前/修改后"架构图。

## 1. 阶段总表

| 阶段 | 名称 | 内核动作 | 周期（单人） | 依赖 | 产出 |
|---|---|---|---|---|---|
| S0 | 基线固化 | 无（安全网） | 1–2 周 | — | 可重复测试门、golden traces、指标采集、文档一致性脚本 |
| S1 | 内核门面 | 提取（零行为变化） | 1 周 | S0 | `apps/server/src/kernel/*` 唯一出口；5 包/26 符号/33 处引用收敛 |
| S2 | 可观测与成本 | 抽象（接缝） | 2 周 | S1 | OTel span + 8 项指标 + 每轮成本 |
| S3 | 持久化单一事实 | 替换（存储） | 3 周 | S2 | 事件日志唯一写者、checkpoint/resume、in-flight run 恢复 |
| S4 | 上下文预算 | 替换（上下文） | 2 周 | S3 | CJK 感知估算、cache-safe 压缩、结果 spill |
| S5 | 压缩子系统抽取 | 替换（内核减重） | 3 周 | S4 | `core/compaction` 迁出，AgentSession 减约 550 行 |
| S6 | 工具面重构 | 提取 + 抽象 | 3 周 | S5 | 工具注册表、结构化结果、policy 与执行分离 |
| S7 | 扩展宿主与信任 | 抽象（扩展） | 4 周 | S6 | 显式启用、shim、黄金扩展集 |
| S8 | 执行隔离 | 替换（执行面） | 4 周 | S7 | 超时 + Job Object + 工作区挂载；"授权≠隔离"补齐 |
| S9 | 内核 loop 与编排 | 重写（交棒） | 5 周 | S8 | `kernel-loop`/`kernel-orchestrator` 接管，`adapters/legacy-pi` 删除 |

合计约 28 周（单人）；若 S2+S3 合并、S8 并入 S6，约 20 周。

## 2. 内核所有权交棒（每阶段结束时）

| 阶段结束 | 自研占比 | 说明 |
|---|---|---|
| S0 | 0% | 只加测试与度量 |
| S4 | 10% | 上下文预算与估算 |
| S5 | 20% | 压缩 |
| S6 | 35% | 工具面 |
| S7 | 50% | 扩展宿主 |
| S8 | 60% | 执行隔离 |
| S9 | 85% | 主循环 + 编排；Pi 只剩 provider/SDK 适配 |

## 3. 指标（每阶段前后各测一次）

| 指标 | 定义 | 采集点 |
|---|---|---|
| cost per resolved task | 单任务总 token 成本 / 成功任务数 | `kernel-telemetry` |
| cache hit rate | prompt cache 命中 token / 总 prompt token | gateway |
| tool result size p95 | 单次工具结果 token 的 95 分位 | `kernel-tools` |
| turns per task | 解决任务所需 turn 数 | `kernel-loop` |
| tool error rate | 工具失败 / 工具调用 | policy + tools |
| compaction per task | 单任务压缩次数 | context |
| human intervention rate | 需人工审批/打断的任务比例 | policy |
| pass@1 | 任务级评测通过率（20 个任务） | `kernel-testkit` |

## 4. 执行顺序与完成定义

每个阶段必须满足（缺一不算完成）：

1. `stages/S*.md` 六要素写全，"修改后架构"与图一致；
2. 该阶段表征/回归测试通过，`npm run check` 无错误；
3. 指标前后对比写进本文 §3 的表（追加一列）；
4. 回退开关存在且演练过一次；
5. `node scripts/check-architecture-docs.mjs` 通过；
6. 一个独立 commit/PR，描述里引用阶段文档。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 阶段多、周期长 | 每阶段单独发布；S0–S2 可与既有重构并行 |
| 改上游（S4/S5/S9 动 `packages/coding-agent`） | fork 内改，保留 patch：每次修改上游文件都在 `docs/patches/` 留 `.patch` 与理由；上游文件只做"调用点替换" |
| 双轨期成本 | 双轨只保留 30 天，之后强制单轨 + fallback 只读 |
| Windows 沙箱形态不确定 | S8 只承诺"超时 + Job Object"，AppContainer 作为调研项 |
| 扩展生态破坏 | S7 用黄金扩展集（含 `pi-subagents`）度量 |

## 6. 第一批 5 个 PR（S0/S1）

1. `docs: rewrite architecture docs`（本套文档 + 一致性脚本）；
2. `test: add golden traces and baseline metrics`；
3. `refactor(server): add kernel facade`（S1，纯搬运）；
4. `feat(telemetry): wire OTel spans`（S2 第一步）；
5. `fix(persistence): resume in-flight runs`（S3 第一步）。
