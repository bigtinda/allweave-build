import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { SessionDetail } from "../../shared/src/protocol.ts";
import { NativeAgentRuntime, type NativeModelRuntime } from "../src/sessions/native-runtime.ts";
import type { AgentRuntimeInput } from "../src/sessions/pi-runtime.adapter.ts";

const model = {
	id: "test-model",
	name: "Test Model",
	provider: "test",
	api: "openai-completions",
	baseUrl: "http://localhost",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 4096,
	maxTokens: 512,
} as unknown as Model<Api>;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
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
	} as AssistantMessage;
}

function fakeRuntime(text: string): NativeModelRuntime {
	return {
		getModel: () => model,
		getModels: () => [model],
		streamSimple: ((_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
			const message = assistant(text);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "text_delta", delta: text } as const;
					yield { type: "done", reason: "stop", message } as const;
				},
				result: async () => message,
			} as unknown as AssistantMessageEventStream;
		}) as NativeModelRuntime["streamSimple"],
	};
}

function fakeToolRuntime(): NativeModelRuntime {
	let calls = 0;
	return {
		getModel: () => model,
		getModels: () => [model],
		streamSimple: ((_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
			const toolUse = calls++ === 0;
			const message = toolUse
				? ({
						...assistant(""),
						content: [
							{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "x.txt", content: "x" } },
						],
						stopReason: "toolUse",
					} as AssistantMessage)
				: assistant("done");
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: toolUse ? "toolUse" : "stop", message } as const;
				},
				result: async () => message,
			} as unknown as AssistantMessageEventStream;
		}) as NativeModelRuntime["streamSimple"],
	};
}

function detail(messageCount = 0): SessionDetail {
	return {
		id: "session",
		workspaceId: "workspace",
		title: "Test",
		status: "idle",
		updatedAt: new Date().toISOString(),
		model: { id: model.id, provider: model.provider, name: model.name, reasoning: false, available: true },
		thinkingLevel: "medium",
		accessMode: "ask",
		messages: Array.from({ length: messageCount }, (_, index) => ({
			id: `old-${index}`,
			role: "user" as const,
			text: "old",
			thinking: "",
			complete: true,
			timestamp: new Date().toISOString(),
		})),
		tools: [],
		approvals: [],
		activity: [],
		sequence: 0,
	};
}

test("native runtime streams assistant output and usage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "native-runtime-"));
	try {
		let state = detail();
		const events: string[] = [];
		const runtime = new NativeAgentRuntime(
			{
				sessionId: "session",
				workspace: { id: "workspace", name: "w", path: directory },
				pluginDevelopment: false,
				cwd: directory,
				tools: {} as AgentRuntimeInput["tools"],
				state: () => state,
				browser: {} as AgentRuntimeInput["browser"],
				pluginWorkspaceId: "workspace",
				accessMode: () => "ask",
				requestApproval: async () => true,
				refreshAfterPluginChange: async () => {},
			},
			fakeRuntime("hello"),
		);
		runtime.subscribe((event) => events.push(`${event.phase}:${event.adapted.type}`));
		await runtime.prompt("hi");
		assert.deepEqual(events, [
			"update:message.completed",
			"started:session.started",
			"update:message.delta",
			"update:message.completed",
			"ended:agent.status",
		]);
		assert.equal(runtime.usage().input, 1);
		state = detail(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("native runtime denies write tools in plan mode", async () => {
	const directory = await mkdtemp(join(tmpdir(), "native-runtime-"));
	try {
		const runtime = new NativeAgentRuntime(
			{
				sessionId: "session",
				workspace: { id: "workspace", name: "w", path: directory },
				pluginDevelopment: false,
				cwd: directory,
				tools: {} as AgentRuntimeInput["tools"],
				state: () => detail(),
				browser: {} as AgentRuntimeInput["browser"],
				pluginWorkspaceId: "workspace",
				accessMode: () => "plan",
				requestApproval: async () => true,
				refreshAfterPluginChange: async () => {},
			},
			fakeToolRuntime(),
		);
		const tools: string[] = [];
		runtime.subscribe((event) => {
			if (event.adapted.tool) tools.push(`${event.adapted.tool.status}:${event.adapted.tool.output}`);
		});
		await runtime.prompt("hi");
		assert.equal(tools.at(-1), "failed:计划模式仅允许只读工具。切换权限模式后再执行此操作。");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("native runtime abort stops a streaming run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "native-runtime-"));
	try {
		const runtime = new NativeAgentRuntime(
			{
				sessionId: "session",
				workspace: { id: "workspace", name: "w", path: directory },
				pluginDevelopment: false,
				cwd: directory,
				tools: {} as AgentRuntimeInput["tools"],
				state: () => detail(),
				browser: {} as AgentRuntimeInput["browser"],
				pluginWorkspaceId: "workspace",
				accessMode: () => "ask",
				requestApproval: async () => true,
				refreshAfterPluginChange: async () => {},
			},
			{
				...fakeRuntime("never"),
				streamSimple: ((_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
					return {
						async *[Symbol.asyncIterator]() {
							yield { type: "text_delta", delta: "partial" } as const;
							await new Promise((_resolve, reject) => {
								options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							});
						},
						result: async () => assistant("partial"),
					} as unknown as AssistantMessageEventStream;
				}) as NativeModelRuntime["streamSimple"],
			},
		);
		const run = runtime.prompt("hi");
		setTimeout(() => runtime.abort(), 10);
		await assert.rejects(run, /aborted/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
