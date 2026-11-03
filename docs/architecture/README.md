# 架构文档

本目录是 AllWeave Build（`pi-monorepo`）的**唯一**架构文档入口。旧的、与代码脱节的文档已在 2026-11-03 重写时整体删除，没有归档副本；历史执行记录（阶段 1–6）保留在 `stages/history/`。

## 1. 阅读顺序

| 顺序 | 文档 | 回答的问题 | 读者 |
|---|---|---|---|
| 1 | [00-plan.md](00-plan.md) | 这次重写/重构为什么做、清理了什么、按什么顺序做 | 所有人，先读这一篇 |
| 2 | [01-project-architecture.md](01-project-architecture.md) | 项目现在长什么样（部署形态、三个 app、七处存储、信任边界） | 新加入的人 |
| 3 | [02-kernel-architecture.md](02-kernel-architecture.md) | 内核（Pi SDK）现在长什么样、为什么难拆 | 要改内核的人 |
| 4 | [03-target-architecture.md](03-target-architecture.md) | 拆完以后的目标结构、包布局与依赖门禁 | 要改内核的人 |
| 5 | [04-roadmap.md](04-roadmap.md) | 十个阶段的关系、周期、指标、完成定义 | 排期与评审 |
| 6 | [stages/](stages/) | 每个阶段具体改哪一块、怎么改、怎么验收 | 执行当阶段的人 |

阶段文档按 S0 → S9 顺序读；每篇都对应一张同名的 SVG 架构图，图在文档第 1 节引用。

## 2. 术语

- **L0–L4 分层**：L0 宿主（Electron / 浏览器）→ L1 工作台（`apps/server`）→ L2 接缝（`apps/server/src/kernel` 门面）→ L3 内核（`packages/coding-agent` 的 `AgentSession`、`packages/ai` 等）→ L4 外部（模型 API、文件系统、Git、SSH、浏览器）。
- **接缝（seam）**：工作台与 Pi 包之间的调用边界。当前是 12 个文件、26 个符号、33 处引用（见 `02-kernel-architecture.md` 第 2 节）。
- **阶段（Sx）**：一次可独立发布的重构批次，一个阶段一个分支/一组 PR，任何提交都可发布。
- **切片**：阶段内的最小动作单元——先用表征测试锁住现状，再提取、加端口、替换、度量，最后写七段复盘。
- **自研占比**：工作台可直接控制、不再依赖 Pi 代码的内核职责比例（S0 0% → S9 85%，见 `04-roadmap.md` 第 2 节）。
- **双轨对拍**：同一组 golden traces 同时跑旧实现（`engine=pi`）与新实现，逐事件比对后再切默认值。
- **patch 记录**：fork 内对上游 `packages/` 的改动必须以 `.patch` 文件留档在 [docs/patches/](../patches/README.md)，便于同步上游。

## 3. 图、文档、阶段的对应关系

| 图 | 配套文档 | 说明 |
|---|---|---|
| [01-project-architecture.svg](01-project-architecture.svg) | 01 | 三种部署形态、apps 三包逐层职责、七处存储、外部依赖、信任边界 |
| [02-kernel-architecture.svg](02-kernel-architecture.svg) | 02 | L1 12 个接缝文件、L2 5 包 26 符号 33 处引用、`AgentSession` 22 个职责区间、三个硬约束 |
| [03-target-architecture.svg](03-target-architecture.svg) | 03 | 四个 surface → 会话协议 v2 → 八个内核模块 → 适配器 → 基础设施，右栏过渡期约束 |
| [04-roadmap.svg](04-roadmap.svg) | 04 | S0–S9 甘特图、自研占比交棒、完成定义与回退纪律 |
| `stages/Sx-*.svg` | `stages/Sx-*.md` | 每个阶段一张：左侧"修改前架构"，右侧"修改后架构"，底部"与现状的差别" |

## 4. 现状事实 vs 计划产物

文档里同时会出现两类路径：

- **已存在**：引用必须能在仓库中找到，行号不得越界，声明行数误差 ≤5%。
- **计划新增**：以阶段编号标注，例如 S0 的 `scripts/measure-baseline.mjs`、S1 的 `apps/server/src/kernel/`、S6 的 `apps/server/policies/`、S8 的 `apps/server/src/sandbox/`。这些路径允许暂时不存在，白名单在 `scripts/check-architecture-docs.mjs` 的 `PLANNED` / `PLANNED_FRAGMENTS` 中维护；路径真正落盘后应从白名单移除。

已删除的历史文档（例如 `01-current-architecture.md`、`project-architecture.md`）只允许在"记录清理事实"的上下文出现，白名单是同一脚本里的 `DELETED` / `HISTORICAL`。`harness-assessment.md` 未删除，已迁到 `docs/audit/` 作为评估证据保留。

## 5. 校验

```bash
node scripts/check-architecture-docs.mjs          # 或 npm run check:arch-docs
```

检查四项：行内代码里的仓库路径存在、`path:行号` 不越界、"`path` NNNN 行"与实测一致、Markdown 相对链接可解析。SVG 另用标签栈解析 + `.NET XmlDocument` 显式 UTF-8 加载双重校验（见 `docs/audit/` 下的临时脚本说明）。

## 6. 历史记录

- `stages/history/R1..R6`：2026-10-31 至 2026-11-01 完成的阶段 1–6 执行记录（测试门、SQLite 原子投影、WorkspaceAccess、Pi runtime adapter、SessionCoordinator、传输层迁出）。它们记录的是**当时的决策**，不再代表现状；现状看 01/02。
- `docs/audit/`：2026-11-03 清理前的审计与评估材料（文档审计、代码审计、内核接缝测绘、harness 评估）及可复跑脚本，用于核对"为什么删这些、为什么先改这些"。这些文件记录的是当时的仓库状态，不是现状。

## 7. 维护规则

1. 一份事实只有一个归属文档；01 讲现状、02 讲内核、03 讲目标、04 讲排期、stages 讲执行，不互相抄。
2. 改代码同时改对应文档与图；`npm run check:arch-docs` 必须通过。
3. 阶段文档写完后不再改结论，只追加"复盘"一节；已发布的历史记录不改。
4. 对上游 `packages/` 的每一处改动都留 patch，并在对应阶段文档第 8 节登记。
5. 新增文档必须在本文件第 1 节和第 3 节登记，否则视为孤儿文档。
