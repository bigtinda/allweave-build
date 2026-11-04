import { randomUUID } from "node:crypto";
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
): Promise<{ result: NativeToolResult; durationMs: number }> {
	const started = performance.now();
	try {
		const result = await tool.execute(call.input, context);
		return { result, durationMs: Math.round(performance.now() - started) };
	} catch (error) {
		return {
			result: {
				content: error instanceof Error ? error.message : String(error),
				isError: true,
			},
			durationMs: Math.round(performance.now() - started),
		};
	}
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
async function streamTurn(options: NativeLoopOptions, messages: NativeMessage[], messageId: string): Promise<Turn> {
	const maxRetries = options.maxRetries ?? MAX_RETRIES;
	for (let attempt = 0; ; attempt++) {
		let text = "";
		let thinking = "";
		let result: NativeModelResult | undefined;
		let emitted = false;
		try {
			const stream = options.gateway.stream({
				system: options.system,
				messages,
				tools: options.tools,
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
	const messages: NativeMessage[] = [...history, { role: "user", text: prompt, timestamp: Date.now() }];
	const maxTurns = options.maxTurns ?? MAX_TURNS;

	for (let turn = 0; turn < maxTurns; turn++) {
		if (options.signal.aborted) break;
		const messageId = `assistant:${randomUUID()}`;
		const streamed = await streamTurn(options, messages, messageId);
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
		if (streamed.result.toolCalls.length === 0) return messages;

		const calls = streamed.result.toolCalls;
		const parallel = calls.every((call) => tools.get(call.name)?.readOnly === true);
		if (parallel) {
			for (const call of calls) options.onEvent({ type: "tool.started", toolCall: call });
			const executed = await Promise.all(
				calls.map((call) => {
					const tool = tools.get(call.name) ?? fail(`Unknown tool: ${call.name}`);
					return execute(tool, call, {
						sessionId: options.sessionId,
						cwd: options.cwd,
						workspace,
						signal: options.signal,
					});
				}),
			);
			for (const [index, call] of calls.entries()) {
				const done = executed[index] ?? fail("missing tool result");
				options.onEvent({
					type: "tool.completed",
					toolCall: call,
					result: done.result,
					durationMs: done.durationMs,
				});
				messages.push({
					role: "tool",
					text: toolResultText(done.result),
					toolCallId: call.id,
					toolName: call.name,
					isError: done.result.isError,
					timestamp: Date.now(),
				});
			}
			continue;
		}

		for (const call of calls) {
			const tool = tools.get(call.name);
			if (!tool) {
				messages.push({
					role: "tool",
					text: `Unknown tool: ${call.name}`,
					toolCallId: call.id,
					toolName: call.name,
					isError: true,
					timestamp: Date.now(),
				});
				continue;
			}
			options.onEvent({ type: "tool.started", toolCall: call });
			let done: { result: NativeToolResult; durationMs: number };
			const approval = tool.readOnly ? true : options.approve ? await options.approve(call) : true;
			if (approval !== true) {
				done = {
					result: {
						content: typeof approval === "string" ? approval : "User denied or cancelled this tool call",
						isError: true,
					},
					durationMs: 0,
				};
			} else {
				done = await execute(tool, call, {
					sessionId: options.sessionId,
					cwd: options.cwd,
					workspace,
					signal: options.signal,
				});
			}
			options.onEvent({
				type: "tool.completed",
				toolCall: call,
				result: done.result,
				durationMs: done.durationMs,
			});
			messages.push({
				role: "tool",
				text: toolResultText(done.result),
				toolCallId: call.id,
				toolName: call.name,
				isError: done.result.isError,
				timestamp: Date.now(),
			});
		}
	}
	return messages;
}

export type { NativeLoopEvent };
