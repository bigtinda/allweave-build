import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("synchronizes private dependencies without touching registry aliases or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "allweave-sync-versions-"));
	try {
		await writeManifest(root, "packages/model", {
			name: "@allweave/model",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/kernel", {
			name: "@allweave/kernel",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/app", {
			name: "@allweave/app",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@allweave/kernel": "^1.0.0",
				"@vendor/model": "npm:@allweave/model@1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const appManifest = await readManifest(root, "packages/app");
		assert.equal(appManifest.dependencies["@allweave/kernel"], "^2.0.0");
		assert.equal(appManifest.dependencies["@vendor/model"], "npm:@allweave/model@1.0.0");

		await writeManifest(root, "packages/model", {
			name: "@allweave/model",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
