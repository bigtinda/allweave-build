import { build } from "esbuild";
import { packager } from "@electron/packager";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const config = JSON.parse(await readFile(join(root, "desktop.json"), "utf8"));
const electronVersion = "45.2.1";
const electronZipDir = join(root, "dist", "electron-cache");
const localElectronZip = join(electronZipDir, `electron-v${electronVersion}-win32-x64.zip`);
const source = join(root, "dist", "shell-source");
await mkdir(source, { recursive: true });
await build({ entryPoints: [join(root, "src/main.ts"), join(root, "src/preload.ts")], outdir: source, bundle: true, platform: "node", format: "cjs", outExtension: { ".js": ".cjs" }, external: ["electron"], target: "node22" });
await writeFile(join(source, "package.json"), JSON.stringify(config));
const output = resolve(process.argv[2] ?? join(root, "dist", "electron"));
await packager({
	dir: source,
	out: output,
	name: "AllWeaveBuild",
	executableName: "AllWeaveBuild",
	platform: "win32",
	arch: "x64",
	electronVersion,
	appVersion: config.version,
	buildVersion: config.version,
	icon: join(root, "icons/icon.ico"),
	overwrite: true,
	asar: true,
	win32metadata: { ProductName: config.productName, FileDescription: config.productName },
	download: { cacheRoot: join(root, "dist", "electron-download-cache") },
	...(existsSync(localElectronZip) ? { electronZipDir } : {}),
});
