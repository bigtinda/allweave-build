import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AppPluginManager, parseAppPluginManifest } from "../src/app-plugins.ts";
import { HttpError } from "../src/security.ts";

function manifest(version: string, required = false, label = "Title") {
	return parseAppPluginManifest(
		JSON.stringify({
			manifestVersion: 1,
			id: "project-tasks",
			name: "Project tasks",
			version,
			description: "Workspace task records",
			fields: [{ id: "title", label, type: "text", required }],
			views: [{ id: "table", title: "Tasks", type: "table" }],
			navigation: [{ id: "tasks", title: "Tasks", viewId: "table" }],
		}),
	);
}

test("application plugin records stay isolated by workspace and persist across manager restart", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".app-plugin-test-"));
	try {
		const workspaceA = randomUUID();
		const workspaceB = randomUUID();
		const manager = new AppPluginManager(directory);
		await manager.install(manifest("1.0.0"));
		const record = await manager.createRecord("project-tasks", workspaceA, { title: "Prepare release" });
		assert.equal(record.values.title, "Prepare release");
		assert.deepEqual(await manager.listRecords("project-tasks", workspaceB), []);

		const restarted = new AppPluginManager(directory);
		assert.deepEqual(await restarted.listRecords("project-tasks", workspaceA), [record]);
		await restarted.setEnabled("project-tasks", false);
		await assert.rejects(restarted.listRecords("project-tasks", workspaceA), (error: unknown) => {
			return error instanceof HttpError && error.statusCode === 404;
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("plugin updates require a higher version and preserve the existing data schema", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".app-plugin-test-update-"));
	try {
		const manager = new AppPluginManager(directory);
		await manager.install(manifest("1.0.0"));
		const updated = await manager.install(manifest("1.1.0", false, "Task title"));
		assert.equal(updated.manifest.version, "1.1.0");

		await assert.rejects(manager.install(manifest("1.1.0", false, "Renamed")), (error: unknown) => {
			return error instanceof HttpError && error.statusCode === 409;
		});
		await assert.rejects(manager.install(manifest("1.2.0", true)), (error: unknown) => {
			return error instanceof HttpError && error.statusCode === 409;
		});
		assert.equal((await manager.list()).plugins[0]?.manifest.version, "1.1.0");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("plugin manifest validation rejects duplicate fields and unsupported properties", () => {
	const duplicateFields = JSON.stringify({
		...manifest("1.0.0"),
		fields: [
			{ id: "title", label: "A", type: "text", required: false },
			{ id: "title", label: "B", type: "text", required: false },
		],
	});
	assert.throws(() => parseAppPluginManifest(duplicateFields), HttpError);
	assert.throws(
		() => parseAppPluginManifest(JSON.stringify({ ...manifest("1.0.0"), script: "process.exit()" })),
		HttpError,
	);
});
