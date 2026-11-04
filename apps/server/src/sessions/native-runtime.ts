import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildContext,
	createBuiltinTools,
	decideToolAccess,
	discoverAgentResources,
	discoverResources,
	LocalWorkspace,
	type NativeMessage,
	type NativeResourceInfo,
	type NativeTool,
	type NativeToolCall,
	runNativeLoop,
} from "@pi-console/kernel";
import {
	createCodemodeNativeTool,
	createMcpManager,
	loadMcpConfig,
	type McpManager,
	modelOption,
	type NativeModelRuntime,
	PiAiGateway,
} from "@pi-console/kernel-adapters";
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
import { createNativeWorkbenchTools } from "./native-tools.ts";
import type { RuntimeEvent } from "./pi-events.ts";
import type {
	AgentRuntime,
	AgentRuntimeInput,
	BranchOutcome,
	RuntimeModel,
	RuntimeUsage,
} from "./pi-runtime.adapter.ts";

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
	private readonly agentDir: string;
	private readonly builtinTools = createBuiltinTools();
	private tools: NativeTool[] = this.builtinTools;
	private readonly workspace: LocalWorkspace;
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private messages: ChatMessage[];
	private controller: AbortController | undefined;
	private takeSteering: (() => string[]) | undefined;
	private model: Model<Api> | undefined;
	private thinking: ThinkingLevel;
	private tokens: RuntimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	private compactionCount = 0;
	private estimateScale = 1;
	private resourcesLoaded: NativeResourceInfo[] = [];

	private mcp: Promise<McpManager> | undefined;
	private mcpKey = "";

	constructor(input: AgentRuntimeInput, modelRuntime: NativeModelRuntime, agentDir: string) {
		this.input = input;
		this.modelRuntime = modelRuntime;
		this.agentDir = agentDir;
		this.workspace = new LocalWorkspace(input.cwd);
		this.thinking = input.state().thinkingLevel;
		this.estimateScale = input.state().tokenScale ?? 1;
		this.messages = input.state().messages.map((message) => ({ ...message }));
	}

	private emit(phase: "started" | "ended" | "update", adapted: RuntimeEvent["adapted"]): void {
		for (const listener of this.listeners) listener({ phase, adapted });
	}

	private currentModel(): Model<Api> | undefined {
		if (this.model) return this.model;
		const selected = this.input.state().model;
		this.model = selected
			? this.modelRuntime.getModel(selected.provider, selected.id)
			: this.modelRuntime.getModels()[0];
		return this.model;
	}

	private mcpTools(): Promise<McpManager | undefined> {
		if (this.input.pluginDevelopment || process.env.KERNEL_MCP === "off") return Promise.resolve(undefined);
		const config = loadMcpConfig({ agentDir: this.agentDir, cwd: this.input.cwd, projectTrusted: true });
		const key = JSON.stringify([...config.servers]);
		if (this.mcp && key === this.mcpKey) return this.mcp;
		const previous = this.mcp;
		this.mcpKey = key;
		if (config.servers.size === 0) {
			this.mcp = undefined;
			void previous?.then((manager) => manager.close());
			return Promise.resolve(undefined);
		}
		this.mcp = createMcpManager({ servers: config.servers });
		void previous?.then((manager) => manager.close());
		return this.mcp;
	}

	prompt(text: string, signal?: AbortSignal, takeSteering?: () => string[]): Promise<void> {
		return this.run(text, signal, takeSteering);
	}

	private async run(text: string, signal?: AbortSignal, takeSteering?: () => string[]): Promise<void> {
		const model = this.currentModel();
		if (!model) throw new HttpError(400, "未配置模型。请先配置供应商凭据并选择模型。");
		this.controller = new AbortController();
		this.takeSteering = takeSteering;
		const onAbort = (): void => this.controller?.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const user: NativeMessage = { role: "user", text, timestamp: Date.now() };
		const userMessage = chatMessage(user);
		this.emit("update", { type: "message.completed", message: userMessage });
		const gateway = new PiAiGateway(this.modelRuntime, model, this.thinking);
		const history = nativeHistory(this.messages);
		this.messages.push(userMessage);
		const mcp = await this.mcpTools();
		const discovered = [
			...(await discoverResources(this.input.cwd)),
			...(await discoverAgentResources(this.agentDir)),
		].filter((resource, index, all) => all.findIndex((item) => item.filePath === resource.filePath) === index);
		this.resourcesLoaded = discovered;
		const workbenchTools = await createNativeWorkbenchTools({
			sessionId: this.input.sessionId,
			pluginDevelopment: this.input.pluginDevelopment,
			pluginWorkspaceId: this.input.pluginWorkspaceId,
			appPlugins: this.input.appPlugins,
			browser: this.input.browser,
			tools: this.input.tools,
			refreshAfterPluginChange: this.input.refreshAfterPluginChange,
		});
		const baseTools = this.input.pluginDevelopment
			? this.builtinTools.filter((tool) => ["read", "write", "edit", "ls"].includes(tool.name))
			: this.builtinTools;
		const callable = [
			...baseTools,
			...workbenchTools,
			...(mcp?.tools ?? []),
			...(this.input.extensions?.tools() ?? []),
		];
		this.tools = process.env.KERNEL_CODEMODE === "off" ? callable : [...callable, createCodemodeNativeTool(callable)];
		const context = await buildContext({
			cwd: this.input.cwd,
			workspace: this.workspace,
			messages: history,
			tools: this.tools,
			resources: discovered.map((resource) => ({ name: resource.name, description: resource.description })),
			maxTokens: model.contextWindow,
			estimateScale: this.estimateScale,
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
					system: this.input.pluginDevelopment
						? `${context.system}

## Plugin development
Create or upgrade declarative plugin manifests in this workspace. Use plugin_list first, then plugin_validate, and only call plugin_install when the user explicitly asks to install or enable. Manifests use fields, table/board views and navigation; do not invent executable capabilities.`
						: this.input.accessMode() === "plan"
							? `${context.system}

## Plan mode
Analyze the task and propose a clear implementation plan. Read-only tools are allowed; do not modify files, run state-changing commands, or call tools with external side effects. Wait for explicit user approval before execution.`
							: context.system,
					gateway,
					tools: this.tools,
					workspace: this.workspace,
					extensions: this.input.extensions,
					takeSteering: this.takeSteering,
					signal: this.controller.signal,
					approve: async (call) => this.approve(call),
					onEvent: (event) => {
						if (event.type === "user.message") {
							const message: ChatMessage = {
								id: `user:${randomUUID()}`,
								role: "user",
								text: event.text ?? "",
								thinking: "",
								complete: true,
								timestamp: new Date().toISOString(),
							};
							this.messages.push({ ...message });
							this.emit("update", { type: "message.completed", message });
						} else if (event.type === "message.delta") {
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
				if (usage) {
					this.tokens = usage;
					const observedInput = usage.input + usage.cacheRead + usage.cacheWrite;
					if (observedInput > 0 && context.estimatedTokens > 0) {
						const observed = observedInput / context.estimatedTokens;
						if (Number.isFinite(observed) && observed >= 0.25 && observed <= 4) {
							this.estimateScale = Math.min(2, Math.max(0.5, this.estimateScale * 0.7 + observed * 0.3));
							this.emit("update", { type: "session.updated", tokenScale: this.estimateScale });
						}
					}
				}
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
		void this.mcp?.then((manager) => manager.close());
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
		return {
			skills: this.resourcesLoaded
				.filter((resource) => resource.kind === "skill")
				.map((resource) => ({
					name: resource.name,
					description: resource.description,
					filePath: resource.filePath,
					status: "loaded" as const,
				})),
			extensions: [],
			diagnostics: [],
		};
	}
	async navigate(message: ChatMessage, role: "user" | "assistant"): Promise<BranchOutcome> {
		const index = this.messages.findIndex((entry) => entry.id === message.id);
		if (index < 0) throw new HttpError(409, "消息不在当前原生会话中");
		const cut = index + (role === "assistant" ? 1 : 0);
		const toolIds = this.messages
			.slice(cut)
			.flatMap((entry) => entry.toolResults?.map((result) => result.toolCallId) ?? []);
		this.messages = this.messages.slice(0, cut);
		return { editorText: message.text, toolIds, usage: this.usage() };
	}
	async dispose(): Promise<void> {
		this.controller?.abort();
		void this.mcp?.then((manager) => manager.close());
	}
	modelFallbackMessage(): string | undefined {
		return undefined;
	}
}
