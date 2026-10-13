import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, EventType, SessionDetail, ToolCall } from "../../shared/src/protocol.ts";

export interface AdaptedEvent {
	type: EventType;
	message?: ChatMessage;
	tool?: ToolCall;
	error?: string;
}

function chatMessage(message: AgentMessage, complete: boolean): ChatMessage | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const timestamp = new Date(message.timestamp).toISOString();
	const content = message.content;
	return {
		id: `${message.role}:${randomUUID()}`,
		role: message.role,
		timestamp,
		text:
			typeof content === "string"
				? content
				: content
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

export function adaptRpcEvent(event: JsonAgentSessionEvent, state: SessionDetail): AdaptedEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { type: "session.started" };
		case "agent_end":
		case "agent_settled":
			return { type: "agent.status" };
		case "message_start": {
			const message = chatMessage(event.message, false);
			return message ? { type: "message.delta", message } : undefined;
		}
		case "message_update": {
			const pending = state.messages.findLast((message) => message.role === "assistant" && !message.complete);
			if (!pending) return undefined;
			const assistantEvent = event.assistantMessageEvent;
			const message =
				assistantEvent.type === "text_delta"
					? { ...pending, text: pending.text + assistantEvent.delta }
					: assistantEvent.type === "thinking_delta"
						? { ...pending, thinking: pending.thinking + assistantEvent.delta }
						: undefined;
			return message ? { type: "message.delta", message } : undefined;
		}
		case "message_end": {
			const message = chatMessage(event.message, true);
			if (!message) return undefined;
			const pending = state.messages.findLast((previous) => previous.role === message.role && !previous.complete);
			if (pending) message.id = pending.id;
			return {
				type: "message.completed",
				message,
				error: message.error,
			};
		}
		case "tool_execution_start":
			return {
				type: "tool.started",
				tool: {
					id: event.toolCallId,
					name: event.toolName,
					input: event.args,
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
				output: event.type === "tool_execution_end" ? event.result : event.partialResult,
				durationMs: event.type === "tool_execution_end" ? event.durationMs : undefined,
			};
			return { type: event.type === "tool_execution_end" ? "tool.completed" : "tool.updated", tool };
		}
		default:
			return undefined;
	}
}

export function adaptSdkEvent(event: AgentSessionEvent, state: SessionDetail): AdaptedEvent | undefined {
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
