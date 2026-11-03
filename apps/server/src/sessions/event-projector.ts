import {
	applyEvent,
	type RunUsage,
	type SessionDetail,
	type SessionEvent,
	type SessionSummary,
	type SessionUsageRecord,
} from "../../../shared/src/protocol.ts";
import type { AdaptedEvent } from "../adapter.ts";
import {
	emptyDetail,
	LegacyMetadataConflict,
	mergeSnapshot,
	mergeTranscript,
	normalizeRestored,
	projectSessionMeta,
	projectSummary,
	type SessionMeta,
} from "../persistence/session-projection.ts";
import { readTranscriptView } from "../persistence/transcript.ts";
import { HttpError } from "../security.ts";
import type { SavedSession } from "../store.ts";

export interface ProjectedEvent {
	event: SessionEvent;
	detail: SessionDetail;
}

/** Change applied to the session draft before it is persisted. */
export type SessionMutation = (draft: SessionDetail, change: AdaptedEvent) => void;

/** The storage operations the projection needs. */
export interface SessionStore {
	/** Lightweight records loaded at boot. */
	sessionMetas(): SessionMeta[];
	/** Full snapshot of one session; only read when a session is opened. */
	loadSessionSnapshot(id: string): SavedSession | undefined;
	loadSessionEvents?(id: string, after: number): SessionEvent[];
	saveSessionMeta(meta: SessionMeta): void;
	saveSession(detail: SessionDetail, file?: string): void;
	deleteSession(id: string): void;
	append(event: Omit<SessionEvent, "eventId">): SessionEvent;
	flushPending?(): void;
	withTransaction<T>(operation: () => T): T;
}

interface SessionRecord {
	meta: SessionMeta;
	/** The full projection. Absent until the session is first opened. */
	detail?: SessionDetail;
}

/**
 * Owns the session projection: the lightweight records, the lazy hydration and
 * the atomic event plus snapshot transaction.
 *
 * Boot only reads summaries. Opening a session rebuilds the conversation from
 * the Pi transcript (or the retained legacy snapshot) and merges the UI-only
 * fields stored beside the summary. Every change still goes through
 * {@link EventProjector.project}, so the stored records and the event stream
 * cannot disagree.
 */
export class EventProjector {
	private store: SessionStore;
	private records = new Map<string, SessionRecord>();

	constructor(store: SessionStore) {
		this.store = store;
		for (const meta of store.sessionMetas()) {
			// A restart clears pending approvals and marks the session idle without
			// loading the conversation body.
			if (meta.summary.status !== "idle") {
				meta.summary.status = "idle";
				store.saveSessionMeta(meta);
			}
			this.records.set(meta.summary.id, { meta });
		}
	}

	/** Persisted events after a client sequence, for WebSocket resume. */
	replay(id: string, after: number): SessionEvent[] {
		this.get(id);
		return this.store.loadSessionEvents?.(id, after) ?? [];
	}

	list(): SessionSummary[] {
		return [...this.records.values()]
			.map((record) => ({ ...record.meta.summary }))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	usage(): SessionUsageRecord[] {
		const records = this.list().map((summary) => {
			const meta = this.records.get(summary.id)!.meta;
			return {
				id: summary.id,
				workspaceId: summary.workspaceId,
				title: summary.title,
				updatedAt: summary.updatedAt,
				model: summary.model,
				...(meta.tokens ? { tokens: meta.tokens } : {}),
				...(meta.lastRunUsage ? { lastRunUsage: meta.lastRunUsage } : {}),
				runs: meta.usageHistory,
			};
		});
		const recentRuns = records
			.flatMap((record) => record.runs.map((run) => ({ sessionId: record.id, run })))
			.sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt))
			.slice(0, 5000);
		const runsBySession = new Map<string, RunUsage[]>();
		for (const { sessionId, run } of recentRuns) {
			const sessionRuns = runsBySession.get(sessionId) ?? [];
			sessionRuns.push(run);
			runsBySession.set(sessionId, sessionRuns);
		}
		return records.map((record) => ({ ...record, runs: runsBySession.get(record.id) ?? [] }));
	}

	setArchived(id: string, archived: boolean): SessionSummary {
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		if (archived) {
			record.meta.summary.archivedAt = new Date().toISOString();
			if (record.detail) record.detail.archivedAt = record.meta.summary.archivedAt;
		} else {
			delete record.meta.summary.archivedAt;
			if (record.detail) delete record.detail.archivedAt;
		}
		this.store.saveSessionMeta(record.meta);
		return { ...record.meta.summary };
	}

	has(id: string): boolean {
		return this.records.has(id);
	}

	get(id: string): SessionDetail {
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		try {
			record.detail ??= this.hydrate(record.meta);
		} catch (error) {
			if (error instanceof LegacyMetadataConflict) throw new HttpError(409, error.message);
			throw error;
		}
		return record.detail;
	}

	/** Read the session body on first use. */
	private hydrate(meta: SessionMeta): SessionDetail {
		if (meta.checkpointSequence !== undefined) {
			const snapshot = this.store.loadSessionSnapshot(meta.summary.id)?.detail;
			if (!snapshot || !this.store.loadSessionEvents || snapshot.sequence !== meta.checkpointSequence)
				throw new HttpError(409, "会话流式检查点缺失，请恢复备份；原数据未被覆盖");
			const replayed = this.store.loadSessionEvents(meta.summary.id, snapshot.sequence).reduce(applyEvent, snapshot);
			if (replayed.sequence !== meta.sequence)
				throw new HttpError(409, "会话流式事件不完整，请恢复备份；原数据未被覆盖");
			const detail = normalizeRestored(mergeSnapshot(meta, replayed));
			if (meta.failure) detail.recoveryRequired = true;
			return detail;
		}
		// Version 1 recorded only some message ids. Upgrade on access using the
		// retained snapshot, without loading all snapshots during startup.
		let legacySnapshot: SessionDetail | undefined;
		if (meta.version < 2) {
			const snapshot = this.store.loadSessionSnapshot(meta.summary.id)?.detail;
			legacySnapshot = snapshot;
			if (snapshot && snapshot.sequence >= meta.sequence) {
				const upgraded = projectSessionMeta(snapshot, meta.file);
				const next = { ...meta, version: upgraded.version, messages: upgraded.messages, tools: upgraded.tools };
				this.store.saveSessionMeta(next);
				Object.assign(meta, next);
			}
		}
		let transcript: ReturnType<typeof readTranscriptView> | undefined;
		if (meta.file) {
			try {
				transcript = readTranscriptView(meta.file);
			} catch {
				// A missing or unreadable transcript falls back to the retained snapshot.
			}
		}
		let detail: SessionDetail;
		if (transcript && (transcript.messages.length > 0 || transcript.tools.length > 0)) {
			const evidence =
				meta.version < 2
					? [
							...(legacySnapshot?.messages ?? []),
							...(this.store.loadSessionEvents?.(meta.summary.id, 0) ?? []).flatMap(
								(event) => event.conversation?.messages ?? (event.message ? [event.message] : []),
							),
						]
					: [];
			detail = normalizeRestored(mergeTranscript(meta, transcript, evidence));
		} else {
			// The transcript is authoritative; the retained snapshot is the fallback.
			const snapshot = this.store.loadSessionSnapshot(meta.summary.id)?.detail;
			if (!snapshot && (meta.messages.length || meta.tools.length))
				throw new HttpError(409, "会话历史与快照均不可用，请恢复备份；原元数据未被覆盖");
			detail = normalizeRestored(snapshot ? mergeSnapshot(meta, snapshot) : emptyDetail(meta));
		}
		if (meta.failure) detail.recoveryRequired = true;
		return detail;
	}

	create(detail: SessionDetail): SessionDetail {
		const meta = projectSessionMeta(detail);
		this.records.set(detail.id, { meta, detail });
		this.store.saveSessionMeta(meta);
		this.store.saveSession(detail);
		this.store.flushPending?.();
		return detail;
	}

	remove(id: string): void {
		this.records.delete(id);
		this.store.deleteSession(id);
	}

	/** Transcript file of a session. */
	file(id: string): string | undefined {
		return this.records.get(id)?.meta.file;
	}

	setFile(id: string, file: string | undefined): void {
		const record = this.records.get(id);
		if (!record) return;
		record.meta.file = file;
		this.store.saveSessionMeta(record.meta);
	}

	/** Mark a session whose projection failed; the marker survives a restart. */
	markFailed(id: string, reason: string): void {
		const record = this.records.get(id);
		if (!record) return;
		record.meta.failure = reason;
		if (record.detail) record.detail.recoveryRequired = true;
		try {
			this.store.saveSessionMeta(record.meta);
		} catch {
			// The metadata write can fail for the same reason as the projection.
		}
	}

	/** Sessions that need a transcript recovery, keyed by session id. */
	failures(): Map<string, string> {
		const failures = new Map<string, string>();
		for (const record of this.records.values()) {
			if (record.meta.failure) failures.set(record.meta.summary.id, record.meta.failure);
		}
		return failures;
	}

	/**
	 * Rebuild a session from its Pi transcript. The recovery is itself a
	 * projected event, so the event stream, the lightweight record and the
	 * retained snapshot return to a consistent state.
	 */
	recover(id: string): ProjectedEvent {
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		const file = record.meta.file;
		if (!file) throw new HttpError(409, "该会话没有 transcript，无法恢复");
		let transcript: ReturnType<typeof readTranscriptView>;
		try {
			transcript = readTranscriptView(file);
		} catch {
			throw new HttpError(409, "无法读取该会话的 transcript，无法恢复");
		}
		const updatedAt = new Date().toISOString();
		let base: SessionDetail;
		try {
			const evidence =
				record.meta.version < 2
					? [
							...(this.store.loadSessionSnapshot(id)?.detail.messages ?? []),
							...(this.store.loadSessionEvents?.(id, 0) ?? []).flatMap(
								(event) => event.conversation?.messages ?? (event.message ? [event.message] : []),
							),
						]
					: [];
			base = { ...normalizeRestored(mergeTranscript(record.meta, transcript, evidence)), updatedAt };
		} catch (error) {
			if (error instanceof LegacyMetadataConflict) throw new HttpError(409, error.message);
			throw error;
		}
		const { event, detail, meta } = this.store.withTransaction(() => {
			const event = this.store.append({
				type: "session.recovered",
				sessionId: id,
				messageId: null,
				timestamp: updatedAt,
				conversation: { messages: base.messages, tools: base.tools },
				summary: projectSummary(base),
				approvals: [],
				tokens: base.tokens,
				lastRunUsage: base.lastRunUsage,
				error: base.error,
				recoveryRequired: false,
			});
			const detail = applyEvent({ ...base, recoveryRequired: true }, event);
			const meta = projectSessionMeta(detail, file);
			meta.usageHistory = record.meta.usageHistory;
			this.store.saveSessionMeta(meta);
			this.store.saveSession(detail, file);
			return { event, detail, meta };
		});
		record.detail = detail;
		record.meta = meta;
		return { event, detail };
	}

	/**
	 * Project a workbench event into SQLite: the event row, the lightweight record
	 * and the retained snapshot share one commit. The mutation runs on the draft
	 * inside the transaction, so a failed write leaves the in-memory record
	 * untouched.
	 */
	project(id: string, change: AdaptedEvent, mutate?: SessionMutation): ProjectedEvent {
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		const current = this.get(id);
		const updatedAt = new Date().toISOString();
		const draft: SessionDetail = { ...current, updatedAt };
		if (change.error) draft.error = change.error;
		mutate?.(draft, change);
		const previousRunAt = record.meta.lastRunUsage?.startedAt;
		const completedRun =
			change.type === "agent.status" && draft.lastRunUsage && draft.lastRunUsage.startedAt !== previousRunAt
				? draft.lastRunUsage
				: undefined;
		const { event, detail, meta } = this.store.withTransaction(() => {
			const event = this.store.append({
				...change,
				sessionId: id,
				messageId:
					change.message?.id ??
					(change.tool ? (draft.messages.findLast((message) => message.role === "assistant")?.id ?? null) : null),
				timestamp: updatedAt,
				summary: projectSummary(draft),
				approvals: [...draft.approvals],
				tokens: draft.tokens,
				lastRunUsage: draft.lastRunUsage,
				error: draft.error,
				...(record.meta.failure ? { recoveryRequired: true } : {}),
			});
			const detail = applyEvent(draft, event);
			const meta = projectSessionMeta(detail, record.meta.file);
			meta.usageHistory = [...record.meta.usageHistory, ...(completedRun ? [completedRun] : [])].slice(-500);
			const incremental =
				this.store.loadSessionEvents &&
				(change.type === "message.delta" || change.type === "tool.updated") &&
				(record.meta.checkpointSequence === undefined || current.sequence - record.meta.checkpointSequence < 100);
			if (incremental) meta.checkpointSequence = record.meta.checkpointSequence ?? current.sequence;
			// Only an explicit recovery clears the marker.
			if (record.meta.failure) meta.failure = record.meta.failure;
			this.store.saveSessionMeta(meta);
			if (!incremental) this.store.saveSession(detail, record.meta.file);
			return { event, detail, meta };
		});
		record.detail = detail;
		record.meta = meta;
		return { event, detail };
	}
}
