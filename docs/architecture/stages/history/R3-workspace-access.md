# 阶段 3：WorkspaceAccess 抽离（已完成）

> 完成时间：2026-11-01。本文件是执行记录。

## 1. 目标

把"授权目录内的文件/命令/Git 访问"收进一个可审计的边界对象，让 Agent 工具、HTTP 路由、远程环境都走同一套路径校验，而不是各自 `path.resolve` 后信任。

## 2. 做完的改动

| 位置 | 作用 |
|---|---|
| `apps/server/src/workspaces/workspace-access.ts`（299 行） | `WorkspaceFiles`（list/read/readImage/readDocument/write）与 `WorkspaceTools`（check/readBuffer/access/write/mkdir/imageMimeType）；`WorkspaceAccess.get(id)` 校验 workspace 存在且位于已授权根内（否则 404 "Authorized workspace not found"） |
| 常量与规则 | `maxEditableFileBytes = 1024 * 1024`、`maxLargeFilePreviewBytes = 256 * 1024`；隐藏/跳过 `node_modules`、`.git`、`.pi`、`.pi-console`、`.env`（含 `.env.*`）；跳过符号链接；NUL 字节判二进制；`revision = sha256(buffer)` |
| 写路径 | `withFileMutationQueue(target, ...)`（导入自 `@earendil-works/pi-coding-agent`）串行化同文件写入；写前比对 revision，不一致返回 409 "The file changed on disk. Reload before saving." |
| 文档/图片 | `readDocument` → `office-preview.ts`（≤20MB）；`readImage` ≤10MB + `detectSupportedImageMimeTypeFromFile` |
| 远程 | 同一接口的远程实现走 `RemoteWorkspaceService`（`checkedPath`/`readBuffer`/`writeFile`/`createDirectory`/`mutationKey`），并通过 `BACKGROUND_CONTEXT`（`@earendil-works/chord/context`）区分后台任务上下文 |
| `apps/server/src/security.ts` | `HttpError`、`contained(root, target)`、`privatePathNames`，是所有校验的公共原语 |
| `apps/server/src/tool-policy.ts`（17 行） | `toolPermission(accessMode, toolName, extraReadOnly)`；只读工具恒 allow，`plan` 全 deny，`full`/`auto` 按文件变更工具区分 |

## 3. 验收

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test apps/server/test/workspace-access.test.ts   # 若文件名不同，按 test/*.test.ts 全量跑
```

通过的行为：路径穿越/私有配置/目录链接被拒绝；远程与本地同路径 identity 独立；写 revision 冲突 409。

## 4. 结果与遗留

- 得到的能力：单一访问边界，本地与远程同一接口，写冲突可检测。
- **遗留**：①校验是"授权"而不是"隔离"——进程仍以当前 OS 用户权限运行，无沙箱（S8）；②`office-preview.ps1` 通过 `fileURLToPath(new URL("./office-preview.ps1", import.meta.url))` 运行时解析，静态扫描会误报为死文件；③`workspace-access.ts` 同时承担本地/远程两套实现，S6 工具面重构时要按"数据面 vs 控制面"再切一刀。
