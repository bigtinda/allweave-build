# 阶段 1：测试门（已完成）

> 完成时间：2026-10-31。本文件是**执行记录**，不是计划；后续阶段以此为基础。

## 1. 目标

在任何结构性改动之前，先让"改坏了能被发现"这件事成立：给工作台加上可重复运行的单元/集成测试入口，并让根 `check` 能挡住类型与契约错误。

## 2. 做完的改动

| 文件/入口 | 作用 |
|---|---|
| `apps/server/test/*.test.ts`（`node --test`） | 服务端集成测试：会话生命周期、审批、投影恢复、workspace 访问、浏览器、Git、远程环境、插件 |
| `apps/server/package.json` 的 `test:unit` | `node --import ../../packages/coding-agent/src/experimental/source-resolver.ts --test test/*.test.ts`，让测试直接跑源码而不是构建产物 |
| `apps/web/test/*.test.ts` | 前端纯逻辑测试（`node --test`）：特性边界、动效、偏好、请求活动 |
| `apps/web/test/feature-boundaries.test.ts` | 用 TypeScript AST 强制 `features/` 的导入边界（只允许自身、components、hooks、services、stores、theme、shared；跨特性只能走该特性的 `features/<name>/index.ts`；禁止 `node:` 与 `@earendil-works`） |
| `packages/coding-agent/src/experimental/source-resolver.ts` | 源码解析器：让 `@earendil-works/*` 在未构建时解析到 `src/`，是测试与 `dev:web` 的共同前提 |
| 根 `package.json` 的 `check` | `biome check` + 依赖/导入图/锁文件检查 + `tsc --noEmit` + `check:web` |
| `scripts/check-*.mjs` | `ts-relative-imports`、`entry-graphs`、`pinned-deps`、`runtime-deps`、`lockfile-commit` 等静态门禁 |

## 3. 验收

```bash
npm run check                                  # 通过（当时基线）
npm run test:unit --workspace=@pi-console/server
npm test --workspace=@pi-console/web
```

## 4. 结果与遗留

- 测试入口建立后，阶段 2–4 的每个改动都有对应的回归测试（`apps/server/test/session-projection.test.ts`、`session-runtime.test.ts`、`workspace-access` 相关测试）。
- **遗留（转 S0 处理）**：测试基线不稳定，2026-11-03 复跑有 3 个失败：`session-runtime.test.ts:118`（删除未归档会话，实现要求先归档、测试未更新）、`workbench-smoke.test.ts:133`（Playwright 文案超时）、`session-projection.test.ts`（legacy 元数据升级 `actual: 3, expected: 2`）。这三项与后续清理无关，但会让"测试门"名不副实，S0 必须先修复或显式标注。
- 未做：测试覆盖率统计、CI 编排（当前只在本地跑）。
