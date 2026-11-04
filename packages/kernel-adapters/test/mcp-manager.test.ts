import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig } from "../src/mcp/config.ts";
import { createMcpManager } from "../src/mcp/manager.ts";

test("connects servers concurrently and reports failures", async () => {
	const servers = new Map<string, McpServerConfig>([
		["a", { command: "a" }],
		["b", { command: "b" }],
		["c", { command: "c" }],
	]);
	const closed: string[] = [];
	const manager = await createMcpManager({
		servers,
		connect: async (name) => {
			if (name === "c") throw new Error("boom");
			return {
				name,
				client: {
					listTools: async () => [{ name: "echo", annotations: { readOnlyHint: true } }],
					callTool: async () => ({ content: [{ type: "text", text: name }] }),
				},
				close: async () => {
					closed.push(name);
				},
			};
		},
	});
	assert.deepEqual(manager.tools.map((tool) => tool.name).sort(), ["mcp__a__echo", "mcp__b__echo"]);
	assert.equal(manager.tools[0]?.readOnly, true);
	assert.equal(manager.diagnostics.length, 1);
	assert.match(manager.diagnostics[0] ?? "", /boom/u);
	await manager.close();
	assert.deepEqual(closed.sort(), ["a", "b"]);
});
