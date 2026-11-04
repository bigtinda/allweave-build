import assert from "node:assert/strict";
import { test } from "node:test";
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
