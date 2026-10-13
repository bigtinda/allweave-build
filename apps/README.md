# AllWeave Build · 构序 Web 工作台

本地单用户 AI 编程工作台。React 页面通过 Fastify 和 WebSocket 操作内置 Pi Windows release 的 RPC 内核；仓库包含 `pi-windows-x64.zip`，当前版本为 `1.1.0`，SHA-256 见根目录同名 `.sha256` 文件。界面采用 AllWeave Build「构序」的克莱因蓝与中性色主题。浏览器不保存模型密钥，也不直接调用模型 API。

## 启动

需要 Node.js 24.3 或更新版本。首次在仓库根目录执行：

```powershell
npm install --ignore-scripts
npm run hydrate:model-data
Copy-Item apps/server/.env.example .env
```

双击仓库根目录的 `start-web.cmd`，或运行 `npm run dev:web`。打开 <http://127.0.0.1:5173> 即可进入工作台。请使用 `127.0.0.1`，不要替换为 `localhost`；服务只绑定 loopback，并校验本机 Host 与同源请求。

第一次启动会验证并解压 `pi-windows-x64.zip` 到 `.pi-console/pi-kernel`，会话通过这个目录下的 `pi.exe --mode rpc` 执行。更新内核时，用 Pi 官方 Windows x64 release ZIP 替换仓库根目录的 ZIP，再重启工作台。服务按压缩包 SHA-256 检测变化，把新版解压到暂存目录后切换内核。也可在 `.env` 设置 `PI_CONSOLE_KERNEL_ZIP` 指向另一份 ZIP。

## 模型供应商

打开“模型与设置”，可按类别查看当前 Pi 内核注册的所有供应商，并按 Pi 原生登录流程配置 API Key 或 OAuth。API Key、OAuth token 和兼容接口配置保存在 `.pi-console/agent/auth.json` 与 `models.json`；也可以在 `.env` 中提供供应商支持的环境变量。服务端启动时会把同一个配置目录传给 Pi 内核。

“添加兼容接口”会写入 Pi `models.json`，支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI 与 Pi Messages 协议。添加后可在新供应商行配置凭据。模型目录会呈现 Pi 当前运行时已注册的聊天模型和认证可用状态；是否能连接到外部服务，要在发送真实请求时确认。

## 工作区与会话

默认授权当前仓库。其他工作区须先在 `.env` 的 `PI_CONSOLE_ROOTS` 中加入绝对路径；Windows 用分号分隔。工作区会使用 Pi 的原生工具、Skills、Extensions、提示模板和 JSONL 会话格式。加入工作区等同于信任其 Pi 配置和扩展，扩展会在本机服务进程权限下运行。

SQLite 在 `.pi-console/console.sqlite` 保存会话界面状态，Pi JSONL 会话保存在 `.pi-console/sessions/`。模型登录凭据和 Pi 配置默认在 `.pi-console/agent/`。会话停止后可恢复原始 Pi 上下文。保存的旧控制台会话文件仍可由 Pi 以显式文件路径恢复。

## 架构

```text
apps/web/                 React / Vite / MUI / Monaco
  src/pages/              会话、模型供应商、Skills 与设置
  src/hooks/              HTTP 状态和 WebSocket 重连
apps/server/              Fastify / WebSocket / Zod / SQLite
  src/kernel.ts           ZIP 校验、内核切换和 Pi JSONL RPC 子进程
  src/kernel-guard.ts     工作区路径校验和工具批准扩展
  src/providers.ts        Pi 原生认证、供应商目录和自定义模型配置
  src/agent.ts            会话生命周期、事件适配、恢复和工具确认
  src/app.ts              REST / WebSocket 路由和访问控制
apps/shared/src/          前后端共享的 TypeScript 协议
```

`npm run build:web` 会生成生产前端。之后运行 `npm run dev --workspace=@pi-console/server`，服务端会从端口 8787 提供前端资源；开发模式下 `npm run dev:web` 会同时启动后端和 Vite。

## 安全边界

服务端使用随机或 `.env` 指定的访问令牌，浏览器换取 HttpOnly Cookie；API 与 WebSocket 校验 Host 和 Origin。文件工具检查授权根目录、真实路径、符号链接和私有配置路径。命令、写文件和自定义工具都要逐项确认，等待五分钟后自动拒绝。

Pi 内核、获准的命令和可信扩展以当前 Windows 用户权限执行。工具批准不是 OS 沙箱；此应用面向本机可信项目，不应绑定公网或用于多用户隔离。
