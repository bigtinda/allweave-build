import assert from "node:assert/strict";
import test from "node:test";
import { createToolSearchTool, type NativeTool } from "../src/index.ts";

const tools: NativeTool[] = [
	{
		name: "read",
		description: "Read a file",
		parameters: {},
		readOnly: true,
		execute: async () => ({ content: "ok" }),
	},
	{
		name: "write",
		description: "Write a file",
		parameters: {},
		readOnly: false,
		execute: async () => ({ content: "no" }),
	},
];

test("searches read-only tools and refuses mutating ones", async () => {
	const search = createToolSearchTool(tools);
	assert.match((await search.execute({ query: "read" }, {} as never)).content, /read/u);
	assert.match((await search.execute({ name: "read" }, {} as never)).content, /ok/u);
	assert.equal((await search.execute({ name: "write" }, {} as never)).isError, true);
});
