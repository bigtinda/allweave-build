import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectOfficialServer } from "../src/mcp/official.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));

test("official MCP client lists and calls tools over stdio", async () => {
	const connection = await connectOfficialServer("fixture", {
		command: process.execPath,
		args: [fixture],
	});
	try {
		const tools = await connection.client.listTools();
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["echo"],
		);
		assert.equal(tools[0]?.annotations?.readOnlyHint, true);
		const result = await connection.client.callTool("echo", { text: "hello" });
		assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
	} finally {
		await connection.close();
	}
});
