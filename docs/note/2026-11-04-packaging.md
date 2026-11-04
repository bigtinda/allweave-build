# 1.2.1 手动打包

当前 `desktop/desktop.json` 是 `1.2.1`。直接运行带 `-Version` 的默认构建会递增补丁号，因此要用 `-Rebuild` 保持 1.2.1。

## 前置条件

- Windows x64
- Node.js 22.19 或更高
- 已安装仓库依赖：`npm install --ignore-scripts`
- NSIS 3，默认路径 `C:\Program Files (x86)\NSIS\makensis.exe`

## 步骤

从仓库根目录运行：

```powershell
npm run check
./test.sh
powershell -ExecutionPolicy Bypass -File .\desktop\build-installer.ps1 -Rebuild -NsisCompiler "C:\Program Files (x86)\NSIS\makensis.exe"
```

没有把 NSIS 加到 PATH 时，必须传 `-NsisCompiler`。脚本会：

1. 构建 Web 前端；
2. 把服务端、Web 静态资源和桌面壳复制到 `desktop/dist/installer-payload`；
3. 复用或下载 Electron 运行时；
4. 生成安装包和 SHA-256 文件。

## 产物

- `desktop/dist/AllWeaveBuild-1.2.1-windows-x64-setup.exe`
- `desktop/dist/AllWeaveBuild-1.2.1-windows-x64-setup.exe.sha256`

安装包保留 `data/`、`workspaces/` 和 `workspace-roots.txt`，升级不会清空。

## 常见问题

- 构建失败后重试：继续用 `-Rebuild`，不要让它自动递增版本。
- 需要发布 1.2.2：先改代码，再运行不带 `-Rebuild` 的默认构建，或显式传 `-Version 1.2.2`。
- `staging contains application data`：`installer-payload` 里混入了运行数据，删除 `desktop/dist/installer-payload` 后重新构建。
- 构建后先在一台未安装过本产品的 Windows 机器上测试安装、启动、模型配置、OAuth MCP 和卸载。
