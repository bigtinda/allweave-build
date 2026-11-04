import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeNativeTool } from "../src/codemode/tool.ts";

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
