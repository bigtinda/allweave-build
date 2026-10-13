import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareDoomCordisHostExtension } from "../src/kernel.ts";

test("Pi RPC prepares Doom Cordis host before package extensions", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-kernel-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const packageDirectory = join(directory, "npm", "node_modules", "@agimon-ai", "doompi-core");
	const distributionDirectory = join(packageDirectory, "dist");
	await mkdir(distributionDirectory, { recursive: true });
	await writeFile(
		join(packageDirectory, "package.json"),
		JSON.stringify({ name: "@agimon-ai/doompi-core", exports: { "./package.json": "./package.json" } }),
	);
	await writeFile(join(distributionDirectory, "cordisHost.mjs"), "export async function installDoomCordisHost() {};");
	await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: ["npm:@agimon-ai/doompi-git"] }));

	const hostPath = await prepareDoomCordisHostExtension(directory);
	assert.equal(hostPath, join(directory, "pi-console-cordis-host.mjs"));
	const source = await readFile(hostPath!, "utf8");
	assert.match(source, /installDoomCordisHost\(pi, \{ mode: "composed"/u);
	assert.match(source, /session_shutdown/u);

	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({ packages: ["npm:@agimon-ai/doompi", "npm:@agimon-ai/doompi-git"] }),
	);
	assert.equal(await prepareDoomCordisHostExtension(directory), undefined);
});

test("Pi RPC skips the Doom Cordis shim when no DoomPi Core package is installed", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-kernel-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents"] }));
	assert.equal(await prepareDoomCordisHostExtension(directory), undefined);
});
