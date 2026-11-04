import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppPluginManager } from "../src/app-plugins.ts";
import { createNativeWorkbenchTools } from "../src/sessions/native-tools.ts";

test("exposes app plugin records to the native loop", async () => {
	const directory = mkdtempSync(join(tmpdir(), "native-tools-"));
	try {
		const plugins = new AppPluginManager(directory);
		await plugins.install({
			manifestVersion: 1,
			id: "test-app",
			name: "Test App",
			version: "1.0.0",
			description: "test",
			fields: [{ id: "title", label: "Title", type: "text", required: true }],
			views: [{ id: "all", title: "All", type: "table" }],
			navigation: [{ id: "all", title: "All", viewId: "all" }],
		});
		const tools = await createNativeWorkbenchTools({
			sessionId: "s1",
			pluginDevelopment: false,
			pluginWorkspaceId: "w1",
			appPlugins: plugins,
			tools: { readBuffer: async () => Buffer.from("") } as never,
			refreshAfterPluginChange: async () => {},
		});
		const create = tools.find((tool) => tool.name === "plugin_test_app_create");
		const list = tools.find((tool) => tool.name === "plugin_test_app_list");
		assert.equal(list?.readOnly, true);
		assert.equal(create?.readOnly, false);
		await create?.execute({ values: { title: "hello" } }, {} as never);
		const result = await list?.execute({}, {} as never);
		assert.match(result?.content ?? "", /hello/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
