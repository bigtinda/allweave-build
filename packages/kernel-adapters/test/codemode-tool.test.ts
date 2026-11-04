import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeNativeTool } from "../src/sandbox/tool.ts";

test("runs scripts against read-only tools", async () => {
	const echo = {
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: { value: { type: "string" } } },
		readOnly: true,
		execute: async (input: Record<string, unknown>) => ({ content: String(input.value) }),
	};
	const tool = createCodemodeNativeTool([echo]);
	const result = await tool.execute(
		{ code: "const value = await tools.echo({ value: 'hi' }); return value + '!'" },
		{} as never,
	);
	assert.equal(result.isError, undefined);
	assert.match(result.content, /hi!/u);
});

test("exposes only read-only tools to scripts", async () => {
	const tools = [
		{
			name: "read",
			description: "read",
			parameters: { type: "object", properties: {} },
			readOnly: true,
			execute: async () => ({ content: "read" }),
		},
		{
			name: "write",
			description: "write",
			parameters: { type: "object", properties: {} },
			readOnly: false,
			execute: async () => ({ content: "write" }),
		},
	];
	const tool = createCodemodeNativeTool(tools);
	const result = await tool.execute({ code: "return ['read' in tools, 'write' in tools]" }, {} as never);
	assert.equal(result.isError, undefined);
	assert.match(result.content, /\[true,false\]/u);
});
