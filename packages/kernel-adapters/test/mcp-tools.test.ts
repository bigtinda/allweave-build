import assert from "node:assert/strict";
import test from "node:test";
import { createMcpNativeTools, type McpToolClient } from "../src/mcp/tools.ts";

test("maps MCP tools and text results", async () => {
	const client: McpToolClient = {
		listTools: async () => [{ name: "search items", description: "Search", inputSchema: { type: "object" } }],
		callTool: async (name, input) => ({ content: [{ type: "text", text: `${name}:${String(input.query)}` }] }),
	};
	const tools = await createMcpNativeTools(client);
	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "mcp_search_items");
	assert.equal(tools[0]?.readOnly, false);
	const result = await tools[0]?.execute({ query: "x" }, {} as never);
	assert.equal(result?.content, "search items:x");
});
