# 阶段 6：传输层按功能迁出（已完成）

> 完成时间：2026-11-01（6A–6D 四批）。本文件是执行记录。

## 1. 目标

把 `app.ts` 里 600+ 行的"路由 + 组合根"拆成按功能命名的模块，组合根只负责装配；HTTP 与 WS 都只做"协议翻译"，不承载业务规则。

## 2. 做完的改动

| 批次 | 文件 | 迁出的内容 |
|---|---|---|
| 6A | `transport/http/providers.routes.ts`、`resources.routes.ts` | 模型 provider、登录/OAuth、技能与扩展资源 |
| 6B | `transport/http/app-plugins.routes.ts` | 声明式 app plugin 的 manifest、记录、视图查询 |
| 6C | `transport/http/browser.routes.ts`、`transport/websocket/browser-stream.ts` | 共享浏览器（Playwright）的 REST 命令与帧流 |
| 6D | `transport/http/sessions.routes.ts`、`transport/websocket/session-stream.ts` | 会话 REST（170 行）与会话 WS（snapshot + 增量事件） |
| — | `transport/http/workspaces.routes.ts`、`workspaces/command-operations.ts` | 工作区文件、Git、目录选择、远程工作区 |
| — | `transport/http/schemas.ts` | Zod 共享 schema：`idParams`、`fileQuery`、`thinkingLevel`、`accessMode`、`resourceImportFiles` |
| — | `bootstrap/create-app.ts` | 组合根：`createApp(options)` 建服务、Fastify、安全钩子、注册路由、静态前端托管 |

组合根从"什么都做"变成"只做装配 + 安全钩子"：`onRequest` 里做 Host/Origin/同源校验、安全响应头、`ZodError → 400`、`HttpError → statusCode`；`onClose` 里逆序关闭 agents/packages/providers/store。

## 3. 验收

- 6 个路由模块全部被 `create-app.ts` 注册，无孤儿路由（审计脚本 `reachability.json` 可复核）。
- `GET /api/health` 返回 `{status, kernel: {version, integration: "in-process"}}`；`GET /api/settings` 描述真实的安全边界（"Authorized file APIs; trusted extensions and approved commands run with host permissions. No sandbox."）。
- `apps/server/src/app.ts` 当时保留为 6 行兼容 shim；2026-11-03 清理时已删除（0 importer）。

## 4. 结果与遗留

- 得到的能力：每个功能一个路由文件，`create-app.ts` 可读；`registerSessionRoutes` 与 `authorizeSessionWorkspace` 成为会话路径唯一的授权入口。
- **遗留**：①Vite dev 代理（`/api`、`/ws` → 127.0.0.1:8787）与生产"服务端托管 dist"是两条路径，文档需写清；②WS 背压只有 `bufferedAmount > 4MB` 关闭（1013），没有 per-message 限速；③`/api/sessions/:id/messages` 返回 202 + 异步事件，客户端必须靠 WS 才知道结果，这是 S5 要补 resume 的原因。
