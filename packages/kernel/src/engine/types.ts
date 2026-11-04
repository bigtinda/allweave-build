/** Minimal native model/tool contracts. They intentionally avoid Pi runtime types. */

export interface NativeToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface NativeMessage {
	role: "user" | "assistant" | "tool";
	text: string;
	thinking?: string;
	toolCalls?: NativeToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp: number;
}

export interface NativeUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	total: number;
	cost?: number;
}

export interface NativeModelRequest {
	system: string;
	messages: NativeMessage[];
	tools: NativeTool[];
	signal: AbortSignal;
}

export interface NativeModelResult {
	text: string;
	thinking: string;
	toolCalls: NativeToolCall[];
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	usage?: NativeUsage;
}

export type NativeModelEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "done"; result: NativeModelResult }
	| { type: "error"; error: string };

/** The only model dependency of the native loop. Adapters implement it. */
export interface NativeModelGateway {
	stream(request: NativeModelRequest): AsyncIterable<NativeModelEvent>;
}

export interface NativeToolResult {
	content: string;
	isError?: boolean;
}

export interface NativeToolContext {
	sessionId: string;
	cwd: string;
	signal: AbortSignal;
}

export interface NativeTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	readOnly: boolean;
	execute(input: Record<string, unknown>, context: NativeToolContext): Promise<NativeToolResult>;
}

export interface NativeLoopEvent {
	type: "message.delta" | "message.completed" | "tool.started" | "tool.completed";
	messageId?: string;
	message?: NativeMessage;
	toolCall?: NativeToolCall;
	result?: NativeToolResult;
	durationMs?: number;
	text?: string;
	thinking?: string;
}

export interface NativeLoopOptions {
	signal: AbortSignal;
	sessionId: string;
	cwd: string;
	system: string;
	gateway: NativeModelGateway;
	tools: NativeTool[];
	/** Returns false when a write-capable tool is denied. Read-only tools are not asked. */
	approve?: (call: NativeToolCall) => Promise<boolean | string>;
	maxTurns?: number;
	onEvent: (event: NativeLoopEvent) => void;
}
