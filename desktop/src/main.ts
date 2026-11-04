import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, link, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

let backend: ChildProcess | undefined;
let port = 0;
let quitting = false;
const token = randomBytes(32).toString("hex");
const root = app.isPackaged ? dirname(dirname(process.execPath)) : resolve(app.getAppPath(), "../../..");
const runtime = app.isPackaged ? join(root, "runtime") : root;
const data = join(root, "data");
try {
	mkdirSync(join(data, "webview"), { recursive: true });
	app.setPath("userData", join(data, "webview"));
} catch (error) {
	dialog.showErrorBox("AllWeave Build 启动失败", error instanceof Error ? error.message : String(error));
	app.exit(1);
}
async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("No local port")); server.close(() => resolvePort(address.port)); }); });
}
async function stopBackend(): Promise<void> {
	const child = backend;
	if (!child || child.exitCode !== null) return;
	try { await fetch(`http://127.0.0.1:${port}/api/desktop/shutdown`, { method: "POST", headers: { Origin: `http://127.0.0.1:${port}`, "X-AllWeave-Shutdown-Token": token }, signal: AbortSignal.timeout(3000) }); } catch {}
	await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), new Promise<void>((done) => setTimeout(done, 5000))]);
	if (child.exitCode === null && child.pid) {
		if (process.platform === "win32") await new Promise<void>((done) => { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); killer.on("error", () => done()); killer.on("exit", () => done()); });
		else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
	}
}
async function start(): Promise<void> {
	await mkdir(data, { recursive: true }); await mkdir(join(root, "workspaces"), { recursive: true });
	const config = join(root, "workspace-roots.txt");
	if (!existsSync(config)) await writeFile(config, "# One authorized workspace folder per line.\nworkspaces\n");
	const roots = await Promise.all((await readFile(config, "utf8")).replace(/^\uFEFF/u, "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((path) => { if (path.includes(delimiter)) throw new Error("Workspace path contains a path-list separator"); return realpath(isAbsolute(path) ? path : join(root, path)); }));
	port = await freePort();
	// Give npm and tool subprocesses a real node.exe on PATH without storing a second runtime.
	const node = app.isPackaged ? join(dirname(process.execPath), "node.exe") : process.execPath;
	if (app.isPackaged && !existsSync(node)) {
		try { await link(process.execPath, node); }
		catch { await copyFile(process.execPath, node); }
	}
	const log = createWriteStream(join(data, "desktop-server.log"));
	backend = spawn(node, ["--import", "./scripts/source-resolver.ts", "./apps/server/src/main.ts"], { cwd: runtime, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ALLWEAVE_DESKTOP: "1", ALLWEAVE_PORT: String(port), ALLWEAVE_SHUTDOWN_TOKEN: token, ALLWEAVE_DATA_DIR: data, ALLWEAVE_AGENT_DIR: join(data, "agent"), ALLWEAVE_ROOTS: roots.join(delimiter), PATH: `${dirname(node)}${delimiter}${runtime}${delimiter}${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
	backend.stdout?.pipe(log); backend.stderr?.pipe(log, { end: false });
	let startupError: Error | undefined;
	backend.once("error", (error) => { startupError = error; });
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 180000;
	while (true) {
		if (startupError) throw startupError;
		if (backend.exitCode !== null) throw new Error("Backend exited. See data/desktop-server.log");
		try { if ((await fetch(`${origin}/api/health`, { headers: { Origin: origin }, signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
		if (Date.now() > deadline) throw new Error("Backend startup timed out. See data/desktop-server.log");
		await new Promise((done) => setTimeout(done, 150));
	}
	const window = new BrowserWindow({ title: "AllWeave Build · 构序", width: 1440, height: 960, minWidth: 900, minHeight: 640, frame: false, show: false, webPreferences: { preload: join(app.getAppPath(), "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
	window.once("ready-to-show", () => window.show());
	window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//u.test(url)) void shell.openExternal(url); return { action: "deny" }; });
	window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
	ipcMain.handle("window-control", (event, action: unknown) => { if (event.sender !== window.webContents || event.senderFrame?.url !== `${origin}/` && !event.senderFrame?.url.startsWith(`${origin}/`)) throw new Error("Invalid window sender"); switch (action) { case "minimize": window.minimize(); break; case "toggleMaximize": if (window.isMaximized()) window.unmaximize(); else window.maximize(); break; case "close": window.close(); break; case "isMaximized": return window.isMaximized(); default: throw new Error("Unknown window control"); } });
	await window.loadURL(origin);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", () => { const window = BrowserWindow.getAllWindows()[0]; if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", (event) => { if (!quitting) { event.preventDefault(); quitting = true; void stopBackend().finally(() => app.quit()); } });
	void app.whenReady().then(start).catch(async (error: unknown) => { dialog.showErrorBox("AllWeave Build 启动失败", error instanceof Error ? error.message : String(error)); await stopBackend(); quitting = true; app.quit(); });
}
