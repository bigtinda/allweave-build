# AllWeave Build Windows 安装包

桌面程序使用 Tauri 启动随包携带的 Node.js 服务和 Pi SDK，并在原生窗口中显示工作台。关闭窗口会停止服务进程树。

## 构建

GitHub 自动构建见 [Build Windows Desktop](https://github.com/bigtinda/allweave-build/actions/workflows/windows-desktop.yml)。推送桌面相关改动到 `main` 或手动运行后，会生成 Windows x64 安装 EXE 和 SHA-256 文件，存放在该次运行的 Artifacts 中，保留 14 天。流程会检查源码、版本同步以及安装、启动、升级和卸载，全部通过后才上传安装包。

CI 使用提交中的桌面版本，通过 `-Rebuild` 构建。准备新版本时先运行 `./desktop/set-version.ps1` 并提交版本文件。模型数据从 `nix/model-catalog.json` 固定的目录快照恢复，下载后校验 SHA-256，避免实时模型列表变化破坏构建。

需要 Windows x64、Rust 1.90+、Visual Studio C++ Build Tools、Node.js 24.3+、NSIS 3，以及已安装的仓库依赖。从仓库根目录运行：

```powershell
.\desktop\build-installer.ps1 -NsisCompiler C:\path\to\NSIS\makensis.exe
```

构建脚本自动从固定版本的 npm 发布下载缺少的远程 SSH daemon，并校验固定的 SHA-512。文件保存在 `packages/env/bin`，包含 Linux、Android、macOS 和 Windows 的 x64、arm64 版本。开发环境可单独运行 `npm run hydrate:env-daemons`；也可预先放入对应源码工作流生成的文件供离线构建使用。

编译器在 PATH 或默认安装目录中时可省略参数。脚本每次重新构建前端、桌面程序及运行时，输出 `desktop/dist/AllWeaveBuild-<版本>-windows-x64-setup.exe` 和 SHA-256 校验文件。`installer-payload` 是编译用的中间目录，不用于分发。

默认按当前用户安装到 `%LOCALAPPDATA%\Programs\AllWeaveBuild`，无需管理员权限，创建桌面和开始菜单快捷方式，并登记到 Windows 已安装应用。目标电脑需要 Microsoft Edge WebView2 Runtime；缺少时安装程序会提示下载地址并停止安装。也可以将已提取的固定版本运行时包含在安装包内：

```powershell
.\desktop\build-installer.ps1 -WebView2FixedRuntime C:\path\to\fixed-webview2
```

## 版本与升级

桌面产品版本独立于底层 Pi 包版本。`src-tauri/tauri.conf.json` 为版本来源，构建脚本同步 `Cargo.toml`、`Cargo.lock`、EXE 文件属性、安装包文件名、Windows 已安装应用版本和安装目录中的 `version.txt`。

- 每次运行默认递增补丁号，如 `0.1.2` → `0.1.3`。
- 发布新功能版本时使用 `-Version 0.2.0`，必须高于当前版本。
- 构建开始时即预留版本号。失败后使用 `-Rebuild` 重试同一版本；已交付版本发生代码变化时必须重新运行默认构建以递增版本。
- 安装新版本会复用已登记的安装目录，替换程序运行时；安装程序拒绝降级到更低版本。
- 安装或卸载前需要关闭软件。更新和卸载均保留 `data/`、`workspaces/`、`workspace-roots.txt`，包含会话、模型凭据、插件及用户项目。

```powershell
# 下一次更新，自动增加版本号
.\desktop\build-installer.ps1

# 明确指定更高版本
.\desktop\build-installer.ps1 -Version 0.2.0

# 重试失败的构建，不再次增加版本号
.\desktop\build-installer.ps1 -Rebuild
```

升级时退出软件，运行新的安装 EXE 即可。目前通过下载安装包升级，不含联网自动更新服务。

## 工作区与数据

默认授权安装目录中的 `workspaces/`。在 `workspace-roots.txt` 中每行添加一个已存在的目录，相对路径以安装目录为基准；修改后重启软件。会话、插件、Pi 配置和 WebView 数据位于安装目录的 `data/`，安装目录必须可写。

备份时同时保存 `data/`、`workspaces/` 和 `workspace-roots.txt`。Pi SDK 更新通过更新仓库源码后重新构建安装包交付。
