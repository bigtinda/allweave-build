import { randomUUID } from "node:crypto";
import type { ExtensionRegistry } from "../extensions/registry.ts";
import { LocalWorkspace } from "../workspace/local.ts";
import { isRetryable, retryDelay, sleep } from "./retry.ts";
import type {
	NativeLoopEvent,
	NativeLoopOptions,
	NativeMessage,
	NativeModelResult,
	NativeTool,
	NativeToolCall,
	NativeToolResult,
	NativeWorkspace,
} from "./types.ts";

const MAX_TURNS = 24;
const MAX_RETRIES = 2;

function fail(message: string): never {
	throw new Error(message);
}

function toolResultText(result: NativeToolResult): string {
	return result.isError ? `Error: ${result.content}` : result.content;
}

async function execute(
	tool: NativeTool,
	call: NativeToolCall,
	context: { sessionId: string; cwd: string; workspace: NativeWorkspace; signal: AbortSignal },
	extensions?: ExtensionRegistry,
): Promise<{ result: NativeToolResult; durationMs: number }> {
	const started = performance.now();
	let result: NativeToolResult;
	try {
		result = await tool.execute(call.input, context);
	} catch (error) {
		result = { content: error instanceof Error ? error.message : String(error), isError: true };
	}
	if (extensions) {
		const patch = await extensions.toolResult({ sessionId: context.sessionId, toolCall: call, result });
		if (patch.content !== undefined) result.content = patch.content;
		if (patch.isError !== undefined) result.isError = patch.isError;
	}
	return { result, durationMs: Math.round(performance.now() - started) };
}

interface Turn {
	result: NativeModelResult;
	text: string;
	thinking: string;
}

/**
 * Stream one model turn. Retries only when no delta has reached the UI,
 * so a retry can never duplicate text.
 */
async function streamTurn(
	options: NativeLoopOptions,
	request: { system: string; messages: NativeMessage[]; tools: NativeTool[] },
	messageId: string,
): Promise<Turn> {
	const maxRetries = options.maxRetries ?? MAX_RETRIES;
	for (let attempt = 0; ; attempt++) {
		let text = "";
		let thinking = "";
		let result: NativeModelResult | undefined;
		let emitted = false;
		try {
			const stream = options.gateway.stream({
				system: request.system,
				messages: request.messages,
				tools: request.tools,
				signal: options.signal,
			});
			for await (const event of stream) {
				if (event.type === "text") {
					text += event.delta;
					emitted = true;
					options.onEvent({ type: "message.delta", messageId, text: event.delta });
				} else if (event.type === "thinking") {
					thinking += event.delta;
					emitted = true;
					options.onEvent({ type: "message.delta", messageId, thinking: event.delta });
				} else if (event.type === "done") {
					result = event.result;
				} else {
					throw new Error(event.error);
				}
			}
			if (!result) throw new Error("model stream ended without a result");
			return { result, text, thinking };
		} catch (error) {
			if (options.signal.aborted || emitted || attempt >= maxRetries || !isRetryable(error)) throw error;
			await sleep(retryDelay(attempt, options.retryBaseMs), options.signal);
		}
	}
}

interface PreparedCall {
	call: NativeToolCall;
	tool?: NativeTool;
	blocked?: NativeToolResult;
}

async function prepareCall(
	call: NativeToolCall,
	tools: Map<string, NativeTool>,
	sessionId: string,
	extensions?: ExtensionRegistry,
): Promise<PreparedCall> {
	const tool = tools.get(call.name);
	if (!tool) return { call, blocked: { content: `Unknown tool: ${call.name}`, isError: true } };
	if (!extensions) return { call, tool };
	const decision = await extensions.toolCall({ sessionId, toolCall: call, tool });
	if (decision && "block" in decision) return { call, tool, blocked: { content: decision.reason, isError: true } };
	return { call: decision && "input" in decision ? { ...call, input: decision.input } : call, tool };
}

function appendResult(messages: NativeMessage[], call: NativeToolCall, result: NativeToolResult): void {
	messages.push({
		role: "tool",
		text: toolResultText(result),
		toolCallId: call.id,
		toolName: call.name,
		isError: result.isError,
		timestamp: Date.now(),
	});
}

/**
 * Runs one prompt to completion: model stream, tool calls, tool results, next turn.
 * It owns no persistence, UI or provider setup.
 */
export async function runNativeLoop(
	options: NativeLoopOptions,
	history: NativeMessage[],
	prompt: string,
): Promise<NativeMessage[]> {
	if (options.tools.length === 0) fail("native loop requires at least one tool");
	const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
	const workspace = options.workspace ?? new LocalWorkspace(options.cwd);
	const extensions = options.extensions;
	const messages: NativeMessage[] = [...history, { role: "user", text: prompt, timestamp: Date.now() }];
	const maxTurns = options.maxTurns ?? MAX_TURNS;

	for (let turn = 0; turn < maxTurns; turn++) {
		if (options.signal.aborted) break;
		await extensions?.run("turn_start", { sessionId: options.sessionId, turn, messages: [...messages] });
		const patch = await extensions?.context({
			sessionId: options.sessionId,
			system: options.system,
			messages,
		});
		const request = {
			system: patch?.system ?? options.system,
			messages: patch?.messages ?? messages,
			tools: options.tools,
		};
		const messageId = `assistant:${randomUUID()}`;
		const streamed = await streamTurn(options, request, messageId);
		if (options.signal.aborted) break;
		const assistant: NativeMessage = {
			role: "assistant",
			text: streamed.result.text || streamed.text,
			thinking: streamed.result.thinking || streamed.thinking,
			toolCalls: streamed.result.toolCalls,
			timestamp: Date.now(),
		};
		messages.push(assistant);
		options.onEvent({ type: "message.completed", messageId, message: assistant });
		await extensions?.run("message_end", { sessionId: options.sessionId, message: assistant });
		if (streamed.result.toolCalls.length === 0) {
			await extensions?.run("turn_end", { sessionId: options.sessionId, turn, messages: [...messages] });
			return messages;
		}

		const calls = streamed.result.toolCalls;
		const prepared = await Promise.all(calls.map((call) => prepareCall(call, tools, options.sessionId, extensions)));
		const parallel = prepared.every((item) => item.tool?.readOnly === true);
		if (parallel) {
			for (const item of prepared) options.onEvent({ type: "tool.started", toolCall: item.call });
			const executed = await Promise.all(
				prepared.map(async (item) => {
					if (item.blocked || !item.tool) {
						return { result: item.blocked ?? { content: "Unknown tool", isError: true }, durationMs: 0 };
					}
					return execute(
						item.tool,
						item.call,
						{ sessionId: options.sessionId, cwd: options.cwd, workspace, signal: options.signal },
						extensions,
					);
				}),
			);
			for (const [index, item] of prepared.entries()) {
				const done = executed[index] ?? fail("missing tool result");
				options.onEvent({
					type: "tool.completed",
					toolCall: item.call,
					result: done.result,
					durationMs: done.durationMs,
				});
				appendResult(messages, item.call, done.result);
			}
			await extensions?.run("turn_end", { sessionId: options.sessionId, turn, messages: [...messages] });
			continue;
		}

		for (const item of prepared) {
			options.onEvent({ type: "tool.started", toolCall: item.call });
			let done: { result: NativeToolResult; durationMs: number };
			if (item.blocked || !item.tool) {
				done = { result: item.blocked ?? { content: "Unknown tool", isError: true }, durationMs: 0 };
			} else {
				const approval = item.tool.readOnly ? true : options.approve ? await options.approve(item.call) : true;
				if (approval !== true) {
					done = {
						result: {
							content: typeof approval === "string" ? approval : "User denied or cancelled this tool call",
							isError: true,
						},
						durationMs: 0,
					};
				} else {
					done = await execute(
						item.tool,
						item.call,
						{ sessionId: options.sessionId, cwd: options.cwd, workspace, signal: options.signal },
						extensions,
					);
				}
			}
			options.onEvent({
				type: "tool.completed",
				toolCall: item.call,
				result: done.result,
				durationMs: done.durationMs,
			});
			appendResult(messages, item.call, done.result);
		}
		await extensions?.run("turn_end", { sessionId: options.sessionId, turn, messages: [...messages] });
	}
	return messages;
}

export type { NativeLoopEvent };
