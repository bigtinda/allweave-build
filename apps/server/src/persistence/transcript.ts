import { readFileSync } from "node:fs";
import type { ChatMessage, ToolCall } from "../../../shared/src/protocol.ts";
import type { TranscriptView } from "./session-projection.ts";

const RESTART_OUTPUT = "Server restarted before execution completed";
const CURRENT_SESSION_VERSION = 3;

interface TranscriptEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: number;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: number;
		errorMessage?: string;
		toolCallId?: string;
		isError?: boolean;
		details?: unknown;
		durationMs?: number;
	};
}

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

function readEntries(file: string): TranscriptEntry[] {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: TranscriptEntry[] = [];
	for (const line of content.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			entries.push(value as TranscriptEntry);
		} catch {
			// A torn final line is expected after a hard stop.
		}
	}
	return entries;
}

function activeBranch(entries: TranscriptEntry[]): TranscriptEntry[] {
	const byId = new Map<string, TranscriptEntry>();
	for (const entry of entries) if (entry.id) byId.set(entry.id, entry);
	const leaf = [...entries].reverse().find((entry) => entry.type === "message");
	if (!leaf) return [];
	const path: TranscriptEntry[] = [];
	const seen = new Set<string>();
	let current: TranscriptEntry | undefined = leaf;
	while (current) {
		if (!current.id || seen.has(current.id)) break;
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

/**
 * Rebuild the workbench conversation from the JSONL transcript.
 *
 * The transcript is the source of truth for conversation content. Only the
 * active branch is read, so recall, rewind and branch keep their meaning.
 */
export function readTranscriptView(file: string): TranscriptView {
	const allEntries = readEntries(file);
	const header = allEntries.find((entry) => entry.type === "session") as { version?: unknown } | undefined;
	if (header && typeof header.version === "number" && header.version > CURRENT_SESSION_VERSION)
		return { messages: [], tools: [] };
	const entries = allEntries.filter((entry) => entry.type !== "session");
	const messages: ChatMessage[] = [];
	const tools: ToolCall[] = [];
	const toolsById = new Map<string, ToolCall>();
	for (const entry of activeBranch(entries)) {
		const message = entry.message;
		if (!message) continue;
		const timestampMs = message.timestamp ?? entry.timestamp ?? Date.now();
		const timestamp = new Date(timestampMs).toISOString();
		if (message.role === "user") {
			messages.push({
				id: `user:${entry.id}`,
				role: "user",
				text: textOf(message.content),
				thinking: "",
				complete: true,
				timestamp,
			});
			continue;
		}
		if (message.role === "assistant") {
			messages.push({
				id: `assistant:${entry.id}`,
				role: "assistant",
				text: textOf(message.content),
				thinking: thinkingOf(message.content),
				complete: true,
				timestamp,
				...(message.errorMessage ? { error: message.errorMessage } : {}),
			});
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (typeof block !== "object" || block === null || block.type !== "toolCall") continue;
					const call = block as { id: string; name: string; arguments?: unknown };
					const tool: ToolCall = {
						id: call.id,
						name: call.name,
						input: (call.arguments ?? {}) as Record<string, unknown>,
						status: "failed",
						startedAt: timestamp,
					};
					tools.push(tool);
					toolsById.set(tool.id, tool);
				}
			}
			continue;
		}
		if (message.role === "toolResult" && message.toolCallId) {
			const tool = toolsById.get(message.toolCallId);
			if (!tool) continue;
			tool.status = message.isError ? "failed" : "completed";
			tool.output = { content: message.content, details: message.details };
			if (message.durationMs !== undefined) tool.durationMs = message.durationMs;
		}
	}
	for (const tool of tools) {
		if (tool.status === "failed" && tool.output === undefined) tool.output = RESTART_OUTPUT;
	}
	return { messages, tools };
}
