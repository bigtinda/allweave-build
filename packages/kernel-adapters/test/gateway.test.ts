import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeModelError } from "@allweave/kernel";
import type { Api, AssistantMessage, Context, Model } from "@allweave/model";
import { AssistantMessageEventStream } from "@allweave/model/utils/event-stream";
import { ModelGateway, type NativeModelRuntime } from "../src/model/gateway.ts";

test("maps native images to the provider image content", async () => {
	let captured: Context | undefined;
	const runtime: NativeModelRuntime = {
		getModel: () => undefined,
		getModels: () => [],
		streamSimple: (_model, context) => {
			captured = context;
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "fake",
				model: "fake",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	};
	const model = {
		id: "fake",
		name: "fake",
		provider: "fake",
		api: "openai-completions",
	} as Model<Api>;
	const gateway = new ModelGateway(runtime, model, "off");
	for await (const _event of gateway.stream({
		system: "system",
		messages: [
			{
				role: "user",
				text: "describe",
				images: [{ name: "a.png", mimeType: "image/png", data: "AAAA" }],
				timestamp: Date.now(),
			},
		],
		tools: [],
		signal: new AbortController().signal,
	})) {
		// drain
	}
	const user = captured?.messages[0];
	assert.equal(user?.role, "user");
	assert.ok(Array.isArray(user.content));
	assert.deepEqual(user.content.at(-1), { type: "image", data: "AAAA", mimeType: "image/png" });
});

test("forwards the session id for provider routing headers", async () => {
	let sessionId: string | undefined;
	const runtime: NativeModelRuntime = {
		getModel: () => undefined,
		getModels: () => [],
		streamSimple: (_model, _context, options) => {
			sessionId = options?.sessionId;
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "fake",
				model: "fake",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	};
	const model = { id: "fake", name: "fake", provider: "fake", api: "openai-completions" } as Model<Api>;
	const gateway = new ModelGateway(runtime, model, "off", "session-123");
	for await (const _event of gateway.stream({
		system: "system",
		messages: [{ role: "user", text: "hi", timestamp: Date.now() }],
		tools: [],
		signal: new AbortController().signal,
	})) {
		// drain
	}
	assert.equal(sessionId, "session-123");
});

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	usage: AssistantMessage["usage"] = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		usage,
		stopReason,
		timestamp: Date.now(),
		errorMessage,
	};
}

function runtimeWith(stream: AssistantMessageEventStream): NativeModelRuntime {
	return {
		getModel: () => undefined,
		getModels: () => [],
		streamSimple: () => stream,
	};
}

const model = { id: "fake", name: "fake", provider: "fake", api: "openai-completions" } as Model<Api>;

function request(signal = new AbortController().signal) {
	return {
		system: "system",
		messages: [{ role: "user" as const, text: "hi", timestamp: Date.now() }],
		tools: [],
		signal,
	};
}

test("maps text, thinking, tool calls and usage", async () => {
	const stream = new AssistantMessageEventStream();
	const partial = assistantMessage([]);
	stream.push({ type: "text_delta", contentIndex: 0, delta: "hel", partial });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial });
	stream.push({ type: "thinking_delta", contentIndex: 1, delta: "plan", partial });
	stream.push({
		type: "done",
		reason: "toolUse",
		message: assistantMessage(
			[
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
			],
			"toolUse",
			{
				input: 7,
				output: 5,
				cacheRead: 2,
				cacheWrite: 3,
				totalTokens: 17,
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
			},
		),
	});
	stream.end();
	const gateway = new ModelGateway(runtimeWith(stream), model, "off");
	const events = [];
	for await (const event of gateway.stream(request())) events.push(event);
	assert.deepEqual(events.slice(0, 3), [
		{ type: "text", delta: "hel" },
		{ type: "text", delta: "lo" },
		{ type: "thinking", delta: "plan" },
	]);
	assert.deepEqual(events.at(-1), {
		type: "done",
		result: {
			text: "hello",
			thinking: "plan",
			toolCalls: [{ id: "c1", name: "read", input: { path: "a" } }],
			stopReason: "toolUse",
			usage: { input: 7, output: 5, cacheRead: 2, cacheWrite: 3, total: 17, cost: 3.3 },
		},
	});
});

test("keeps missing usage fields undefined", async () => {
	const usage = { input: 4, output: 2, totalTokens: 6 } as AssistantMessage["usage"];
	const stream = new AssistantMessageEventStream();
	stream.push({
		type: "done",
		reason: "stop",
		message: assistantMessage([{ type: "text", text: "ok" }], "stop", usage),
	});
	stream.end();
	const gateway = new ModelGateway(runtimeWith(stream), model, "off");
	for await (const _event of gateway.stream(request())) {
		// drain
	}
	assert.deepEqual(gateway.lastUsage(), {
		input: 4,
		output: 2,
		cacheRead: undefined,
		cacheWrite: undefined,
		total: 6,
		cost: undefined,
	});
});

test("classifies rate limit errors as retryable", async () => {
	const stream = new AssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: assistantMessage([], "error", undefined, "429 rate limit"),
	});
	stream.end();
	const gateway = new ModelGateway(runtimeWith(stream), model, "off");
	await assert.rejects(
		async () => {
			for await (const _event of gateway.stream(request())) {
				// drain
			}
		},
		(error: unknown) => error instanceof NativeModelError && error.kind === "rate_limit" && error.retryable === true,
	);
});

test("classifies auth, context and abort errors", async () => {
	const cases: Array<[string, string, boolean]> = [
		["401 unauthorized", "auth", false],
		["maximum context length exceeded", "context_length", false],
	];
	for (const [message, kind, retryable] of cases) {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "error", reason: "error", error: assistantMessage([], "error", undefined, message) });
		stream.end();
		const gateway = new ModelGateway(runtimeWith(stream), model, "off");
		await assert.rejects(
			async () => {
				for await (const _event of gateway.stream(request())) {
					// drain
				}
			},
			(error: unknown) => error instanceof NativeModelError && error.kind === kind && error.retryable === retryable,
		);
	}

	const controller = new AbortController();
	controller.abort();
	const aborted = new AssistantMessageEventStream();
	aborted.push({ type: "error", reason: "aborted", error: assistantMessage([], "aborted") });
	aborted.end();
	const gateway = new ModelGateway(runtimeWith(aborted), model, "off");
	await assert.rejects(
		async () => {
			for await (const _event of gateway.stream(request(controller.signal))) {
				// drain
			}
		},
		(error: unknown) => error instanceof NativeModelError && error.kind === "aborted" && error.retryable === false,
	);
});
