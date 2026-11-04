import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runNativeLoop } from "../src/engine/loop.ts";
import { createBuiltinTools } from "../src/engine/tools.ts";
import type { NativeModelEvent, NativeModelGateway, NativeModelRequest } from "../src/engine/types.ts";

function gateway(responses: NativeModelEvent[][]): NativeModelGateway & { requests: NativeModelRequest[] } {
	const requests: NativeModelRequest[] = [];
	return {
		requests,
		async *stream(request) {
			requests.push(request);
			const next = responses.shift();
			assert.ok(next, "unexpected model request");
			for (const event of next) yield event;
		},
	};
}

test("streams text and completes a simple turn", async () => {
	const events: string[] = [];
	const result = await runNativeLoop(
		{
			sessionId: "s",
			cwd: process.cwd(),
			system: "test",
			gateway: gateway([
				[
					{ type: "text", delta: "Hel" },
					{ type: "text", delta: "lo" },
					{
						type: "done",
						result: { text: "Hello", thinking: "", toolCalls: [], stopReason: "stop" },
					},
				],
			]),
			tools: createBuiltinTools(),
			signal: new AbortController().signal,
			onEvent: (event) => events.push(event.type),
		},
		[],
		"hi",
	);
	assert.equal(result.at(-1)?.text, "Hello");
	assert.deepEqual(events, ["message.delta", "message.delta", "message.completed"]);
});

test("executes a tool then asks the model again", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-loop-"));
	writeFileSync(join(directory, "a.txt"), "content");
	try {
		const requests: NativeModelRequest[] = [];
		const result = await runNativeLoop(
			{
				sessionId: "s",
				cwd: directory,
				system: "test",
				gateway: gateway([
					[
						{
							type: "done",
							result: {
								text: "",
								thinking: "",
								stopReason: "toolUse",
								toolCalls: [{ id: "call-1", name: "read", input: { path: "a.txt" } }],
							},
						},
					],
					[
						{
							type: "done",
							result: { text: "done", thinking: "", toolCalls: [], stopReason: "stop" },
						},
					],
				]),
				tools: createBuiltinTools(),
				signal: new AbortController().signal,
				onEvent: (event) => {
					if (event.type === "tool.started") requests.push({} as NativeModelRequest);
				},
			},
			[],
			"read it",
		);
		assert.equal(requests.length, 1);
		assert.equal(result.at(-1)?.text, "done");
		assert.equal(result.find((message) => message.role === "tool")?.text, "content");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("denied tool returns an error result without executing", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-loop-"));
	try {
		const result = await runNativeLoop(
			{
				sessionId: "s",
				cwd: directory,
				system: "test",
				gateway: gateway([
					[
						{
							type: "done",
							result: {
								text: "",
								thinking: "",
								stopReason: "toolUse",
								toolCalls: [{ id: "call-1", name: "write", input: { path: "x.txt", content: "x" } }],
							},
						},
					],
					[{ type: "done", result: { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" } }],
				]),
				tools: createBuiltinTools(),
				approve: async () => false,
				signal: new AbortController().signal,
				onEvent: () => {},
			},
			[],
			"write",
		);
		const tool = result.find((message) => message.role === "tool");
		assert.equal(tool?.isError, true);
		assert.match(tool?.text ?? "", /denied/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects paths outside the workspace", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-loop-"));
	try {
		const result = await runNativeLoop(
			{
				sessionId: "s",
				cwd: directory,
				system: "test",
				gateway: gateway([
					[
						{
							type: "done",
							result: {
								text: "",
								thinking: "",
								stopReason: "toolUse",
								toolCalls: [{ id: "call-1", name: "read", input: { path: "../outside.txt" } }],
							},
						},
					],
					[{ type: "done", result: { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" } }],
				]),
				tools: createBuiltinTools(),
				signal: new AbortController().signal,
				onEvent: () => {},
			},
			[],
			"read",
		);
		const tool = result.find((message) => message.role === "tool");
		assert.equal(tool?.isError, true);
		assert.match(tool?.text ?? "", /escapes workspace/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
