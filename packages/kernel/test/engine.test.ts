import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		assert.match(tool?.text ?? "", /outside the authorized workspace/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("runs read-only tool calls in parallel", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-loop-"));
	const tool = {
		name: "slow_read",
		description: "slow",
		parameters: { type: "object" },
		readOnly: true,
		async execute() {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return { content: "ok" };
		},
	};
	try {
		const started = performance.now();
		await runNativeLoop(
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
								toolCalls: [
									{ id: "call-1", name: "slow_read", input: {} },
									{ id: "call-2", name: "slow_read", input: {} },
								],
							},
						},
					],
					[{ type: "done", result: { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" } }],
				]),
				tools: [tool],
				signal: new AbortController().signal,
				onEvent: () => {},
			},
			[],
			"run",
		);
		assert.ok(performance.now() - started < 110, "read-only tools should overlap");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("retries a retryable model error before emitting text", async () => {
	let attempts = 0;
	const model: NativeModelGateway = {
		async *stream() {
			attempts++;
			if (attempts === 1) throw new Error("rate limit exceeded");
			yield { type: "text", delta: "ok" };
			yield { type: "done", result: { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" } };
		},
	};
	const result = await runNativeLoop(
		{
			sessionId: "s",
			cwd: process.cwd(),
			system: "test",
			gateway: model,
			tools: createBuiltinTools(),
			signal: new AbortController().signal,
			onEvent: () => {},
			retryBaseMs: 5,
		},
		[],
		"hi",
	);
	assert.equal(attempts, 2);
	assert.equal(result.at(-1)?.text, "ok");
});

test("spills oversized tool output and keeps a readable path", async () => {
	const result = await runNativeLoop(
		{
			sessionId: "s",
			cwd: process.cwd(),
			system: "test",
			signal: new AbortController().signal,
			onEvent: () => undefined,
			gateway: gateway([
				[
					{
						type: "done",
						result: {
							text: "",
							thinking: "",
							toolCalls: [{ id: "big", name: "big", input: {} }],
							stopReason: "toolUse",
						},
					},
				],
				[{ type: "done", result: { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" } }],
			]),
			tools: [
				{
					name: "big",
					description: "returns a large output",
					parameters: {},
					readOnly: true,
					execute: async () => ({ content: "x".repeat(130_000) }),
				},
			],
		},
		[],
		"go",
	);
	const text = result.at(-2)?.text ?? "";
	assert.match(text, /\[output truncated; full output: (.+)\]/u);
	const path = text.match(/full output: (.+)\]/u)?.[1];
	assert.ok(path && existsSync(path));
	rmSync(path, { force: true });
});
