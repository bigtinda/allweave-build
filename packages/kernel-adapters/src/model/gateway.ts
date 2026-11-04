import type {
	NativeMessage,
	NativeModelEvent,
	NativeModelGateway,
	NativeModelRequest,
	NativeTool,
} from "@allweave/kernel";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	JsonObject,
	Model,
	Tool as ModelTool,
	ToolCall as ModelToolCall,
	SimpleStreamOptions,
	ToolResultMessage,
	UserMessage,
} from "@allweave/model";
import type { ModelOption } from "@allweave/protocol";
import { Type } from "typebox";

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Minimal model runtime surface implemented by ProviderManager.runtime(). */
export interface NativeModelRuntime {
	getModel(provider: string, modelId: string): Model<Api> | undefined;
	getModels(provider?: string): readonly Model<Api>[];
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export interface GatewayUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

function toModelMessage(message: NativeMessage): UserMessage | ToolResultMessage {
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
	if (!message.images?.length) return { role: "user", content: message.text, timestamp: message.timestamp };
	const content: Array<{ type: "text"; text: string } | ImageContent> = [];
	if (message.text) content.push({ type: "text", text: message.text });
	for (const image of message.images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return { role: "user", content, timestamp: message.timestamp };
}

function toModelTool(tool: NativeTool): ModelTool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe(tool.parameters),
	};
}

function toolCall(call: ModelToolCall): { id: string; name: string; input: Record<string, unknown> } {
	return {
		id: call.id,
		name: call.name,
		input: (call.arguments ?? {}) as Record<string, unknown>,
	};
}

export class ModelGateway implements NativeModelGateway {
	private readonly runtime: NativeModelRuntime;
	private readonly model: Model<Api>;
	private readonly thinkingLevel: ModelThinkingLevel;
	private readonly sessionId: string | undefined;
	private usage: GatewayUsage | undefined;

	constructor(runtime: NativeModelRuntime, model: Model<Api>, thinkingLevel: ModelThinkingLevel, sessionId?: string) {
		this.runtime = runtime;
		this.model = model;
		this.thinkingLevel = thinkingLevel;
		this.sessionId = sessionId;
	}

	lastUsage(): GatewayUsage | undefined {
		return this.usage;
	}

	private addUsage(usage: GatewayUsage): void {
		this.usage = {
			input: (this.usage?.input ?? 0) + usage.input,
			output: (this.usage?.output ?? 0) + usage.output,
			cacheRead: (this.usage?.cacheRead ?? 0) + usage.cacheRead,
			cacheWrite: (this.usage?.cacheWrite ?? 0) + usage.cacheWrite,
			total: (this.usage?.total ?? 0) + usage.total,
			cost: (this.usage?.cost ?? 0) + usage.cost,
		};
	}

	async summarize(messages: NativeMessage[], signal: AbortSignal): Promise<string> {
		const transcript = messages
			.map(
				(message) =>
					`${message.role}: ${message.text}${message.toolCalls ? ` ${JSON.stringify(message.toolCalls)}` : ""}`,
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
			return toModelMessage(message);
		});
		const stream = this.runtime.streamSimple(
			this.model,
			{ systemPrompt: request.system, messages, tools: request.tools.map(toModelTool) },
			{
				signal: request.signal,
				sessionId: this.sessionId,
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
		if (final.stopReason === "error" && final.errorMessage) throw new Error(final.errorMessage);
		this.addUsage({
			input: final.usage.input,
			output: final.usage.output,
			cacheRead: final.usage.cacheRead,
			cacheWrite: final.usage.cacheWrite,
			total: final.usage.totalTokens,
			cost: final.usage.cost.total,
		});
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
				usage: this.usage && {
					input: this.usage.input,
					output: this.usage.output,
					cacheRead: this.usage.cacheRead,
					cacheWrite: this.usage.cacheWrite,
					total: this.usage.total,
					cost: this.usage.cost,
				},
			},
		};
	}
}

export function modelOption(model: Model<Api>): ModelOption {
	return {
		id: model.id,
		provider: model.provider,
		name: model.name,
		reasoning: model.reasoning,
		available: true,
	};
}
