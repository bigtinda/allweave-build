import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, ToolCall } from "../../../shared/src/protocol.ts";
import type { TranscriptView } from "./session-projection.ts";

const RESTART_OUTPUT = "Server restarted before execution completed";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text")
		.map((block) => block.text)
		.join("");
}

function thinkingOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "thinking"; thinking: string } => block?.type === "thinking")
		.map((block) => block.thinking)
		.join("\n");
}

/**
 * Rebuild the workbench conversation from the Pi JSONL transcript.
 *
 * The transcript is the source of truth for the conversation content. Only the
 * active branch is read, so recall, rewind and branch keep their meaning. The
 * UI-only fields are merged separately by {@link mergeTranscript}.
 */
export function readTranscriptView(file: string): TranscriptView {
	const manager = SessionManager.open(file);
	const messages: ChatMessage[] = [];
	const tools: ToolCall[] = [];
	const toolsById = new Map<string, ToolCall>();
	for (const entry of manager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			messages.push({
				id: `user:${entry.id}`,
				role: "user",
				text: textOf(message.content),
				thinking: "",
				complete: true,
				timestamp: new Date(message.timestamp).toISOString(),
			});
			continue;
		}
		if (message.role === "assistant") {
			const timestamp = new Date(message.timestamp).toISOString();
			messages.push({
				id: `assistant:${entry.id}`,
				role: "assistant",
				text: textOf(message.content),
				thinking: thinkingOf(message.content),
				complete: true,
				timestamp,
				...(message.errorMessage ? { error: message.errorMessage } : {}),
			});
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const tool: ToolCall = {
					id: block.id,
					name: block.name,
					input: block.arguments,
					status: "failed",
					startedAt: timestamp,
				};
				tools.push(tool);
				toolsById.set(tool.id, tool);
			}
			continue;
		}
		if (message.role === "toolResult") {
			const tool = toolsById.get(message.toolCallId);
			if (!tool) continue;
			tool.status = message.isError ? "failed" : "completed";
			tool.output = { content: message.content, details: message.details };
			if (message.durationMs !== undefined) tool.durationMs = message.durationMs;
		}
	}
	// A call without a result was running when the server stopped.
	for (const tool of tools) {
		if (tool.status === "failed" && tool.output === undefined) tool.output = RESTART_OUTPUT;
	}
	return { messages, tools };
}
