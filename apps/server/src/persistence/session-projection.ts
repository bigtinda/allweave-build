import type {
	Activity,
	ChatMessage,
	RunUsage,
	SessionDetail,
	SessionSummary,
	ToolCall,
} from "../../../shared/src/protocol.ts";

/** Version of the lightweight session record. Bump it when the shape changes. */
export const SESSION_META_VERSION = 3;

/**
 * UI-only fields of a chat message. They are not part of the Pi transcript, so
 * they are kept in the lightweight record and merged back on hydration.
 */
export interface MessageUiMetadata {
	role: ChatMessage["role"];
	/** ISO timestamp. It matches the transcript entry and identifies the message. */
	timestamp: string;
	id: string;
	input?: { text: string; references: string[] };
	changedFiles?: string[];
}

/** Tool fields the transcript cannot reproduce (the wall clock start time). */
export interface ToolUiMetadata {
	id: string;
	startedAt: string;
}

/**
 * The lightweight session record: everything the session list and a hydrated
 * transcript need, without the conversation bodies.
 */
export interface SessionMeta {
	version: number;
	summary: SessionSummary;
	file?: string;
	sequence: number;
	tokens?: SessionDetail["tokens"];
	error?: string;
	/** Set when a projection failed and the workbench state must be rebuilt. */
	failure?: string;
	activity: Activity[];
	messages: MessageUiMetadata[];
	tools: ToolUiMetadata[];
	lastRunUsage?: SessionDetail["lastRunUsage"];
	usageHistory: RunUsage[];
	/** Streaming events after this full snapshot must be replayed at hydration. */
	checkpointSequence?: number;
}

/** Project the summary shown by the session list. */
export function projectSummary(detail: SessionDetail): SessionSummary {
	const { id, workspaceId, title, purpose, archivedAt, status, updatedAt, model, thinkingLevel } = detail;
	return {
		id,
		workspaceId,
		title,
		purpose,
		archivedAt,
		status,
		updatedAt,
		model,
		thinkingLevel,
		accessMode: detail.accessMode,
	};
}

/** Build the lightweight record from a full projection. */
export function projectSessionMeta(detail: SessionDetail, file?: string): SessionMeta {
	return {
		version: SESSION_META_VERSION,
		lastRunUsage: detail.lastRunUsage,
		usageHistory: detail.lastRunUsage ? [detail.lastRunUsage] : [],
		summary: projectSummary(detail),
		file,
		sequence: detail.sequence,
		tokens: detail.tokens,
		error: detail.error,
		activity: detail.activity.slice(-150),
		// Only the fields the transcript lacks are stored, so the record stays small.
		messages: detail.messages.map((message) => ({
			role: message.role,
			timestamp: message.timestamp,
			id: message.id,
			...(message.input ? { input: message.input } : {}),
			...(message.changedFiles ? { changedFiles: message.changedFiles } : {}),
		})),
		tools: detail.tools.map((tool) => ({ id: tool.id, startedAt: tool.startedAt })),
	};
}

/** Parse a stored record, tolerating fields added after an older write. */
export function parseSessionMeta(raw: string): SessionMeta {
	const meta = JSON.parse(raw) as SessionMeta;
	if (typeof meta.version !== "number" || meta.version > SESSION_META_VERSION) {
		throw new Error(`Unsupported session metadata version: ${String(meta.version)}`);
	}
	meta.activity ??= [];
	meta.messages ??= [];
	meta.tools ??= [];
	meta.usageHistory ??= meta.lastRunUsage ? [meta.lastRunUsage] : [];
	meta.sequence ??= 0;
	return meta;
}

/** Apply the restart rules shared by every hydration path. */
export function normalizeRestored(detail: SessionDetail): SessionDetail {
	detail.accessMode ??= "ask";
	detail.status = detail.status === "interrupted" ? "interrupted" : "idle";
	detail.approvals = [];
	for (const tool of detail.tools) {
		if (tool.status === "running" || tool.status === "approval") {
			tool.status = "failed";
			tool.output = "Server restarted before execution completed";
		}
	}
	for (const message of detail.messages) message.complete = true;
	return detail;
}

/** A session without conversation bodies, used when no source can rebuild them. */
export function emptyDetail(meta: SessionMeta): SessionDetail {
	return {
		...meta.summary,
		lastRunUsage: meta.lastRunUsage,
		messages: [],
		tools: [],
		approvals: [],
		activity: meta.activity,
		sequence: meta.sequence,
		...(meta.tokens ? { tokens: meta.tokens } : {}),
		...(meta.error ? { error: meta.error } : {}),
	};
}

/** A transcript view rebuilt from the Pi JSONL file. */
export interface TranscriptView {
	messages: ChatMessage[];
	tools: ToolCall[];
}

export class LegacyMetadataConflict extends Error {}

/**
 * Merge the UI-only fields into a transcript view. Messages are matched by role
 * and timestamp, which the live projection and the transcript share, so the
 * original message ids survive a restart.
 */
export function mergeTranscript(meta: SessionMeta, view: TranscriptView, evidence: ChatMessage[] = []): SessionDetail {
	const messageMetadata = new Map<string, MessageUiMetadata[]>();
	for (const message of meta.messages) {
		const key = `${message.role}|${message.timestamp}`;
		const matches = messageMetadata.get(key) ?? [];
		matches.push(message);
		messageMetadata.set(key, matches);
	}
	const transcriptCounts = new Map<string, number>();
	for (const message of view.messages) {
		const key = `${message.role}|${message.timestamp}`;
		transcriptCounts.set(key, (transcriptCounts.get(key) ?? 0) + 1);
	}
	const ambiguousLegacyKeys = new Set(
		[...transcriptCounts]
			.filter(([key, count]) => (messageMetadata.get(key)?.length ?? 0) !== count)
			.map(([key]) => key),
	);
	// Old sparse rows still carry the original id. Retained snapshots/events can
	// identify their content even when the snapshot sequence is behind metadata.
	const resolved = new Map<ChatMessage, MessageUiMetadata>();
	if (meta.version < 2) {
		for (const key of ambiguousLegacyKeys) {
			const stored = messageMetadata.get(key);
			if (!stored) continue;
			const assigned = new Map<ChatMessage, MessageUiMetadata>();
			for (const item of stored) {
				const source = evidence.findLast((message) => message.id === item.id && message.complete);
				if (!source) continue;
				const candidates = view.messages.filter(
					(message) =>
						message.role === item.role &&
						message.timestamp === item.timestamp &&
						message.text === source.text &&
						message.thinking === source.thinking,
				);
				if (candidates.length === 1 && !assigned.has(candidates[0])) assigned.set(candidates[0], item);
			}
			if (assigned.size === stored.length) {
				for (const [message, item] of assigned) resolved.set(message, item);
				ambiguousLegacyKeys.delete(key);
				messageMetadata.delete(key);
			}
		}
	}
	if (meta.version < 2 && [...ambiguousLegacyKeys].some((key) => messageMetadata.has(key))) {
		throw new LegacyMetadataConflict("旧会话元数据无法准确匹配消息；请恢复完整快照或备份后重试，原数据未被覆盖");
	}
	const messages = view.messages.map((message) => {
		const key = `${message.role}|${message.timestamp}`;
		const matches = messageMetadata.get(key);
		if (meta.version < 2 && ambiguousLegacyKeys.has(key)) return message;
		const stored = resolved.get(message) ?? matches?.shift();
		if (!stored) return message;
		return {
			...message,
			id: stored.id,
			...(stored.input ? { input: stored.input } : {}),
			...(stored.changedFiles ? { changedFiles: stored.changedFiles } : {}),
		};
	});
	const toolMetadata = new Map(meta.tools.map((tool) => [tool.id, tool.startedAt]));
	const tools = view.tools.map((tool) => {
		const startedAt = toolMetadata.get(tool.id);
		return startedAt ? { ...tool, startedAt } : tool;
	});
	return {
		...meta.summary,
		lastRunUsage: meta.lastRunUsage,
		messages,
		tools,
		approvals: [],
		activity: meta.activity,
		sequence: meta.sequence,
		...(meta.tokens ? { tokens: meta.tokens } : {}),
		...(meta.error ? { error: meta.error } : {}),
	};
}

/** Reuse the legacy snapshot body while the lightweight record stays authoritative. */
export function mergeSnapshot(meta: SessionMeta, snapshot: SessionDetail): SessionDetail {
	return {
		...snapshot,
		lastRunUsage: meta.lastRunUsage,
		...meta.summary,
		approvals: [],
		activity: meta.activity.length ? meta.activity : snapshot.activity,
		sequence: meta.sequence,
		...(meta.tokens ? { tokens: meta.tokens } : {}),
		...(meta.error ? { error: meta.error } : {}),
	};
}
