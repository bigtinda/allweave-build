# AllWeave Build · 构序 Web 工作台

本地单用户 AI 编程工作台。React 页面通过 Fastify 和 WebSocket 调用自研内核；内核与本地服务在同一 Node.js 进程运行，不启动独立 CLI 或内核程序。

## 启动

需要 Node.js 22.19 或更新版本。首次在仓库根目录执行：

```powershell
npm install --ignore-scripts
node --use-env-proxy scripts/hydrate-pinned-model-data.mjs
Copy-Item apps/server/.env.example .env
```

双击仓库根目录的 `start-web.cmd`，或运行 `npm run dev:web`。打开 <http://127.0.0.1:5173>。服务只绑定 loopback，并校验本机 Host 与同源请求。

完整的架构、迁移记录和遗留问题见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 与 [../docs/note](../docs/note/)。

## 模型供应商

打开“模型与设置”，配置 API Key、OAuth 或兼容接口。凭据保存在 `.pi-console/agent/auth.json` 与 `models.json`；也可以在 `.env` 中提供供应商环境变量。

“添加兼容接口”支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI、Pi Messages 等协议。模型可用性以实际请求结果为准。

## 工作区与会话

默认授权当前仓库。其他工作区通过 `.env` 的 `PI_CONSOLE_ROOTS` 加入绝对路径；Windows 用分号分隔。远程工作区已移除。

SQLite 在 `.pi-console/console.sqlite` 保存会话元数据、事件、快照与审批；旧版 JSONL 会话只作为迁移来源读取。文件工具检查真实路径、符号链接和私有配置路径。

## 聊天与内置浏览器

运行中可停止任务，或“打断并发送”。用户消息支持撤回编辑，助手回复支持分支；撤回/分支不会回滚已执行的文件修改。

右侧面板提供文件、浏览器和 Git。浏览器使用固定版本的 `playwright-core`，优先使用本机 Edge/Chrome，不自动下载。每个聊天使用独立临时上下文，不读取日常浏览器登录资料。默认 ask 模式下，命令、写文件和自定义工具逐项确认。

## 架构

```text
apps/web/                 React / Vite / MUI / Monaco
apps/server/              Fastify / WebSocket / SQLite
  src/sessions/           原生 runtime、actor、审批、事件投影
  src/workspaces/         本地文件、Git、Office 预览
  src/persistence/        kernel store 适配与旧 JSONL 读取
packages/protocol/        纯 DTO 与事件 reducer
packages/kernel/          会话、循环、工具、上下文、存储、扩展
packages/kernel-adapters/ 模型、MCP、codemode 适配
```

`npm run build:web` 生成生产前端。开发模式由 `npm run dev:web` 同时启动后端和 Vite；生产模式由 Fastify 从 8787 端口提供静态资源。

## 安全边界

API 与 WebSocket 校验本机 Host、Origin 和同源请求；当前没有通用访问令牌。模型请求、获准命令和可信代码以当前 Windows 用户权限执行。工具批准不是 OS 沙箱；应用面向本机可信项目，不应绑定公网或用于多用户隔离。
