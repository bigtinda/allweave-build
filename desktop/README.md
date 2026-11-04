# AllWeave Build Windows 安装包

桌面程序通过 Electron 启动随包提供的本地服务，在原生窗口中显示 React 工作台。自研内核以源码方式在本地服务进程内运行，关闭窗口时停止服务进程树。

## 构建

需要 Windows x64、Node.js 22.19+、NSIS 3，以及已安装的仓库依赖。从仓库根目录运行：

```powershell
.\desktop\build-installer.ps1 -NsisCompiler C:\path\to\NSIS\makensis.exe
```

开发预览在仓库根目录运行 `npm run dev:web`，或双击 `start-web.cmd`，打开 <http://127.0.0.1:5173>。前端通过 Vite 热更新，后端由 Node.js 运行。

编译器在 PATH 或默认安装目录中时可省略参数。脚本构建 React 界面和 TypeScript 桌面程序，输出 `desktop/dist/AllWeaveBuild-<版本>-windows-x64-setup.exe` 与 SHA-256 校验文件。`installer-payload` 是编译用的中间目录，不用于分发。

Electron 运行时 ZIP 优先从 `desktop/dist/electron-cache` 复用；首次缺少缓存时，下载文件缓存在 `desktop/dist/electron-download-cache`。保留 `desktop/dist` 可避免后续打包重复下载大型 Electron 运行时；这些缓存不会进入安装包。

安装包内置 Electron Chromium 运行时，目标电脑无需单独安装 WebView2。
后端与 npm 复用 Electron 内置的 Node.js，不再另带独立 Node 可执行文件。首次启动会在 `shell/` 创建 `node.exe` 硬链接，供工具子进程使用；不支持硬链接的文件系统会回退为复制。运行时保留源码和资源，排除重复的编译目录与调试 source map。

## 版本与升级

桌面产品版本独立于内核版本。`desktop.json` 为版本来源，构建脚本同步 EXE 文件属性、安装包文件名、Windows 已安装应用版本和安装目录中的 `version.txt`。

- 每次运行默认递增补丁号，如 `0.1.2` → `0.1.3`。
- 发布新功能版本时使用 `-Version 0.2.0`，必须高于当前版本。
- 构建开始时即预留版本号。失败后使用 `-Rebuild` 重试同一版本；已交付版本发生代码变化时必须重新运行默认构建以递增版本。
- 安装新版本会复用已登记的安装目录、替换旧版 Node.js 运行时，并保留 `data/`、`workspaces/` 和 `workspace-roots.txt`。
- 安装或卸载前需要关闭软件。当前通过安装包升级，不含联网自动更新服务。

```powershell
# 下一次更新，自动增加版本号
.\desktop\build-installer.ps1

# 明确指定更高版本
.\desktop\build-installer.ps1 -Version 0.2.0

# 当前 1.2.1 直接打包，不再递增版本
.\desktop\build-installer.ps1 -Rebuild

# 重试失败的构建，不再次增加版本号
.\desktop\build-installer.ps1 -Rebuild
```

## 工作区与数据

默认授权安装目录中的 `workspaces/`。在 `workspace-roots.txt` 中每行添加一个已存在的目录，相对路径以安装目录为基准；修改后重启软件。会话、模型配置、插件和浏览器数据（Electron `userData`，位于 `data/webview`）保存在安装目录的 `data/`，安装目录必须可写。

备份时同时保存 `data/`、`workspaces/` 和 `workspace-roots.txt`。
