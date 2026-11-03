import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { resolve, dirname, join } from "node:path";
import { _electron } from "playwright-core";

const executablePath = resolve(process.argv[2] ?? "desktop/dist/installer-payload/shell/AllWeaveBuild.exe");
const root = dirname(dirname(executablePath));
const nodeAlias = join(dirname(executablePath), "node.exe");
const hadNodeAlias = existsSync(nodeAlias);
const execute = promisify(execFile);
if (!existsSync(executablePath)) throw new Error(`Missing desktop executable: ${executablePath}`);
if (existsSync(join(root, "data"))) throw new Error("Use a fresh staged runtime without user data for the smoke test.");
let application;
try {
	application = await _electron.launch({ executablePath, timeout: 180000 });
	const page = await application.firstWindow({ timeout: 180000 });
	await page.waitForLoadState("domcontentloaded");
	assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+/u);
	const bridge = await page.evaluate(async () => ({ available: !!window.allweaveDesktop, node: typeof window.require, maximized: await window.allweaveDesktop?.isMaximized() }));
	assert.equal(bridge.available, true);
	assert.equal(bridge.node, "undefined");
	assert.equal(typeof bridge.maximized, "boolean");
	await page.getByRole("button", { name: "最大化", exact: true }).click();
	await page.waitForFunction(() => window.allweaveDesktop.isMaximized());
	assert.equal(existsSync(join(root, "runtime/node.exe")), false, "No duplicate Node binary is shipped");
	assert.equal((await stat(nodeAlias)).ino, (await stat(executablePath)).ino, "NTFS shares the Electron executable without a second disk allocation");
	const fixture = await mkdtemp(join(tmpdir(), "allweave-npm-smoke-"));
	try {
		const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: `${dirname(executablePath)};${join(root, "runtime")};${join(process.env.SystemRoot ?? "C:\\Windows", "System32")}` };
		const nodeResult = await execute(nodeAlias, ["-p", "typeof require('node:sqlite').DatabaseSync"], { env, windowsHide: true });
		assert.equal(nodeResult.stdout.trim(), "function");
		const plugin = join(fixture, "plugin");
		const consumer = join(fixture, "consumer");
		await mkdir(plugin); await mkdir(consumer);
		await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "allweave-local-smoke", version: "1.0.0", main: "index.cjs" }));
		await writeFile(join(plugin, "index.cjs"), "module.exports = 'bundled-runtime-ok';\n");
		await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "allweave-smoke-consumer", version: "1.0.0", private: true, scripts: { smoke: "node smoke.cjs" } }));
		await writeFile(join(consumer, "smoke.cjs"), "if (require('allweave-local-smoke') !== 'bundled-runtime-ok') process.exit(1); console.log('npm-plugin-ok');\n");
		const command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
		const npm = join(root, "runtime/npm.cmd");
		await execute(command, ["/d", "/s", "/c", `""${npm}" install --prefix "${consumer}" "${plugin}" --ignore-scripts --offline --no-audit --no-fund --package-lock=false"`], { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 60000 });
		const installed = await execute(command, ["/d", "/s", "/c", `""${npm}" run smoke --prefix "${consumer}""`], { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 30000 });
		assert.match(installed.stdout, /npm-plugin-ok/u);
	} finally { await rm(fixture, { recursive: true, force: true }); }
	console.log("Desktop startup, window controls, shared Node/SQLite, child node command and offline npm plugin installation passed.");
} finally {
	await application?.close();
	await rm(join(root, "data"), { recursive: true, force: true });
	if (!hadNodeAlias) await rm(nodeAlias, { force: true });
}
