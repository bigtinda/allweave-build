<p align="center">
  <img src="docs/brand/build-banner.svg" alt="AllWeave Build · 构序" width="100%">
</p>

<h1 align="center">AllWeave Build · 构序</h1>

<p align="center">
  <strong>让智能形成组织，让协作突破边界。</strong><br>
  从理解项目、修改代码到执行工具，把开发过程放进一个本地工作台。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#能力">能力</a> ·
  <a href="#架构">架构</a> ·
  <a href="#开发">开发</a> ·
  <a href="#安全边界">安全</a>
</p>

---

## 从想法到代码

**AllWeave Build** 是面向本地项目的 AI 编程工作台。它提供浏览器界面、Windows 桌面封装和独立的内核运行时。会话、配置和工具执行都留在本机，模型请求由本地服务直接发往配置的供应商。

产品运行时全部位于本仓库，使用 `@allweave/*` 包命名空间：

- `packages/kernel`：会话状态机、原生循环、工具执行、上下文构建、压缩、扩展和 SQLite 事件存储。
- `packages/kernel-adapters`：模型网关、MCP、工具沙箱和浏览器工具。
- `packages/model`：模型协议、供应商目录、认证、流式和用量统计。
- `packages/sandbox`：基于 QuickJS-WASI 的工具沙箱，随服务端进程内嵌运行。
- `packages/protocol` / `packages/telemetry`：纯 DTO 与遥测支持。

当前版本基线为 **1.2.1**。实现说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

需要 Windows x64、Git 和 **Node.js 22.19 或更新版本**（推荐 24）。

```powershell
git clone https://github.com/bigtinda/allweave-build.git
cd allweave-build
npm ci --ignore-scripts
npm run hydrate:model-data
Copy-Item apps/server/.env.example .env
npm run dev:web
```

打开 **<http://127.0.0.1:5173>**，在“模型与设置”中配置供应商，然后选择项目目录并创建会话。请使用 `127.0.0.1`；本地服务校验 Host 与请求来源，`localhost` 不能直接替换。

Windows 安装包可从 [GitHub Releases](https://github.com/bigtinda/allweave-build/releases) 获取。安装包包含 Node.js、Electron 和工作台运行时；模型凭据仍需自行配置。

![AllWeave Build 构序工作台](docs/brand/workbench.png)

## 能力

| 能力 | 使用方式 |
| --- | --- |
| 项目工作区 | 添加本机文件夹，为不同项目组织会话 |
| 编程会话 | 流式回复、工具执行、会话恢复、撤回与分支 |
| 模型与供应商 | API Key / OAuth / 自定义兼容接口 |
| 工具确认 | plan / ask / auto / full 四种访问模式 |
| 原生工具 | read、write、edit、bash、grep、find、ls、browser |
| 可选扩展 | MCP、工具沙箱、tool search、声明式 app plugins |
| Windows 桌面 | Electron 封装本地服务，以原生窗口打开工作台 |

## 架构

```text
apps/web/                  React / Vite / MUI / Monaco
apps/server/               Fastify / WebSocket / SQLite
  src/bootstrap/           唯一组合根、访问控制与生命周期
  src/sessions/            原生 runtime、actor、审批、事件投影
  src/workspaces/          本地工作区、文件与 Git
  src/persistence/         会话存储适配与旧 JSONL 迁移读取
apps/shared/               服务端共享类型
packages/protocol/         纯 DTO 与事件 reducer
packages/kernel/           会话、循环、工具、上下文、存储、扩展
packages/kernel-adapters/  模型、MCP、沙箱、浏览器适配
packages/model/            模型 transport / auth / catalog
packages/telemetry/        遥测支持层
packages/sandbox/          QuickJS-WASI 工具沙箱
desktop/                   Electron 桌面封装
```

数据路径：

- `.allweave/console.sqlite`：会话元数据、事件、快照、审批。
- `.allweave/agent/auth.json`、`models.json`：模型凭据与自定义供应商。
- `.allweave/sessions/`：旧版 JSONL 会话，仅用于迁移读取。

## 开发

```powershell
npm run check          # biome、边界门禁、类型检查、Web/Desktop 检查
npm run test:unit --workspace=@allweave/server
npm run build:web
```

- 内核边界由 `scripts/check-kernel-boundaries.mjs --enforce` 强制：`packages/kernel` 不得依赖模型、MCP、沙箱、HTTP 或 UI。
- 新增会话行为优先改 `packages/kernel`；服务端只保留 transport、工作区和产品编排。
- 性能与轻量约束：单进程、无 DI/ORM/消息总线、事件批量写入、稳定前缀缓存、按需加载。
- 沙箱随 `packages/sandbox` 进入仓库，不依赖外部代码模式服务。

## 安全边界

API 与 WebSocket 校验本机 Host、Origin 和同源请求；当前没有通用访问令牌或 Cookie 登录层。文件工具检查授权根目录、真实路径、符号链接和私有配置路径。默认 ask 模式下，命令、写文件和自定义工具逐项确认，等待五分钟自动拒绝。

模型请求、获准命令和可信代码以当前 Windows 用户权限执行。工具批准不是 OS 沙箱；本应用面向本机可信项目，不应绑定公网或用于多用户隔离。工具沙箱只用于代码模式脚本，不替代主进程的权限边界。

## 许可证

代码使用 [MIT License](LICENSE)。模型和沙箱支持层包含基于 MIT 许可的衍生代码，原始版权声明保留在许可证文件中；MCP 使用官方 `@modelcontextprotocol/client`。

---

<p align="center">
  <strong>AllWeave Build · 构序</strong><br>
  一念成潮，万象成序。
</p>
