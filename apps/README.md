# AllWeave Build · 构序 Web 工作台

本地单用户 AI 编程工作台。React 页面通过 Fastify 和 WebSocket 调用仓库内 Pi coding-agent SDK；Pi 源码与服务在同一 Node.js 进程运行，不启动独立内核程序。界面采用 AllWeave Build「构序」的克莱因蓝与中性色主题。浏览器不保存模型密钥，也不直接调用模型 API。

## 启动

需要 Node.js 24.3 或更新版本。首次在仓库根目录执行：

```powershell
npm install --ignore-scripts
npm run hydrate:model-data
Copy-Item apps/server/.env.example .env
```

双击仓库根目录的 `start-web.cmd`，或运行 `npm run dev:web`。打开 <http://127.0.0.1:5173> 即可进入工作台。请使用 `127.0.0.1`，不要替换为 `localhost`；服务只绑定 loopback，并校验本机 Host 与同源请求。

Pi coding-agent SDK 源码位于 `packages/coding-agent`，服务通过 SDK 的 `createAgentSession` 在进程内创建会话。升级 Pi 时更新仓库中的源码并重启服务。

## 模型供应商

打开“模型与设置”，可按类别查看 Pi SDK 注册的所有供应商，并按 Pi 原生登录流程配置 API Key 或 OAuth。API Key、OAuth token 和兼容接口配置保存在 `.pi-console/agent/auth.json` 与 `models.json`；也可以在 `.env` 中提供供应商支持的环境变量。服务端将同一配置目录传给 SDK。

“添加兼容接口”会写入 Pi `models.json`，支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI 与 Pi Messages 协议。添加后可在新供应商行配置凭据。模型目录会呈现 Pi 当前运行时已注册的聊天模型和认证可用状态；是否能连接到外部服务，要在发送真实请求时确认。

## 工作区与会话

默认授权当前仓库。其他工作区须先在 `.env` 的 `PI_CONSOLE_ROOTS` 中加入绝对路径；Windows 用分号分隔。工作区会使用 Pi 的原生工具、Skills、Extensions、提示模板和 JSONL 会话格式。加入工作区等同于信任其 Pi 配置和扩展，扩展会在本机服务进程权限下运行。

SQLite 在 `.pi-console/console.sqlite` 保存会话界面状态，Pi JSONL 会话保存在 `.pi-console/sessions/`。模型登录凭据和 Pi 配置默认在 `.pi-console/agent/`。会话停止后可恢复原始 Pi 上下文。保存的旧控制台会话文件仍可由 Pi 以显式文件路径恢复。

## 聊天与内置浏览器

运行中点击停止按钮可中止当前任务；输入新指令后点击“打断并发送”，会先停止当前任务再处理新指令。用户消息下方提供复制和“撤回编辑”；撤回会让当前 Pi 分支回到该消息之前，并把原文和文件引用放回输入框。AI 回复下方提供复制和分支；分支会保留选中的回复，并让后续输入沿该回复继续。离开的路径仍保留在 JSONL 中。撤回和分支不会回滚已执行的文件修改或网页操作；输入框已有草稿时先发送或清空草稿。

右侧面板顶部提供文件、浏览器和 Git，下方可展开工具与活动记录。拖动面板可压缩聊天区；聊天区窄于约 360px 时，面板会覆盖整个工作区内容区。浏览器与 Agent 的 `browser` 工具共用当前会话的页面，支持网址导航、点击、文字输入、按键、滚动、截图和页面内容读取。“检查页面”“验证交互”及自定义浏览器任务会填入聊天输入框，发送后由 Agent 执行。发送与换行提示、缓存命中率位于输入框下方同一行，窄屏空间不足时换行；点击缓存统计可查看完整用量。

浏览器使用固定版本的 `playwright-core`，依次尝试本机 Edge、Chrome 和已安装的 Playwright Chromium，不自动下载浏览器。每个聊天使用独立的临时浏览器上下文，不读取日常浏览器的登录资料。关闭页面、取消正在执行的浏览器工具或停止服务会清除对应浏览器状态。当前支持 HTTP/HTTPS 和本地项目地址；不支持下载、新窗口和访问工作台自身。`browser` 工具沿用当前权限模式，默认逐次确认。

## 架构

```text
apps/web/                 React / Vite / MUI / Monaco
  src/pages/              会话、模型供应商、Skills 与设置
  src/hooks/              HTTP 状态和 WebSocket 重连
apps/server/              Fastify / WebSocket / Zod / SQLite
  src/kernel.ts           Doom Cordis 宿主扩展兼容加载
  src/providers.ts        Pi 原生认证、供应商目录和自定义模型配置
  src/agent.ts            会话生命周期、事件适配、恢复和工具确认
  src/browser.ts          共用浏览器、页面操作与 Agent 工具
  src/app.ts              REST / WebSocket 路由和访问控制
apps/shared/src/          前后端共享的 TypeScript 协议
```

`npm run build:web` 会生成生产前端。之后运行 `npm run dev --workspace=@pi-console/server`，服务端会从端口 8787 提供前端资源；开发模式下 `npm run dev:web` 会同时启动后端和 Vite。

## 安全边界

服务端使用随机或 `.env` 指定的访问令牌，浏览器换取 HttpOnly Cookie；API 与 WebSocket 校验 Host 和 Origin。文件工具检查授权根目录、真实路径、符号链接和私有配置路径。命令、写文件和自定义工具都要逐项确认，等待五分钟后自动拒绝。

Pi SDK、获准的命令和可信扩展以当前 Windows 用户权限执行。工具批准不是 OS 沙箱；此应用面向本机可信项目，不应绑定公网或用于多用户隔离。
