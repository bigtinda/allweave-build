import type { ChatMessage, EventType, ToolCall } from "../../shared/src/protocol.ts";

/**
 * A workbench event before it is persisted: the transport-agnostic shape the
 * agent service turns into a `SessionEvent`.
 */
export interface AdaptedEvent {
	type: EventType;
	message?: ChatMessage;
	tool?: ToolCall;
	error?: string;
	conversation?: { messages: ChatMessage[]; tools: ToolCall[] };
	compaction?: { dropped: number; estimatedTokens: number };
}
