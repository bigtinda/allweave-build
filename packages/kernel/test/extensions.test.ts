import assert from "node:assert/strict";
import test from "node:test";
import { runNativeLoop } from "../src/engine/loop.ts";
import type { NativeModelEvent, NativeModelGateway, NativeTool } from "../src/engine/types.ts";
import { createExtensionRegistry } from "../src/extensions/registry.ts";

const tool: NativeTool = {
	name: "echo",
	description: "echo input",
	parameters: { type: "object" },
	readOnly: false,
	execute: async (input) => ({ content: String(input.value) }),
};

function gateway(): NativeModelGateway {
	let turn = 0;
	return {
		async *stream(): AsyncIterable<NativeModelEvent> {
			turn++;
			if (turn === 1) {
				yield { type: "text", delta: "calling" };
				yield {
					type: "done",
					result: {
						text: "calling",
						thinking: "",
						toolCalls: [{ id: "call-1", name: "echo", input: { value: "original" } }],
						stopReason: "toolUse",
					},
				};
			} else {
				yield { type: "text", delta: "done" };
				yield {
					type: "done",
					result: {
						text: "done",
						thinking: "",
						toolCalls: [],
						stopReason: "stop",
					},
				};
			}
		},
	};
}

test("runs hooks, rewrites tool input, and patches results", async () => {
	const registry = createExtensionRegistry([
		{
			name: "test",
			hooks: {
				tool_call: () => ({ input: { value: "rewritten" } }),
				tool_result: (event) => ({ content: `${event.result.content}:patched` }),
				context: (event) => ({ system: `${event.system}\nextension` }),
			},
		},
	]);
	const messages = await runNativeLoop(
		{
			signal: new AbortController().signal,
			sessionId: "s1",
			cwd: process.cwd(),
			system: "base",
			gateway: gateway(),
			tools: [tool],
			extensions: registry,
			onEvent: () => {},
		},
		[],
		"go",
	);
	const result = messages.find((message) => message.role === "tool");
	assert.equal(result?.text, "rewritten:patched");
});

test("blocks a tool call with a failed result", async () => {
	const registry = createExtensionRegistry([
		{ name: "test", hooks: { tool_call: () => ({ block: true, reason: "no echo" }) } },
	]);
	const messages = await runNativeLoop(
		{
			signal: new AbortController().signal,
			sessionId: "s1",
			cwd: process.cwd(),
			system: "base",
			gateway: gateway(),
			tools: [tool],
			extensions: registry,
			onEvent: () => {},
		},
		[],
		"go",
	);
	const result = messages.find((message) => message.role === "tool");
	assert.equal(result?.isError, true);
	assert.equal(result?.text, "Error: no echo");
});

test("duplicate tools and extensions produce diagnostics", () => {
	const registry = createExtensionRegistry([{ name: "a", tools: [tool] }]);
	assert.equal(registry.register({ name: "a" }), false);
	assert.equal(registry.registerTool("b", tool), false);
	assert.ok(
		registry
			.diagnostics_()
			.some((entry) => entry.message.includes("duplicated") || entry.message.includes("already registered")),
	);
});
