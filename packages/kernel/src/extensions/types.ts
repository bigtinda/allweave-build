import type { NativeMessage, NativeTool, NativeToolCall, NativeToolResult } from "../engine/types.ts";

export type MaybePromise<T> = T | Promise<T>;

export type ExtensionHookName =
	| "session_start"
	| "session_shutdown"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_end"
	| "tool_call"
	| "tool_result"
	| "context"
	| "model_select";

export interface ExtensionSessionEvent {
	sessionId: string;
	cwd: string;
	reason: "start" | "shutdown" | "reload";
}

export interface ExtensionTurnEvent {
	sessionId: string;
	turn: number;
	messages: NativeMessage[];
}

export interface ExtensionMessageEvent {
	sessionId: string;
	message: NativeMessage;
}

export interface ExtensionModelEvent {
	sessionId: string;
	model: string;
}

export interface ExtensionContextEvent {
	sessionId: string;
	system: string;
	messages: NativeMessage[];
}

export interface ExtensionContextPatch {
	system?: string;
	messages?: NativeMessage[];
}

export interface ExtensionToolCallEvent {
	sessionId: string;
	toolCall: NativeToolCall;
	tool: NativeTool;
}

export type ExtensionToolCallDecision = { block: true; reason: string } | { input: Record<string, unknown> };

export interface ExtensionToolResultEvent {
	sessionId: string;
	toolCall: NativeToolCall;
	result: NativeToolResult;
}

export interface ExtensionToolResultPatch {
	content?: string;
	isError?: boolean;
}

export interface ExtensionHooks {
	session_start?(event: ExtensionSessionEvent): MaybePromise<void>;
	session_shutdown?(event: ExtensionSessionEvent): MaybePromise<void>;
	turn_start?(event: ExtensionTurnEvent): MaybePromise<void>;
	turn_end?(event: ExtensionTurnEvent): MaybePromise<void>;
	message_start?(event: ExtensionMessageEvent): MaybePromise<void>;
	message_end?(event: ExtensionMessageEvent): MaybePromise<void>;
	// biome-ignore lint/suspicious/noConfusingVoidType: a hook may observe without returning a decision
	tool_call?(event: ExtensionToolCallEvent): MaybePromise<ExtensionToolCallDecision | void>;
	// biome-ignore lint/suspicious/noConfusingVoidType: a hook may observe without patching
	tool_result?(event: ExtensionToolResultEvent): MaybePromise<ExtensionToolResultPatch | void>;
	// biome-ignore lint/suspicious/noConfusingVoidType: a hook may observe without patching
	context?(event: ExtensionContextEvent): MaybePromise<ExtensionContextPatch | void>;
	model_select?(event: ExtensionModelEvent): MaybePromise<void>;
}

export interface ExtensionResourceProvider {
	name: string;
	load(): Promise<Array<{ name: string; description: string; filePath?: string }>>;
}

export interface KernelExtension {
	name: string;
	hooks?: ExtensionHooks;
	tools?: NativeTool[];
	resources?: ExtensionResourceProvider[];
}

export interface ExtensionDiagnostic {
	extension: string;
	level: "info" | "warn";
	message: string;
}
