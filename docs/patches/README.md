# 上游改动记录（patch）

本目录保存 **fork 内对上游 Pi 代码（`packages/**`）的全部改动**。目的有两个：

1. 上游发新版时，能一眼看出"我们改了什么"，按 patch 重放或放弃；
2. 评审时把"我们自己的代码"和"上游代码"分开，避免 fork 越改越难同步。

不改 `packages/**` 的阶段不需要在这里登记任何东西。

## 1. 什么时候必须留 patch

- 修改 `packages/coding-agent/src/**`、`packages/ai/src/**` 等上游文件的行为或导出；
- 在 `packages/**` 内新增文件（例如未来 `packages/kernel-loop`，如果它从上游文件派生）；
- 修改上游的测试、类型、构建脚本。

**不需要**留 patch：只改 `apps/**`、`desktop/**`、`scripts/**`、`docs/**`；以及在 `packages/**` 里只改本 fork 自己新增的文件（那属于自研代码，用普通提交管理）。

## 2. 命名

```
docs/patches/<阶段>-<两位序号>-<slug>.patch
```

例：`S5-01-extract-compaction-controller.patch`、`S9-02-replace-outer-loop.patch`。

一个逻辑改动一个 patch，不按提交拆；同一阶段内按应用顺序编号。

## 3. 生成与校验

```bash
# 生成（只包含 packages/ 下的改动，按路径过滤）
git diff --relative -- packages > docs/patches/S5-01-extract-compaction-controller.patch

# 反向应用自检（确认 patch 完整、无上下文丢失）
git apply --check --reverse docs/patches/S5-01-extract-compaction-controller.patch
```

patch 内容必须能对**改动前的上游基线**应用；如果 patch 依赖同阶段另一个 patch，在文件头注释里写清前置 patch 名。

## 4. 文件头格式

每个 patch 文件开头加一段注释（不参与 `git apply` 的元数据行）：

```text
# 阶段：S5 压缩子系统抽取
# 上游基线：packages/coding-agent/src/core/agent-session.ts @ 4398 行版本（commit 308dae0d2）
# 目的：把 2714–3256 的压缩三入口抽到 kernel-contracts 端口实现
# 影响：行为不变；AgentSession 减少约 550 行
# 回退：删除本 patch 对应的调用点替换，恢复直接调用
# 关联：docs/architecture/stages/S5-compaction.md 第 8 节
```

## 5. 登记表

| patch | 阶段 | 触及的上游文件 | 状态 |
|---|---|---|---|
| （暂无） | | | |

新增 patch 时同步更新本表；阶段文档第 8 节（回退）必须引用对应 patch 名。

## 6. 同步上游的流程

1. 拉取上游新版本，先合并 `packages/**` 的**未改动**部分；
2. 逐个 `git apply` 本目录的 patch，冲突时以 patch 头注释里的目的为准重写；
3. 跑 `npm run check` 与对应阶段的验收命令；
4. patch 失效或被上游吸收时，删除文件并在登记表标注"已吸收"。
