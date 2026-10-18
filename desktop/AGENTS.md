# Windows desktop delivery

- Distribute the desktop product only as an installable EXE using `build-installer.ps1`.
- Every delivered software update must increase the desktop version. The build script increments the patch version by default; `-Version` selects an explicitly higher version.
- Use `-Rebuild` only to retry the same release build. Never deliver changed code under an already distributed version.
- `src-tauri/tauri.conf.json` owns the desktop version. Keep `Cargo.toml` and the desktop package entry in `Cargo.lock` synchronized through `set-version.ps1`. This version is independent of upstream Pi workspace versions.
- Upgrades and uninstall must preserve `data/`, `workspaces/`, and `workspace-roots.txt`.
- Run `test-version.ps1` after versioning changes. Run `test-installer.ps1 -Installer <absolute-path>` on a user profile without an existing product installation after installer changes; it installs into a temporary directory and checks startup, upgrade, version checks and retained data.
