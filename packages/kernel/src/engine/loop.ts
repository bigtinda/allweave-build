import { randomUUID } from "node:crypto";
import type {
	NativeLoopEvent,
	NativeLoopOptions,
	NativeMessage,
	NativeModelResult,
	NativeTool,
	NativeToolCall,
	NativeToolResult,
} from "./types.ts";

const MAX_TURNS = 24;

function fail(message: string): never {
	throw new Error(message);
}

function toolResultText(result: NativeToolResult): string {
	return result.isError ? `Error: ${result.content}` : result.content;
}

async function execute(
	tool: NativeTool,
	call: NativeToolCall,
	context: { sessionId: string; cwd: string; signal: AbortSignal },
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
	const messages: NativeMessage[] = [...history, { role: "user", text: prompt, timestamp: Date.now() }];
	const maxTurns = options.maxTurns ?? MAX_TURNS;

	for (let turn = 0; turn < maxTurns; turn++) {
		if (options.signal.aborted) break;
		const messageId = `assistant:${randomUUID()}`;
		let text = "";
		let thinking = "";
		let result: NativeModelResult | undefined;
		const stream = options.gateway.stream({
			system: options.system,
			messages,
			tools: options.tools,
			signal: options.signal,
		});
		for await (const event of stream) {
			if (event.type === "text") {
				text += event.delta;
				options.onEvent({ type: "message.delta", messageId, text: event.delta });
			} else if (event.type === "thinking") {
				thinking += event.delta;
				options.onEvent({ type: "message.delta", messageId, thinking: event.delta });
			} else if (event.type === "done") {
				result = event.result;
			} else {
				throw new Error(event.error);
			}
		}
		if (!result) throw new Error("model stream ended without a result");
		if (options.signal.aborted) break;
		const assistant: NativeMessage = {
			role: "assistant",
			text: result.text || text,
			thinking: result.thinking || thinking,
			toolCalls: result.toolCalls,
			timestamp: Date.now(),
		};
		messages.push(assistant);
		options.onEvent({ type: "message.completed", messageId, message: assistant });
		if (result.toolCalls.length === 0) return messages;

		for (const call of result.toolCalls) {
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
			let executed: { result: NativeToolResult; durationMs: number };
			const approval = tool.readOnly ? true : options.approve ? await options.approve(call) : true;
			if (approval !== true) {
				executed = {
					result: {
						content: typeof approval === "string" ? approval : "User denied or cancelled this tool call",
						isError: true,
					},
					durationMs: 0,
				};
			} else {
				executed = await execute(tool, call, {
					sessionId: options.sessionId,
					cwd: options.cwd,
					signal: options.signal,
				});
			}
			options.onEvent({
				type: "tool.completed",
				toolCall: call,
				result: executed.result,
				durationMs: executed.durationMs,
			});
			messages.push({
				role: "tool",
				text: toolResultText(executed.result),
				toolCallId: call.id,
				toolName: call.name,
				isError: executed.result.isError,
				timestamp: Date.now(),
			});
		}
	}
	return messages;
}

export type { NativeLoopEvent };
