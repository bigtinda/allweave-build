import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	JsonObject,
	Model,
	Tool as PiTool,
	ToolCall as PiToolCall,
	SimpleStreamOptions,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	buildContext,
	createBuiltinTools,
	decideToolAccess,
	LocalWorkspace,
	type NativeMessage,
	type NativeModelEvent,
	type NativeModelGateway,
	type NativeModelRequest,
	type NativeTool,
	type NativeToolCall,
	runNativeLoop,
} from "@pi-console/kernel";
import { Type } from "typebox";
import type {
	ChatMessage,
	ChatToolCall,
	ChatToolResult,
	ModelOption,
	Resources,
	ThinkingLevel,
	ToolCall,
} from "../../../shared/src/protocol.ts";
import { HttpError } from "../security.ts";
import type { RuntimeEvent } from "./pi-events.ts";
import type {
	AgentRuntime,
	AgentRuntimeInput,
	BranchOutcome,
	RuntimeModel,
	RuntimeUsage,
} from "./pi-runtime.adapter.ts";

/** Minimal model runtime surface implemented by ProviderManager.runtime(). */
export interface NativeModelRuntime {
	getModel(provider: string, modelId: string): Model<Api> | undefined;
	getModels(provider?: string): readonly Model<Api>[];
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

function toPiMessage(message: NativeMessage): UserMessage | ToolResultMessage {
	if (message.role === "tool") {
		return {
			role: "toolResult",
			toolCallId: message.toolCallId ?? "",
			toolName: message.toolName ?? "tool",
			content: [{ type: "text", text: message.text }],
			isError: message.isError === true,
			timestamp: message.timestamp,
		};
	}
	return { role: "user", content: message.text, timestamp: message.timestamp };
}

function toPiTool(tool: NativeTool): PiTool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe(tool.parameters),
	};
}

function toolCall(call: PiToolCall): { id: string; name: string; input: Record<string, unknown> } {
	return {
		id: call.id,
		name: call.name,
		input: (call.arguments ?? {}) as Record<string, unknown>,
	};
}

class PiAiGateway implements NativeModelGateway {
	private readonly runtime: NativeModelRuntime;
	private readonly model: Model<Api>;
	private readonly thinkingLevel: ThinkingLevel;
	private usage: RuntimeUsage | undefined;

	constructor(runtime: NativeModelRuntime, model: Model<Api>, thinkingLevel: ThinkingLevel) {
		this.runtime = runtime;
		this.model = model;
		this.thinkingLevel = thinkingLevel;
	}

	lastUsage(): RuntimeUsage | undefined {
		return this.usage;
	}

	async summarize(messages: NativeMessage[], signal: AbortSignal): Promise<string> {
		const transcript = messages
			.map(
				(message) =>
					message.role + ": " + message.text + (message.toolCalls ? " " + JSON.stringify(message.toolCalls) : ""),
			)
			.join(String.fromCharCode(10, 10));
		let text = "";
		for await (const event of this.stream({
			system:
				"Summarize the earlier conversation for continuity. Keep decisions, files, commands and unresolved work. Be concise.",
			messages: [{ role: "user", text: transcript, timestamp: Date.now() }],
			tools: [],
			signal,
		})) {
			if (event.type === "text") text += event.delta;
		}
		return text.trim();
	}

	async *stream(request: NativeModelRequest): AsyncIterable<NativeModelEvent> {
		const messages = request.messages.map((message) => {
			if (message.role === "assistant") {
				return {
					role: "assistant" as const,
					content: [
						...(message.thinking ? [{ type: "thinking" as const, thinking: message.thinking }] : []),
						...(message.text ? [{ type: "text" as const, text: message.text }] : []),
						...(message.toolCalls ?? []).map((call) => ({
							type: "toolCall" as const,
							id: call.id,
							name: call.name,
							arguments: call.input as JsonObject,
						})),
					],
					api: this.model.api,
					provider: this.model.provider,
					model: this.model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: message.timestamp,
				};
			}
			return toPiMessage(message);
		});
		const stream = this.runtime.streamSimple(
			this.model,
			{ systemPrompt: request.system, messages, tools: request.tools.map(toPiTool) },
			{
				signal: request.signal,
				reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
			},
		);
		let final: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "text_delta") {
				yield { type: "text", delta: event.delta };
			} else if (event.type === "thinking_delta") {
				yield { type: "thinking", delta: event.delta };
			} else if (event.type === "done") {
				final = event.message;
			} else if (event.type === "error") {
				throw new Error(event.error.errorMessage ?? "模型请求失败");
			}
		}
		if (!final) throw new Error("模型请求没有返回结果");
		this.usage = {
			input: final.usage.input,
			output: final.usage.output,
			cacheRead: final.usage.cacheRead,
			cacheWrite: final.usage.cacheWrite,
			total: final.usage.totalTokens,
			cost: final.usage.cost.total,
		};
		yield {
			type: "done",
			result: {
				text: final.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(""),
				thinking: final.content
					.filter((block) => block.type === "thinking")
					.map((block) => block.thinking)
					.join(""),
				toolCalls: final.content.filter((block) => block.type === "toolCall").map((block) => toolCall(block)),
				stopReason:
					final.stopReason === "toolUse"
						? "toolUse"
						: final.stopReason === "length"
							? "length"
							: final.stopReason === "error" || final.stopReason === "aborted"
								? final.stopReason
								: "stop",
				usage: this.usage,
			},
		};
	}
}

function modelOption(model: Model<Api>): ModelOption {
	return {
		id: model.id,
		provider: model.provider,
		name: model.name,
		reasoning: model.reasoning,
		available: true,
	};
}

function nativeHistory(messages: readonly ChatMessage[]): NativeMessage[] {
	const history: NativeMessage[] = [];
	for (const message of messages) {
		const timestamp = Date.parse(message.timestamp) || Date.now();
		history.push({ role: message.role, text: message.text, thinking: message.thinking || undefined, timestamp });
		if (message.role !== "assistant") continue;
		const assistant = history[history.length - 1];
		if (message.toolCalls?.length) {
			assistant.toolCalls = message.toolCalls.map((call) => ({
				id: call.id,
				name: call.name,
				input: (call.input ?? {}) as Record<string, unknown>,
			}));
		}
		for (const result of message.toolResults ?? []) {
			history.push({
				role: "tool",
				text: result.output ?? "",
				toolCallId: result.toolCallId,
				toolName: result.name,
				isError: result.isError,
				timestamp: result.timestamp ? Date.parse(result.timestamp) : timestamp,
			});
		}
	}
	return history;
}

function chatMessage(message: NativeMessage): ChatMessage {
	return {
		id: message.role === "assistant" ? `assistant:${randomUUID()}` : `user:${randomUUID()}`,
		role: message.role === "assistant" ? "assistant" : "user",
		text: message.text,
		thinking: message.thinking ?? "",
		complete: false,
		timestamp: new Date(message.timestamp).toISOString(),
	};
}

/**
 * Short-session native runtime. It owns the loop, tool execution and the event
 * projection contract; provider auth/model access stays in the server adapter.
 */
export class NativeAgentRuntime implements AgentRuntime {
	readonly sessionFile = undefined;
	readonly handlesPlanMode = true;
	private readonly input: AgentRuntimeInput;
	private readonly modelRuntime: NativeModelRuntime;
	private readonly tools = createBuiltinTools();
	private readonly workspace: LocalWorkspace;
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private readonly messages: ChatMessage[];
	private controller: AbortController | undefined;
	private model: Model<Api> | undefined;
	private thinking: ThinkingLevel;
	private tokens: RuntimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	private compactionCount = 0;

	constructor(input: AgentRuntimeInput, modelRuntime: NativeModelRuntime) {
		this.input = input;
		this.modelRuntime = modelRuntime;
		this.workspace = new LocalWorkspace(input.cwd);
		this.thinking = input.state().thinkingLevel;
		this.messages = input.state().messages.map((message) => ({ ...message }));
	}

	private emit(phase: "started" | "ended" | "update", adapted: RuntimeEvent["adapted"]): void {
		for (const listener of this.listeners) listener({ phase, adapted });
	}

	private currentModel(): Model<Api> | undefined {
		if (this.model) return this.model;
		const selected = this.input.state().model;
		if (!selected) return undefined;
		this.model = this.modelRuntime.getModel(selected.provider, selected.id);
		return this.model;
	}

	prompt(text: string, signal?: AbortSignal): Promise<void> {
		return this.run(text, signal);
	}

	private async run(text: string, signal?: AbortSignal): Promise<void> {
		const model = this.currentModel();
		if (!model) throw new HttpError(400, "未配置模型。请先配置供应商凭据并选择模型。");
		this.controller = new AbortController();
		const onAbort = (): void => this.controller?.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const user: NativeMessage = { role: "user", text, timestamp: Date.now() };
		const userMessage = chatMessage(user);
		this.emit("update", { type: "message.completed", message: userMessage });
		const gateway = new PiAiGateway(this.modelRuntime, model, this.thinking);
		const history = nativeHistory(this.messages);
		const context = await buildContext({
			cwd: this.input.cwd,
			workspace: this.workspace,
			messages: history,
			tools: this.tools,
			maxTokens: model.contextWindow,
			summarize: async (dropped) => {
				const summarizer = new PiAiGateway(this.modelRuntime, model, this.thinking);
				const summary = await summarizer.summarize(
					dropped,
					this.controller?.signal ?? new AbortController().signal,
				);
				return summary || `Earlier conversation was compacted (${dropped.length} messages).`;
			},
		});
		this.compactionCount += context.compacted;
		if (context.compacted) {
			this.emit("update", {
				type: "context.compacted",
				compaction: { dropped: context.dropped, estimatedTokens: context.estimatedTokens },
			});
		}
		let assistantId: string | undefined;
		let assistantText = "";
		let assistantThinking = "";
		const assistantToolCalls: ChatToolCall[] = [];
		const assistantToolResults: ChatToolResult[] = [];
		this.emit("started", { type: "session.started" });
		try {
			await runNativeLoop(
				{
					sessionId: this.input.sessionId,
					cwd: this.input.cwd,
					system:
						this.input.accessMode() === "plan"
							? `${context.system}

## Plan mode
Analyze the task and propose a clear implementation plan. Read-only tools are allowed; do not modify files, run state-changing commands, or call tools with external side effects. Wait for explicit user approval before execution.`
							: context.system,
					gateway,
					tools: this.tools,
					workspace: this.workspace,
					signal: this.controller.signal,
					approve: async (call) => this.approve(call),
					onEvent: (event) => {
						if (event.type === "message.delta") {
							assistantId ??= event.messageId;
							assistantText += event.text ?? "";
							assistantThinking += event.thinking ?? "";
							this.emit("update", {
								type: "message.delta",
								message: {
									id: assistantId ?? `assistant:${randomUUID()}`,
									role: "assistant",
									text: assistantText,
									thinking: assistantThinking,
									complete: false,
									timestamp: new Date().toISOString(),
								},
							});
						} else if (event.type === "message.completed" && event.message) {
							assistantId = event.messageId;
							assistantText = event.message.text;
							assistantThinking = event.message.thinking ?? "";
							for (const call of event.message.toolCalls ?? []) {
								assistantToolCalls.push({ id: call.id, name: call.name, input: call.input });
							}
							this.emit("update", {
								type: "message.completed",
								message: {
									id: assistantId ?? `assistant:${randomUUID()}`,
									role: "assistant",
									text: assistantText,
									thinking: assistantThinking,
									complete: true,
									timestamp: new Date(event.message.timestamp).toISOString(),
								},
							});
						} else if (event.type === "tool.started" && event.toolCall) {
							this.emit("update", {
								type: "tool.started",
								tool: {
									id: event.toolCall.id,
									name: event.toolCall.name,
									input: event.toolCall.input,
									status: "running",
									startedAt: new Date().toISOString(),
								},
							});
						} else if (event.type === "tool.completed" && event.toolCall) {
							const tool: ToolCall = {
								id: event.toolCall.id,
								name: event.toolCall.name,
								input: event.toolCall.input,
								status: event.result?.isError ? "failed" : "completed",
								output: event.result?.content,
								durationMs: event.durationMs,
								startedAt: new Date().toISOString(),
							};
							assistantToolResults.push({
								toolCallId: event.toolCall.id,
								name: event.toolCall.name,
								output: event.result?.content,
								isError: event.result?.isError,
								timestamp: new Date().toISOString(),
							});
							this.emit("update", { type: "tool.completed", tool });
						}
					},
				},
				context.messages,
				text,
			);
			if (!this.controller.signal.aborted) {
				this.messages.push(userMessage);
				this.messages.push({
					id: assistantId ?? `assistant:${randomUUID()}`,
					role: "assistant",
					text: assistantText,
					thinking: assistantThinking,
					complete: true,
					timestamp: new Date().toISOString(),
					...(assistantToolCalls.length ? { toolCalls: assistantToolCalls } : {}),
					...(assistantToolResults.length ? { toolResults: assistantToolResults } : {}),
				});
				const usage = gateway.lastUsage();
				if (usage) this.tokens = usage;
				this.emit("ended", { type: "agent.status" });
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.controller = undefined;
		}
	}

	private async approve(call: NativeToolCall): Promise<boolean | string> {
		const tool = this.tools.find((candidate) => candidate.name === call.name);
		const decision = decideToolAccess(tool, this.input.accessMode());
		if (decision.action === "allow") return true;
		if (decision.action === "deny") return decision.reason;
		return this.input.requestApproval(call.id, call.name, call.input);
	}

	abort(): Promise<void> {
		this.controller?.abort();
		return Promise.resolve();
	}

	usage(): RuntimeUsage {
		return this.tokens;
	}
	compactions(): number {
		return this.compactionCount;
	}
	subscribe(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	selectedModel(): RuntimeModel | undefined {
		const model = this.currentModel();
		return model
			? { id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning }
			: undefined;
	}
	thinkingLevel(): ThinkingLevel {
		return this.thinking;
	}
	async setModel(provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void> {
		const model = this.modelRuntime.getModel(provider, modelId);
		if (!model) throw new HttpError(400, "模型不可用");
		this.model = model;
		if (thinkingLevel) this.thinking = thinkingLevel;
	}
	async listModels(): Promise<ModelOption[]> {
		return this.modelRuntime.getModels().map(modelOption);
	}
	resources(): Resources {
		return { skills: [], extensions: [], diagnostics: [] };
	}
	async navigate(_message: ChatMessage, _role: "user" | "assistant"): Promise<BranchOutcome> {
		throw new HttpError(409, "原生引擎暂不支持会话分支");
	}
	async dispose(): Promise<void> {
		this.controller?.abort();
	}
	modelFallbackMessage(): string | undefined {
		return undefined;
	}
}
