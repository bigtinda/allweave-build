# 文档审计报告（AllWeave Build / pi-main）

- 审计日期：2026-11-03
- 仓库：`D:\project\pi-main`，分支 `codex/v1`，HEAD `e40af9b8d "docs: document current code architecture"`
- 方式：逐文件读取 + 对每条结构性声称用 `read`/`grep`/`glob` 回到代码核对，证据记 `路径:行号`
- 性质：只读审计。审计执行时本文件是唯一新增文件，未修改或删除任何既有文件
- 归档说明：本报告记录 2026-11-03 审计时的文档状态。其中列出的旧文档已按 `docs/architecture/00-plan.md` 删除，路径与结论只作证据保留，不代表现状。
- 范围：`docs/**`、根 `README.md`/`README.interview.md`/`README.pi.md`/`AGENTS.md`、`apps/README.md`、`desktop/README.md`、`desktop/AGENTS.md`、`apps/server/.env.example`（任务提到的 `apps/*/README.md` 实际只有 `apps/README.md` 一份；`apps/server`、`apps/web`、`apps/shared` 下均无 README）

## 1. 结论摘要

1. 分层、持久化、安全边界这三类描述整体可信：`project-architecture.md`、`harness-assessment.md`、阶段 05–15 的关键证据（行数、表结构、权限矩阵、事件类型、测试数量）经抽查与代码一致。
2. 但"桌面外壳"维度系统性过期：8 份文档 + 4 张图仍写 Tauri/Rust/WebView2，实际已是 Electron；`desktop/src-tauri/` 在工作区已删除，`desktop/src/main.ts` 直接 `import { app, BrowserWindow } from "electron"`。
3. `03-refactoring-plan.md` 阶段 0–6 的完成声明与 `apps/server/src` 现状吻合（`bootstrap/`、`transport/`、`sessions/`、`workspaces/`、`persistence/` 均在，`app.ts` 缩为 6 行兼容 re-export），阶段记录可作为历史追溯，但不应继续充当"当前设计"。
4. 必须修的硬矛盾有 5 处：Node 版本（`engines >=22.19.0` vs 文档 `24.3+`）、根 README"校验访问令牌"（代码无 token 层）、"Pi RPC 控制内核"（实际进程内 SDK）、`apps/server/.env.example` 的 `PI_CONSOLE_TOKEN`（代码零引用）、`current-code-architecture.*` 整篇按 Tauri 书写。
5. `16-kernel-split-plan.md` 是提案而非现状（`packages/` 下无 `kernel-*`），其行数断言全部精确，但需与"当前实现"分区，并与路线图 SVG 统一工期。

## 2. 总表

| 文件 | 判定 | 主要问题（一句） | 证据 |
| --- | --- | --- | --- |
| `README.md`（根） | 重写（局部） | Node 24.3+、访问令牌、Pi RPC、WebView 数据四处与代码不符 | `package.json:76`；`apps/server/src/bootstrap/create-app.ts:74-102`；`create-app.ts:61` |
| `README.interview.md` | 重写（局部） | 引用旧界面截图、Node 24.3+、指向含过期 token 的 `.env.example` | `docs/brand/workbench.png`（2026-10-13）；`apps/server/.env.example` |
| `README.pi.md` | 保留 | 上游 Pi 项目 README，与本 fork 代码无关，仅需标注"上游原文" | 全文为 pi.dev 徽章与上游链接 |
| `AGENTS.md`（根） | 保留 | 规则引用的脚本与命令均存在，无过期结构性事实 | `npm run check`、`test.sh`、`.pi/skills/interactive-testing.md` 均存在 |
| `apps/README.md` | 重写（局部） | Node 24.3+；目录树仍写 `hooks/` 负责 HTTP 状态/WS 重连，缺 `features/`、`workspaces/` | `apps/web/src/hooks/` 仅剩 `useSpringLayout.ts`；`apps/web/src/features/chat/` |
| `apps/server/.env.example` | 重写 | `PI_CONSOLE_TOKEN` 在服务端代码中零引用 | `grep PI_CONSOLE_TOKEN apps/server/src` → NO MATCH |
| `desktop/README.md` | 保留（微调） | Node 24.3+；"WebView 数据位于 data/" 实为 Electron userData | `desktop/src/main.ts:17-18` |
| `desktop/AGENTS.md` | 保留 | 与安装器/版本脚本一致，无过期事实 | `desktop/build-installer.ps1:4-5,27`；`desktop/desktop.json` version 1.1.6 |
| `docs/workbench-ui.md` | 重写 | 规范本身可用，但混入一次性验收流水（"Step 5 Preview Free 返回连接错误"） | 全文 65 行；`apps/web/src/theme/personalization.ts` 存在 |
| `docs/plugin-architecture.md` | 重写 | 引用 `app.ts`/`agent.ts` 旧职责与 `desktop/src-tauri/src/main.rs`；"Cookie 验证"不存在 | `:27`、`:28`、`:32`、`:258` |
| `docs/rebuild-frontend/implementation-notes.md` | 归档 | 首节整段 Tauri 无边框窗口/ACL/WebView2 实测已失效，其余为一次性流水 | `:3-9`；`desktop/src/main.ts:62,66` |
| `docs/rebuild-frontend/refactoring-plan/README.md` | 归档 | 状态"待实施"已过期，设计方案（#002FA7、product.css）已落地 | `implementation-notes.md`；`apps/web/src/theme/` |
| `docs/brand/build-banner.svg` | 保留 | 品牌横幅与当前品牌一致 | SVG title `AllWeave Build · 构序` |
| `docs/brand/workbench.png` | 归档 | 2026-10-13 旧界面截图，早于 2026-11-02 整产品重设计 | 文件修改时间 2026/10/13 13:26 |
| `docs/architecture/README.md` | 重写 | 索引把过期快照列为"当前实现"，且未区分提案/历史/已删除项 | `:7-9`、`:19` |
| `docs/architecture/01-current-architecture.md` | 归档 | 全篇 Tauri+WebView2 与 `app.ts` 行号，但与现状矛盾；作为"重构前认知"有追溯价值 | `:13`、`:24`、`:48`、`:70`、`:107`、`:121`、`:181`；`:12`、`:40` |
| `docs/architecture/02-target-architecture.md` | 归档 | 目标形态约 80% 已落地；Tauri、`desktop/src-tauri/` 目录、`app.ts` 行号失效 | `:47`、`:56`、`:311`、`:331`；`apps/server/src/` 现状 |
| `docs/architecture/03-refactoring-plan.md` | 归档 | 阶段完成声明与代码一致，但 HEAD/Tauri 表述过期，只应作历史 | `:11`（HEAD 308dae0d）；`:3`、`:118`、`:281` |
| `docs/architecture/04-baseline.md` | 归档 | 一次性基线测量；含 Tauri 桌面宿主描述 | `:35` |
| `docs/architecture/05`–`15`（11 份） | 归档 | 历史实施台账（验证命令+结果+遗留），无目标设计；个别 Tauri 措辞 | `06:5`；`10:31`；`04:35` |
| `docs/architecture/16-kernel-split-plan.md` | 保留（提案） | 未实施（`packages/` 无 `kernel-*`）；DSH 路径前提失效；工期与 SVG 不一致 | `:11` vs `kernel-split-roadmap.svg:4`；`:23` |
| `docs/architecture/legacy-issues.md` | 保留 | 仅剩 L25，内容与现状一致 | 全文 16 行 |
| `docs/architecture/current-code-architecture.md` | 删除 | 与 `project-architecture.md` 重复且 Tauri/行号错误更多 | `:16`、`:40`、`:52`、`:120` |
| `docs/architecture/current-code-architecture.svg` | 删除 | 图内写 "Tauri 桌面壳 / Rust + WebView2"、"端口由 Rust 动态分配" | `:43-44`、`:107` |
| `docs/architecture/current-code-architecture.png` | 删除 | 上述快照的位图版本 | 同 `.md` |
| `docs/architecture/project-architecture.md` | 重写（局部） | 桌面章节与 §12 整节为 Tauri 实现；其余约 90% 准确 | `:48`、`:61`、`:136-152`、`:169`、`:714-735`、`:857` |
| `docs/architecture/project-architecture.svg` | 重写（局部） | 节点写 "Tauri/Rust 外壳 + WebView2" | `:16`、`:138` |
| `docs/architecture/harness-assessment.md` | 保留（微调） | 代码证据行号基本精确；`WebView2` 表述与 "desktop（Electron/WebView2）" 需改 | `:48`、`:93` |
| `docs/architecture/harness-layers.svg` | 删除 | 孤儿资产（无文档引用）且含 "Tauri 外壳 + WebView2" | `:16`；`grep` 无引用 |
| `docs/architecture/kernel-split-current.svg` | 保留（微调） | 仅 "Electron + WebView2" 需去掉 WebView2 | `:17-18` |
| `docs/architecture/kernel-split-target.svg` | 保留 | 与 16 文档 §3 一致 | — |
| `docs/architecture/kernel-split-roadmap.svg` | 保留（微调） | 工期 "20–24 周" 与 16 文档 "21–25 周" 不一致 | `:4` vs `16:11` |

统计（共 42 份被审对象）：删除 4、归档 18（含 05–15 共 11 份阶段记录）、重写 9、保留 11（其中 `desktop/README.md`、`harness-assessment.md`、`kernel-split-current.svg`、`kernel-split-roadmap.svg` 为"保留+微调"）。

## 3. 逐文件详情（声称 vs 实际）

### 3.1 根目录

**`README.md` — 重写（局部）**

| 声称 | 实际 | 证据 |
| --- | --- | --- |
| "准备 … Node.js 24.3 或更新版本"（:45） | 仓库 `engines.node` 为 `>=22.19.0`；仓库无 `.nvmrc`，CI 亦无 24.3 下限 | `package.json:75-76` |
| "服务默认只监听 127.0.0.1，并校验访问令牌、Host 和 Origin"（:96） | `onRequest` 只校验 Host、Origin、写请求必须带 Origin、`/api` 与 `/ws` 同源；另有桌面关闭令牌（`PI_CONSOLE_SHUTDOWN_TOKEN`），**没有通用访问令牌**；`PI_CONSOLE_TOKEN` 在 `apps/server/src` 零引用 | `apps/server/src/bootstrap/create-app.ts:74-102`；`:43`；`grep PI_CONSOLE_TOKEN` → NO MATCH |
| "本地服务通过 Pi 的 RPC … 控制编程内核"（:131） | 实际是同进程 SDK 调用：`createSession: createAgentSession`；RPC 只存在于 `packages/coding-agent/docs/rpc.md` 所述上游能力，不在工作台链路 | `apps/server/src/bootstrap/create-app.ts:61`；`/api/settings` 返回 `integration: "in-process"`（`:127-137`） |
| "会话、模型配置和 WebView 数据保存在程序旁的 `data/`"（:112） | 目录正确；但 Electron 使用 `userData = data/webview`，"WebView 数据"是 WebView2 时代措辞 | `desktop/src/main.ts:17-18` |

正确的部分（可原样保留）：Electron + TypeScript 主进程、NSIS、无需 Rust（:41、:102-104）；dev 用 `http://127.0.0.1:5173` 且不能用 `localhost`（:69）；生产 8787（:146）；产物名与 `desktop/dist/`（:112，`desktop/compile-installer.ps1:18`）；`workspace-roots.txt`（:114）；安装命令 `npm ci --ignore-scripts`、`hydrate:model-data`、`Copy-Item apps/server/.env.example .env`（:52-56，脚本存在）。

**`README.interview.md` — 重写（局部）**
- 技术栈（:3、:13-16）、Electron 封装（:24）、技术亮点（:28-33：WebSocket 事件序号、SQLite+JSONL 双持久化、工具授权非 OS 沙箱、Playwright 内置浏览器、声明式插件）与代码一致。
- 过期：嵌入 `docs/brand/workbench.png`（:44）为 2026-10-13 旧界面；Node 24.3+（:48）；`Copy-Item apps/server/.env.example .env`（:55）会带出零引用的 `PI_CONSOLE_TOKEN`；:34-40 个人贡献段需作者本人确认，非代码可验证。

**`README.pi.md` — 保留**
- 内容为 Pi 上游项目 README（pi.dev 徽章、上游 CONTRIBUTING 链接），不是本 fork 的架构文档；保留但应在顶部或索引标注"上游原文，非工作台文档"。

**`AGENTS.md`（根）— 保留**
- 未发现 Tauri/Node 版本/端口等结构性声称；列出的命令与文件均核验存在：`npm run check`（`package.json` scripts.check）、`./test.sh`（文件存在）、`scripts/generate-coding-agent-install-lock.mjs`（存在）、`.pi/skills/interactive-testing.md`（存在）、`packages/coding-agent/test/suite/harness.ts`（存在）。

### 3.2 `apps/` 与 `desktop/`

**`apps/README.md` — 重写（局部）**
- 正确：同进程运行 Pi 源码、不启动独立内核（:3）；`127.0.0.1:5173` 与禁止 `localhost`（:15）；`createAgentSession` 进程内（:17）；凭据 `.pi-console/agent/auth.json` 与 `models.json`（:21）；`PI_CONSOLE_ROOTS` 绝对路径、Windows 分号分隔（:27，`create-app.ts:167` 用 `path.delimiter`）；`.pi-console/console.sqlite` 与 `.pi-console/sessions/`（:29）；playwright-core 固定版本与本机浏览器优先（:37）；`build:web` 后由 8787 提供前端（:57）；安全边界整段（:61）与代码逐条吻合，包括"默认 ask 五分钟后拒绝"（`apps/server/src/sessions/tool-authorization.ts:31` `approvalTimeoutMs = 300_000`）。
- 过期：Node 24.3+（:7）；:39 目录树称 `apps/web/src/hooks` 负责"HTTP 状态和 WebSocket 重连"，实际 `hooks/` 只剩 `useSpringLayout.ts`，WebSocket 重连在 `apps/web/src/features/chat/useSession.ts`；目录树完全未列 `apps/web/src/features/`（新架构核心）与 `apps/server/src/workspaces/`、`app-plugins.ts`、`store.ts`。
- 首次安装命令（:11）`node --use-env-proxy scripts/hydrate-pinned-model-data.mjs` 可执行，但与根 README 的 `npm run hydrate:model-data`（`npm --prefix packages/ai run hydrate-model-data`）是两条不同入口，建议统一。

**`apps/server/.env.example` — 重写**
- 导出 `PI_CONSOLE_PORT=8787`、注释掉的 `PI_CONSOLE_ROOTS`/`PI_CONSOLE_DATA_DIR`/`PI_CODING_AGENT_DIR`/供应商密钥（这些变量名与代码一致），但 `PI_CONSOLE_TOKEN` 的注释（"Optional stable console access token (32+ characters). Otherwise generated on startup."）**没有任何代码实现**：`grep PI_CONSOLE_TOKEN apps/server/src` 无匹配。

**`desktop/README.md` — 保留（微调）**
- 正确且与实现一致：Electron 启动随包 Node 服务、进程内 Pi SDK、关闭窗口停止进程树（:3，`desktop/src/main.ts:26-35` 先 `POST /api/desktop/shutdown` 再 `taskkill /T /F`）；dev 5173（:13）；产物名与 SHA-256（:15，`compile-installer.ps1:18`）；electron-cache/electron-download-cache（:17）；内置 Electron Chromium 无需 WebView2（:19）——正好与 `docs/` 多处 WebView2 说法冲突；复用 Electron 内置 Node、首启 `shell/` 建 `node.exe` 硬链接、失败回退复制（:20，`main.ts` 实测）；`desktop.json` 拥有版本、默认递增 patch、`-Version`/`-Rebuild`、升级保留 `data/`/`workspaces/`/`workspace-roots.txt`、无联网自动更新（:24-30，`build-installer.ps1:1-5,27`）。
- 过期/不精确：Node 24.3+（:7）；:45 "WebView 数据位于 data/" 实为 Electron `userData`（`main.ts:17-18`）。

**`desktop/AGENTS.md` — 保留**
- 交付规则（只发 EXE、每次升版本、desktop.json 管版本、升级卸载保留 data/workspaces/workspace-roots.txt、改动后跑 `test-version.ps1`/`test-installer.ps1`）与 `build-installer.ps1`、`desktop.json`（version 1.1.6）、`installer.nsi` 一致，无过期事实。

说明：任务要求审计 `apps/*/README.md`，实际该 glob 只命中 `apps/README.md` 一份；`apps/server`、`apps/web`、`apps/shared` 下没有 README。

### 3.3 `docs/` 顶层

**`docs/workbench-ui.md`（65 行）— 重写**
- 性质：界面规范 + 验收流水混合。规范部分（共享规则 :5、存储卡片每页 8 个 :19、问题与行为变化 :22、Git 管理 :57）无结构性架构声称，代码锚点存在（`apps/web/src/theme/personalization.ts`、`theme/theme.ts`、`workbench.css`、`components/*`、`pages/*`）。
- 过期内容：:43 "验证" 与 :51/:53 是一次性人工验收记录（"此前 Step 5 Preview Free 返回连接错误，未完成成功回复验证"、MiniMax M2.7 真实聊天、390×844、`pwd` 审批），不属于规范。建议把规范部分留下并改写为"UI 规范"，验收流水移入归档或删除。

**`docs/plugin-architecture.md`（298 行）— 重写**
- 定位正确：声明式应用插件 v1（数据布局 `data/plugin-workspace`、`plugins/registry.json`、`releases/<id>/<digest>/plugin.json`、`plugin-data/<pluginId>/<workspaceId>.json`），"当前 Web 服务使用进程内 SDK，未接入 Chord"（:34、:36）与 `create-app.ts:61` 一致；`apps/server/src/app-plugins.ts`（440 行）、`apps/server/src/tool-policy.ts`（17 行）、`apps/web/src/pages/AppPluginPage.tsx`、`apps/web/src/App.tsx` 均存在（:26、:29、:30、:31）。
- 与代码矛盾：:27 说工具装配在 `apps/server/src/agent.ts`（该文件已缩为 152 行门面，装配在 `apps/server/src/sessions/tool-factory.ts`）；:28 说 `apps/server/src/app.ts` 承载"固定默认开发工作区、安装接口、插件数据路由"（该文件只有 6 行兼容 re-export，实现在 `bootstrap/create-app.ts` 与 `transport/http/app-plugins.routes.ts`）；:32 引用 `desktop/src-tauri/src/main.rs`（文件已删除）；:258 "所有新路由沿用现有 Cookie、Host、Origin 和 WebSocket 验证"——**不存在 Cookie 认证层**（`create-app.ts:74-102`）。
- 结构问题：文中"未来代码插件/沙箱/迁移回滚"设计目标与现状混排，需拆分现状与未来。

### 3.4 `docs/rebuild-frontend/` 与 `docs/brand/`

**`docs/rebuild-frontend/implementation-notes.md`（77 行）— 归档**
- :5-9 整节是 Tauri 实现记录：`decorations(false)`/`shadow(false)`、`data-tauri-drag-region="deep"`、`capabilities/main-window.json` ACL、WebView2 远程调试、打包版本 1.1.2。现状是 Electron：`desktop/src/main.ts:62` `BrowserWindow({ frame: false, sandbox: true, preload })`、`:66` `ipcMain.handle("window-control")`，`desktop/src-tauri/` 已不存在，`desktop.json` 版本 1.1.6。
- 其余章节（主题径向揭示、LoadingState、三栏整合、#002FA7 迁移、品牌资源、浏览器验证）是已完成的一次性流水，无稳定结构性价值；作为历史实施记录归档即可。

**`docs/rebuild-frontend/refactoring-plan/README.md`（61 行）— 归档**
- :3 状态"待实施…本文只制定方案，不代表界面、标识或动效已完成"；但 `implementation-notes.md` 与 `apps/web/src/theme` 的 #002FA7 主题迁移、`product.css`、`public/brand/*` 资源表明设计已落地 → 状态过期。
- 内容本身（功能保护清单、视觉规范、品牌 SVG 交付、动效审视表、执行顺序）有价值的部分已被实现吸收，保留价值在于追溯设计意图；建议归档。

**`docs/brand/build-banner.svg` — 保留**：1200×380 品牌横幅，title/desc 与 "AllWeave Build · 构序" 品牌一致。
**`docs/brand/workbench.png` — 归档**：2026-10-13 旧版工作台截图，早于 2026-11-02 的整产品重设计；被 `README.interview.md:44` 引用，重写根文档时应换新截图或删除引用。

### 3.5 `docs/architecture/`

**`docs/architecture/README.md`（索引，43 行）— 重写**
- 声称："当前实现" = `project-architecture.md`（主文档）+ `project-architecture.svg` + `current-code-architecture.md`（"2026-11-01 的容器与组件快照"，:7-9）。实际 `current-code-architecture.md` 通篇按 Tauri 写、行号失效，不能作为当前实现；索引也未标注 16 文档为"提案、未实施"。
- 正确的部分：`harness-assessment.md` 定位（评估/路线）、16 + 三张 `kernel-split-*.svg` 分组、`:19` "替代 02 的原则 4" 声明、相关文档链接（`workbench-ui.md`、`plugin-architecture.md`、`AGENTS.md`）。
- 建议重建为：当前实现（重写后的 project-architecture + 图） / 评估与提案 / 历史归档（01–15 + 前端实施记录）。

**`01-current-architecture.md`（137 行，2026-10-31 快照）— 归档**
- 系统性错误：`:13`、`:24`、`:48`、`:70`、`:107`、`:121`、`:181` 均把桌面描述为 Tauri/Rust + WebView2，证据指向 `desktop/src-tauri/src/main.rs:195-263`、`desktop/src-tauri/tauri.conf.json:1-17`——该目录在工作区已删除（`git status` 显示 `D desktop/src-tauri/*`），实际实现是 Electron（`desktop/src/main.ts:7,49,62,67`）。
- 行号失效：`:12`、`:40`、`:180` 引用 `apps/server/src/app.ts:145-245`、`:188-225`、`:267-271`、`:279-288`；`app.ts` 现仅 6 行。
- 仍有价值的历史发现：`:30` 记录 "根 package.json `>=22.19.0` vs 工作台 README 24.3+ 不一致"（审计时成立，已在本次文档清理中修正）；`:47` "apps/server 直接依赖清单没有 Pi client/server/protocol"（正确）；`:193` 记录 "README 声称 token→HttpOnly Cookie，代码只有 Host/Origin"（结论正确，该 README 段后来已改写）。作为"重构前认知"归档，不得再作为当前架构引用。

**`02-target-architecture.md`（387 行）— 归档**
- 性质：目标架构（方案 A 渐进式模块化单体）。`:18` 原则 4"Pi 是 Agent runtime 的唯一实现"已被 `docs/architecture/README.md:19` 声明由 16 文档替代。
- 目标形态约 80% 已落地：`apps/server/src/` 现有 `bootstrap/create-app.ts`、`transport/http/{sessions,workspaces,providers,resources,app-plugins,browser}.routes.ts`、`transport/websocket/{session,browser}-stream.ts`、`sessions/{coordinator,event-hub,runtime-registry,pi-runtime.adapter,pi-events,tool-authorization,tool-factory,event-projector,run-usage}.ts`、`workspaces/{service,workspace-access,command-operations,office-preview}.ts`、`persistence/{session-projection,transcript}.ts`；未建的是 `providers/service.ts`、`resources/*`、`app-plugins/service.ts`、`browser/service.ts`、`shared/errors.ts`（这些职责仍在顶层文件）。
- 过期：`:47`、`:56`、`:68`、`:77`、`:172`、`:311`、`:331` 以 Tauri 为桌面技术栈（含 `desktop/src-tauri/` 目录树）；`:31`、`:36`、`:39`、`:40` 引用 `app.ts` 行号（145-265、887-1074、911-935、1029-1060）全部失效；`:30` 仍引用已改写的 `apps/README.md:56-58`。
- 判定：历史目标文档，归档。

**`03-refactoring-plan.md`（299 行）— 归档**
- 阶段 0–9 计划及完成标注（阶段 0→04、1→05、2→06、3→07、4→08、5→09、6→10、7 部分→11/13、8 部分→12/13、9 仅 chat→14）**与 `apps/server/src` 现状一致**：阶段 2 的 `withTransaction`、阶段 3 的 `workspace-access.ts`/`workspaces.routes.ts`、阶段 4 的 `pi-runtime.adapter.ts`/`runtime-registry.ts`/`tool-factory.ts`、阶段 5 的 `coordinator.ts`/`event-projector.ts`/`tool-authorization.ts`、阶段 6 的 `bootstrap/create-app.ts` 与 6 个路由模块全部存在；`:215` 声明"app.ts 暂保留兼容 re-export"已兑现（现 6 行）。
- 过期：`:11` 写 "当前 checkout 为 codex/v1、HEAD 308dae0d"，实际 HEAD `e40af9b8d`；`:3`、`:118`、`:281` 以 Tauri 为兼容前提。
- 判定：可信的历史计划，归档（不要再用它判断当前状态）。

**`04-baseline.md`（137 行）— 归档**
- 阶段 0 一次性基线：HEAD `308dae0d2c…`、快照 2182 文件、聚合 SHA256 `d0908c…`、补丁 SHA256 `AC8325…`、未跟踪 75 个、检查点 `C:\Users\ke\AppData\Local\Temp\opencode\pi-stage0`、Node v26.7.0/npm 12.0.2（CI Node 22）、Windows 10.0.26300，以及 9 条命令的当次输出（build 失败 `opencode-go.ts(14,3)` TS2322、`./test.sh` spawnSync npm ENOENT 等）。
- 无法也无需逐条复核的一次性测量；`:35` 仍写 "Tauri 桌面宿主"。归档。

**`05-stage-1-test-gate.md` … `15-legacy-resolution.md`（11 份）— 归档**
- 全部是"实施内容 + 验证命令与结果 + 完成标准核对 + 遗留问题"的台账，没有目标设计；阶段声明与代码证据一致（抽查：阶段 9 的 `apps/web/src/features/chat/index.ts` 存在、`App.tsx:53` 经该入口装配、`feature-boundaries.test.ts` 与 `workbench-smoke.test.ts` 存在；阶段 7/13 引用的 `apps/server/scripts/benchmark-session-startup.mjs`、`benchmark-stream-writes.mjs` 存在；阶段 8 `run-usage.ts` 19 行）。
- 历史环境事实已不可复现（Node 26.7.0、临时检查点目录、当次 70/71 项测试）；个别 Tauri 措辞（`06:5`、`10:31` 兼容性段落）不构成新错误，但需在归档说明中标注"桌面技术栈当时为 Tauri，现为 Electron"。
- 行数漂移属正常演进（如 `agent.ts` 阶段 5 记 130 行、现 152 行；`app.ts` 阶段 6 记 5 行、现 6 行），不算矛盾。

**`16-kernel-split-plan.md`（390 行，2026-11-02 提案）— 保留（提案）**
- 已核对且准确的断言：`:9` "4398 行的 AgentSession" = `packages/coding-agent/src/core/agent-session.ts` 实测 4398 行；`:56` `coordinator.ts` 660 行 = 实测 660；`:57` `tool-policy.ts` 17 行 = 实测 17；`:59` `apps/shared/src/protocol.ts` 321 行 = 实测 321；`:60` "apps/ 对 pi-protocol/client/server 零 import" 成立（`grep` 无匹配，仅 3 处 `@earendil-works/chord/context`）；`:70` "subagent 能力来自 npm:pi-subagents 扩展" 成立（`apps/server/src/packages.ts:12,15`、`:262`；前端警告 `WorkbenchSettingsPanels.tsx:429`）。
- 未实施（`:3` 自称提案）：`packages/` 下无 `kernel-*` 包、无会话协议 v2，K0–K8 均为规划。
- 需修订：`:23` 以 "DSH checkout `D:\Tools\DSH\resources\app.asar\dsh` 不可得" 作为论证前提，但该路径当前就是本会话运行环境；`:11` "总量约 21–25 周" 与 `kernel-split-roadmap.svg:4` "约 20–24 周" 不一致。文档级问题，不影响代码。
- 判定：保留为"提案/未来计划"，必须与"当前实现"文档物理分区，禁止在现状章节引用。

**`legacy-issues.md`（16 行）— 保留**
- 仅剩 L25（Linux/POSIX 专用验证受阻）一条，其余 L 编号已清空；与 13/14/15 文档的收尾结论一致。

**`current-code-architecture.md`（158 行，已修改）— 删除**
- 与 `project-architecture.md` 主题重复（自称"当前代码架构快照"），且错误更集中：`:16`、`:40`、`:52`、`:120` 写 Tauri/Rust 桌面外壳 + WebView2；`:52` "desktop/src-tauri/src/main.rs 只负责启动 Node、等健康检查、打开 WebView2"——文件不存在；另有 `app.ts` 行号失效。可用的内容（分层图、SQLite 表、事件流）在 `project-architecture.md` 中更准确，删除不损失信息。配套 `.svg`/`.png` 一并删除。

**`current-code-architecture.svg` — 删除**
- `:43-44` "Tauri 桌面壳 / Rust + WebView2"；`:107` "桌面服务端口由 Rust 动态分配"；与 Electron 实现矛盾。

**`current-code-architecture.png` — 删除**
- 同一过期快照的位图版本（可能由 md/svg 导出），无独立价值。

**`project-architecture.md`（858 行，2026-11-02 代码核对）— 重写（局部）**
- 正确且应保留（约 90%）：单进程模块化单体（`:42`）、Pi SDK 进程内（`:43`，`create-app.ts:61`）、投影先提交再发布（`:45`，`event-projector.ts` + `store.ts` 事务）、生命周期编排顺序（`:178-192`）、工具权限矩阵（`:294-308` 与 `tool-policy.ts` 全文一致：`readOnlyTools={read,ls,find,grep}`、`fileMutationTools={write,edit}`、plan=deny / full=allow / auto 写类=allow / 其余 ask）、事件映射表（`:363-374`，与 `apps/shared/src/protocol.ts:253-267` 及 `sessions/pi-events.ts` 一致）、SQLite 表结构（`:446-459` 与 `store.ts:26-31` 的 `workspaces`/`removed_workspaces`/`sessions`/`session_summaries`/`events` 及 `events_session_id` 索引一致）、hydration（`:496-520`）、路径安全 5 步（`:552-562` 与 `security.ts:workspacePath` 一致）、`:831` 明确指出 `PI_CONSOLE_TOKEN` 未被使用且与根 README "校验访问令牌"不符（该段可直接复用为矛盾记录）。
- 必须重写：`:48` 决策表 "desktop/src-tauri/src/main.rs 只负责启动 Node、等健康检查、打开 WebView2"；`:61` "desktop/ Tauri/Rust 外壳"；`:136-152` 拓扑图 "Rust / Tauri 外壳 + WebView2"；`:169` "数据目录、工作区根、agent 目录由 Rust 注入"；`:714-735` §12 整节（`:719` "解析 runtime/node.exe"、`:729` "Windows Job Object + 终止进程树"、`:734` "Job Object KILL_ON_JOB_CLOSE"、`:735` "WebView2 用户数据目录 data/webview"）；`:857` 关键文件索引 `main.rs`。实际实现：`desktop/src/main.ts:7` `import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"`；`:17-18` `userData = data/webview`；`:26-35` 关闭时先 `POST /api/desktop/shutdown`，失败/超时再 `taskkill /T /F`（**无 Job Object**）；`:49` `spawn(node, ["--import", …/source-resolver.ts, ./apps/server/src/main.ts], env …)`；`:62` `BrowserWindow({ frame: false, sandbox: true, preload })`；`:66` `ipcMain` "window-control"；`:67` `loadURL(origin)`。
- 其余小漂移：`:5` "分支 codex/v1" 正确，HEAD 已变为 `e40af9b8d`；`:276` 关于 `@agimon-ai/doompi-core` 生成 Cordis 宿主扩展的描述与 `apps/server/src/kernel.ts`（`prepareDoomCordisHostExtension`，62 行）一致。

**`project-architecture.svg` — 重写（局部）**
- `:16` "Tauri/Rust 外壳 + WebView2，随包 Node.js"、`:138` "启动 Node 子进程；WebView2 发起同源请求" → 节点改为 Electron + 内置 Chromium + 随包 Node；其余分层节点与代码一致。

**`harness-assessment.md`（516 行）— 保留（微调）**
- 代码证据基本精确：`:224` `create-app.ts:134-135` "No sandbox"（实测 `isolation` 字符串一致）；`:224` `pi-runtime.adapter.ts:313` `setProjectTrusted(true)`（精确命中，另有 `packages.ts:273`）；`:226` `compaction.ts` chars/4（现文件 1119 行，估算出现在 `:311/:317/:330/:335/:339/:344`）、`:631` `cacheRetention: "none"`；`estimate.ts:15` `const CHARS_PER_TOKEN = 3.5;`；`bash.ts:42` "no default timeout"；`:225` `event-projector.ts` 增量事件与 `saveSession(detail)`（实测 `:345-350`）。
- 需改：`:48`、`:93` "desktop（Electron/WebView2）" → Electron 内嵌 Chromium，不使用 WebView2。
- 文档自述"评估与建议，不是已实施记录"（`:5`），定位正确。

**`harness-layers.svg` — 删除**
- 无任何文档引用（`grep harness-layers` 仅命中自身），且 `:16` 写 "Tauri 外壳 + WebView2"。属孤儿 + 过期资产；若想保留该示意图，应先被 `harness-assessment.md` 链接并重画。

**`kernel-split-current.svg` — 保留（微调）**
- `:9-10` 标题与副标题（"单进程 Fastify 工作台 + 进程内 Pi SDK，2026-11 代码核对"）、`:13-14` React 19 + Vite + Monaco、`:29` "apps/server · 单个 Fastify 进程（模块化单体；阶段 0–9 已把边界拆清）"、`:52-54` "SessionRuntimeRegistry → AgentRuntimeFactory.open() 唯一的 Pi 边界"、`:56-58` "ConsoleStore（node:sqlite / WAL）事件+摘要+快照同事务" 均与代码一致。唯一问题：`:17-18` "Desktop / Electron + WebView2" → 去掉 WebView2。

**`kernel-split-target.svg` — 保留**：与 16 文档 §3 目标结构一致，属提案配图。

**`kernel-split-roadmap.svg` — 保留（微调）**
- 阶段名与 K0–K8 门禁与 16 文档一致；`:4` "合计约 20–24 周" 与 `16:11` "总量约 21–25 周" 不一致，需统一。

## 4. 与代码矛盾清单（可独立复用）

按"重写文档时最容易再犯"排序。每条给出可直接核对的锚点。

- **C1 桌面技术栈是 Electron，不是 Tauri/Rust。** 依据：`desktop/src/main.ts:7` `import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"`；`:49` 用 `spawn(node, ["--import", …/source-resolver.ts, ./apps/server/src/main.ts])` 启动后端；`:62` `new BrowserWindow({ frame: false, sandbox: true, preload })`；`desktop/src-tauri/` 不存在（`git status` 显示 `D desktop/src-tauri/Cargo.toml` 等）。错误文档：`01`（:13,:24,:48,:70,:107,:121,:181）、`02`（:47,:56,:68,:77,:172,:311,:331）、`03`（:3,:118,:281）、`06:5`、`project-architecture.md`（:48,:61,:136-152,:169,:714-735,:857）、`current-code-architecture.md`（:16,:40,:52,:120）、`plugin-architecture.md:32`、`implementation-notes.md:5-9`、`project-architecture.svg:16,138`、`current-code-architecture.svg:43-44,107`、`harness-layers.svg:16`、`kernel-split-current.svg:17-18`。
- **C2 不使用 WebView2。** Electron 内嵌 Chromium（`desktop/README.md:19` 自己也这么写），且 `desktop/src/main.ts:17-18` 把 Electron `userData` 指到 `data/webview`，与 WebView2 无关。凡文档写"WebView2 / WebView2 用户数据目录 / WebView 数据"均为旧表述。
- **C3 Node 版本下限是 `>=22.19.0`**（`package.json:75-76`），不是 24.3。四份文档写成 24.3+：`README.md:45`、`README.interview.md:48`、`apps/README.md:7`、`desktop/README.md:7`。仓库无 `.nvmrc`、无其他 Node pin 文件。
- **C4 没有通用访问令牌 / Cookie 认证层。** `apps/server/src/bootstrap/create-app.ts:74-102` 只做 Host、Origin、写请求要求 Origin、`/api` 与 `/ws` 同源校验，外加桌面关闭令牌 `PI_CONSOLE_SHUTDOWN_TOKEN`（`:43`）；`security.ts:13-17` 的 `tokenMatches` 仅用于关闭令牌。错误表述：`README.md:96`（"校验访问令牌"）、`plugin-architecture.md:258`（"Existing Cookie … validation"）。
- **C5 `PI_CONSOLE_TOKEN` 是死配置。** `apps/server/.env.example` 仍有该变量及"启动时生成"的注释，但 `grep PI_CONSOLE_TOKEN apps/server/src` 零匹配；`project-architecture.md:831` 已正确指出这一点。
- **C6 工作台与内核是同进程 SDK 调用，不是 RPC。** `create-app.ts:61` `createSession: createAgentSession`；`/api/settings` 的 `kernel.integration = "in-process"`（`create-app.ts:127-137`）。`README.md:131` 的 "Pi 的 RPC 控制编程内核" 会误导；`packages/coding-agent/docs/rpc.md` 是上游 CLI 控制能力，不是工作台链路。
- **C7 `apps/server/src/app.ts` 只有 6 行**，所有旧行号引用（145-265、887-1074、911-935、1029-1060、267-271、279-288）全部失效。真实组合根是 `apps/server/src/bootstrap/create-app.ts`（168 行），HTTP 在 `transport/http/*.routes.ts`。
- **C8 `apps/server/src/agent.ts` 是 152 行门面**，工具装配在 `sessions/tool-factory.ts`（270 行）；插件文档仍把它写成工具装配处（`plugin-architecture.md:27`）。
- **C9 插件路由不在 `app.ts`**：`transport/http/app-plugins.routes.ts`（92 行）+ `app-plugins.ts`（440 行）。`plugin-architecture.md:28` 过时。
- **C10 `apps/web/src/hooks/` 只剩 `useSpringLayout.ts`**；WebSocket 重连/HTTP 状态在 `apps/web/src/features/chat/useSession.ts`；前端新架构核心是 `apps/web/src/features/`，`apps/README.md:39` 的目录树未反映。
- **C11 桌面进程终止方式**：`main.ts:26-35` 先请求 `POST /api/desktop/shutdown`，失败或超时后 `taskkill /T /F`；文档里的 "Windows Job Object + KILL_ON_JOB_CLOSE"（`project-architecture.md:729/:734`）不存在。
- **C12 16 文档工期与路线图 SVG 不一致**：`16-kernel-split-plan.md:11` "约 21–25 周" vs `kernel-split-roadmap.svg:4` "约 20–24 周"。
- **C13 16 文档的 DSH 论证前提已过期**：`16:23` 称 `D:\Tools\DSH\resources\app.asar\dsh` 不可得，但该路径是当前 DSH 运行环境（存在）。
- **C14 界面截图过期**：`docs/brand/workbench.png` 为 2026-10-13 截图，早于 2026-11-02 整产品重设计；`README.interview.md:44` 仍引用它。
- **C15 文档里的行数断言多数精确，不要"顺手修正"**：`16:9` agent-session.ts 4398 行、`16:56` coordinator.ts 660 行、`16:57` tool-policy.ts 17 行、`16:59` protocol.ts 321 行均与实测一致；漂移只出现在 `agent.ts`（记录 130 → 现 152）与 `app.ts`（记录 5 → 现 6）这类正常演进处。

## 5. 建议的新文档映射

目标结构：只保留"当前实现 / 评估与提案 / 历史归档"三层，避免再用"快照"型文档维护现状。

- 新 `README.md`（根）§桌面与快速开始、§安全边界 ← 重写 `README.md`（去掉访问令牌、Pi RPC、WebView 措辞；统一 Node 下限为 `>=22.19.0` 或提升 engines）。
- 新 `docs/README.md`（文档总索引）← 重写 `docs/architecture/README.md`（"当前实现"只留重写后的 project-architecture + 图；16 标"提案/未实施"；01–15 移入 `docs/archive/`；删除项不再列出）。
- 新 `docs/architecture/current-architecture.md`（唯一"当前实现"主文档）← `project-architecture.md` 保留内容（模块职责、会话链路、持久化、工具权限、事件映射、路径安全、hydration）+ 从 `current-code-architecture.md` 吸收分层图/SQLite 表/事件流后重画；`current-code-architecture.md/.svg/.png` 整体丢弃；`project-architecture.svg` 重画桌面节点。
- 新 `docs/architecture/harness-assessment.md` ← 原文件基本保留，删 WebView2、更新少量行号。
- 新 `docs/architecture/kernel-split-plan.md`（提案，仓库内可执行规划）← `16-kernel-split-plan.md` + `kernel-split-{current,target,roadmap}.svg`；修正工期不一致与 DSH 前提；`kernel-split-current.svg` 去掉 WebView2；`harness-layers.svg` 丢弃（或重画后被 harness 文档引用）。
- 新 `docs/plugins.md` ← `plugin-architecture.md` 的"现状"部分（修 `app.ts`/`agent.ts`/`create-app.ts`/`app-plugins.routes.ts`/Electron 路径、删除 Cookie 说法）；"未来代码插件/沙箱/迁移回滚"移入"设计目标"章节或直接并入 `kernel-split-plan.md`。
- 新 `docs/ui-spec.md` ← `workbench-ui.md` 的规范部分；验收流水（Step 5/MiniMax/尺寸记录）移入 `docs/archive/ui-acceptance-log.md` 或丢弃。
- 新 `docs/archive/`（历史，不参与"当前实现"引用）← `01-current-architecture.md`、`02-target-architecture.md`、`03-refactoring-plan.md`、`04-baseline.md`、`05`–`15`、`legacy-issues.md`（可留在 archive 顶部注明"仅 L25 未关闭"）、`rebuild-frontend/implementation-notes.md`、`rebuild-frontend/refactoring-plan/README.md`、`docs/brand/workbench.png`；归档说明中统一写"桌面技术栈在 2026-11 由 Tauri 迁至 Electron"。
- `docs/brand/build-banner.svg` ← 保留（品牌横幅）；`docs/brand/workbench.png` ← 换新截图后替换使用处或删除引用。
- `apps/README.md` ← 重写目录树（`features/`、`workspaces/`、`app-plugins.ts`、`store.ts`，`hooks/` 仅 `useSpringLayout.ts`），修正 Node 版本；其余"运行方式/存储/安全边界"可保留。
- `apps/server/.env.example` ← 重写：删除 `PI_CONSOLE_TOKEN`。
- `desktop/README.md` ← 微调（Node 版本、"WebView 数据"改为"Electron userData（data/webview）"）；`desktop/AGENTS.md` 原样保留。
- `AGENTS.md`（根）原样保留；`README.pi.md` 保留并标注"Pi 上游原文"；`README.interview.md` 更新截图与版本要求后保留。
- 丢弃清单（不再有对应文档）：`current-code-architecture.md`、`current-code-architecture.svg`、`current-code-architecture.png`、`harness-layers.svg`、`docs/brand/workbench.png`（归档后由新截图替代）。

---

附：本报告的核对方式说明——所有"实际"列均来自 2026-11-03 工作树实测（`git status` 显示 237 项变更、大量文档未跟踪；`desktop/src-tauri/*` 已删除但仍在 HEAD 中），未运行任何写入型命令（未执行 `npm run check`、未跑构建/测试），仅在仓库内新增本文件。


