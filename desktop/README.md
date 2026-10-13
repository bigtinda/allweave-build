# AllWeave Build Windows Desktop

This is a Tauri desktop shell for AllWeave Build (构序). The Rust process starts the bundled Node.js service, opens its frontend in a native Windows window, and stops the service tree when the window closes. The portable package includes the Pi 1.1.0 Windows x64 kernel. Sessions, provider settings, the extracted Pi kernel, and WebView data stay beside the executable.

## Build a portable package

Use Windows with Rust 1.90 or newer, the Visual Studio C++ Build Tools, Node.js 24.3 or newer, and the repository dependencies installed. From the repository root, run:

```powershell
.\desktop\build-portable.ps1 -BuildWeb
```

The script builds the frontend and Rust desktop executable, then creates `desktop/dist/AllWeaveBuildPortable.zip`. Extract the ZIP and run `AllWeaveBuild.exe`. No installer is generated. Omit `-BuildWeb` to package an existing frontend build.

The app uses the installed WebView2 Runtime by default. To make the package independent of that shared runtime, pass the path to an extracted Microsoft Fixed Version WebView2 runtime:

```powershell
.\desktop\build-portable.ps1 -WebView2FixedRuntime C:\path\to\fixed-webview2
```

The bundled Fixed Version runtime is over 250 MB and must be updated along with the app. Microsoft documents the two WebView2 distribution modes [here](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).

## Workspaces and data

The `workspaces` folder is authorized by default. Add existing absolute or relative folder paths to `workspace-roots.txt` to authorize other project locations; restart the app after editing it. User data is stored in the adjacent `data` folder, so the extracted directory must be writable.

To update the Pi kernel, replace `runtime/pi-windows-x64.zip` with a newer official Windows x64 Pi release. The next launch verifies the archive and extracts the new kernel into `data/pi-kernel`.
