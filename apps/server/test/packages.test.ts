import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiPackageManager } from "../src/packages.ts";

test("package application can be paused and restored without losing filters", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-packages-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const original = {
		source: "npm:example-plugin@1.2.3",
		extensions: ["extensions/review.ts"],
		skills: [],
		metadata: "preserved",
	};
	await writeFile(join(directory, "settings.json"), JSON.stringify({ theme: "dark", packages: [original] }), "utf8");
	const manager = new PiPackageManager(undefined, directory, async () => {});

	const paused = await manager.setApplied("npm:example-plugin", false);
	assert.equal(paused.applied, false);
	assert.equal((await manager.list()).packages[0]?.applied, false);
	const pausedSettings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")) as {
		theme: string;
		packages: Array<Record<string, unknown>>;
	};
	assert.equal(pausedSettings.theme, "dark");
	assert.deepEqual(pausedSettings.packages[0], {
		...original,
		autoload: true,
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
	});

	const restored = await manager.setApplied("npm:example-plugin", true);
	assert.equal(restored.applied, true);
	const restoredSettings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")) as {
		packages: Array<Record<string, unknown>>;
	};
	assert.deepEqual(restoredSettings.packages[0], original);
});

test("default plugins cannot be uninstalled or unapplied", async () => {
	const manager = new PiPackageManager(undefined, join(tmpdir(), "unused-pi-console-agent"), async () => {});
	await assert.rejects(manager.remove("npm:pi-subagents"), { statusCode: 409 });
	await assert.rejects(manager.setApplied("npm:pi-subagents", false), { statusCode: 409 });
	await assert.rejects(manager.remove("npm:@agimon-ai/doompi-git@2.0.0"), { statusCode: 409 });
});
