import { randomUUID } from "node:crypto";
import type { ChatMessage, SessionDetail, ToolCall } from "../../../shared/src/protocol.ts";
import type { AdaptedEvent } from "../adapter.ts";

/**
 * Lifecycle phase of a runtime event, independent of the event type.
 * The workbench only needs to know when a run starts and ends.
 */
export type RuntimePhase = "started" | "ended" | "update";

/** A workbench event produced from a runtime event, with its lifecycle phase. */
export interface RuntimeEvent {
	phase: RuntimePhase;
	adapted: AdaptedEvent;
}

type PiContent = Array<{ type: string; text?: string; thinking?: string }>;

interface PiMessage {
	role: string;
	timestamp: number;
	content: PiContent;
	errorMessage?: string;
}

export type PiEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "message_start" | "message_update" | "message_end"; message: PiMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			durationMs?: number;
	  };

function chatMessage(message: PiMessage, complete: boolean): ChatMessage | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const timestamp = new Date(message.timestamp).toISOString();
	const content = message.content;
	return {
		id: `${message.role}:${randomUUID()}`,
		role: message.role,
		timestamp,
		text: content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(""),
		thinking:
			message.role === "assistant"
				? message.content
						.filter((block) => block.type === "thinking")
						.map((block) => block.thinking)
						.join("\n")
				: "",
		complete,
		error: message.role === "assistant" ? message.errorMessage : undefined,
	};
}

export function adaptSdkEvent(event: PiEvent, state: SessionDetail): AdaptedEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { type: "session.started" };
		case "agent_end":
			return { type: "agent.status" };
		case "message_start":
		case "message_update":
		case "message_end": {
			const message = chatMessage(event.message, event.type === "message_end");
			if (message && event.type !== "message_start") {
				const pending = state.messages.findLast(
					(previous) =>
						previous.role === message.role && previous.timestamp === message.timestamp && !previous.complete,
				);
				if (pending) message.id = pending.id;
			}
			return message
				? {
						type: event.type === "message_end" ? "message.completed" : "message.delta",
						message,
						error: message.error,
					}
				: undefined;
		}
		case "tool_execution_start":
			return {
				type: "tool.started",
				tool: {
					id: event.toolCallId,
					name: event.toolName,
					input: event.args as unknown,
					status: "running",
					startedAt: new Date().toISOString(),
				},
			};
		case "tool_execution_update":
		case "tool_execution_end": {
			const previous = state.tools.find((tool) => tool.id === event.toolCallId);
			const tool: ToolCall = {
				id: event.toolCallId,
				name: event.toolName,
				input: previous?.input,
				startedAt: previous?.startedAt ?? new Date().toISOString(),
				status: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "running",
				output: event.type === "tool_execution_end" ? (event.result as unknown) : (event.partialResult as unknown),
				durationMs: event.type === "tool_execution_end" ? event.durationMs : undefined,
			};
			return { type: event.type === "tool_execution_end" ? "tool.completed" : "tool.updated", tool };
		}
		default:
			return undefined;
	}
}

/** Translate a runtime event into a workbench event plus its lifecycle phase. */
export function adaptRuntimeEvent(event: PiEvent, state: SessionDetail): RuntimeEvent | undefined {
	const adapted = adaptSdkEvent(event, state);
	if (!adapted) return undefined;
	const phase: RuntimePhase =
		event.type === "agent_start" ? "started" : event.type === "agent_end" ? "ended" : "update";
	return { phase, adapted };
}
