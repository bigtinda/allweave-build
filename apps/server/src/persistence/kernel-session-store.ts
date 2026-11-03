import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { SqliteEventStore, type StoredEvent } from "@pi-console/kernel";
import type { Approval, SessionDetail, SessionEvent } from "../../../shared/src/protocol.ts";
import type { SessionStore } from "../sessions/event-projector.ts";
import type { SavedSession } from "../store.ts";
import { parseSessionMeta, projectSessionMeta, type SessionMeta } from "./session-projection.ts";

function decode(data: unknown): string {
	return data instanceof Uint8Array ? gunzipSync(data).toString("utf8") : String(data);
}

function hasTable(db: DatabaseSync, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function legacyRows(directory: string): { snapshots: SavedSession[]; events: Map<string, SessionEvent[]> } {
	const path = join(directory, "console.sqlite");
	if (!existsSync(path)) return { snapshots: [], events: new Map() };
	const db = new DatabaseSync(path);
	try {
		if (!hasTable(db, "sessions")) return { snapshots: [], events: new Map() };
		const snapshots = Array.from(db.prepare("SELECT data, file FROM sessions").iterate(), (row) => ({
			detail: JSON.parse(decode(row.data)) as SessionDetail,
			file: typeof row.file === "string" ? row.file : undefined,
		}));
		const events = new Map<string, SessionEvent[]>();
		if (hasTable(db, "events")) {
			for (const row of db.prepare("SELECT session_id, data FROM events ORDER BY id").iterate()) {
				const sessionId = String(row.session_id);
				const parsed = JSON.parse(decode(row.data)) as SessionEvent;
				const list = events.get(sessionId) ?? [];
				list.push(parsed);
				events.set(sessionId, list);
			}
		}
		return { snapshots, events };
	} finally {
		db.close();
	}
}

function legacyMeta(directory: string, id: string, detail: SessionDetail): SessionMeta {
	const path = join(directory, "console.sqlite");
	if (!existsSync(path)) return projectSessionMeta(detail);
	const db = new DatabaseSync(path);
	try {
		if (!hasTable(db, "session_summaries")) return projectSessionMeta(detail);
		const row = db.prepare("SELECT data FROM session_summaries WHERE id = ?").get(id);
		return row ? parseSessionMeta(String(row.data)) : projectSessionMeta(detail);
	} finally {
		db.close();
	}
}

/**
 * Session persistence for the workbench. The kernel store owns the event log,
 * snapshots and approvals; this adapter keeps the application-level projection
 * metadata next to them. Legacy `sessions`/`events` rows are imported once.
 */
export class KernelSessionStore implements SessionStore {
	private readonly events: SqliteEventStore;
	private readonly pending = new Map<string, SavedSession>();
	private pendingEvents: StoredEvent[] = [];
	private pendingMetas = new Map<string, SessionMeta>();
	private sequences = new Map<string, number>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	private flushError?: Error;

	constructor(directory: string, database?: DatabaseSync) {
		this.events = new SqliteEventStore(database ?? join(directory, "console.sqlite"));
		this.migrate(directory);
	}

	private migrate(directory: string): void {
		if (this.events.listSessions().length > 0) return;
		const legacy = legacyRows(directory);
		if (legacy.snapshots.length === 0) return;
		this.events.withTransaction(() => {
			for (const snapshot of legacy.snapshots) {
				const detail = snapshot.detail;
				const rows = legacy.events.get(detail.id) ?? [];
				const snapshotAt = detail.sequence;
				const replayedThrough = rows.filter((event) => event.eventId <= snapshotAt).length;
				const meta = legacyMeta(directory, detail.id, detail);
				meta.sequence = rows.length;
				meta.file = snapshot.file;
				if (meta.checkpointSequence !== undefined) meta.checkpointSequence = replayedThrough;
				const stored = rows.map((event, index) => ({
					...event,
					eventId: index + 1,
				}));
				if (snapshot.file)
					this.events.saveSnapshot({
						sessionId: detail.id,
						seq: replayedThrough,
						data: JSON.stringify({ ...detail, sequence: replayedThrough }),
						createdAt: detail.updatedAt,
					});
				this.events.putSession({
					id: detail.id,
					data: JSON.stringify(meta),
					seq: 0,
					file: snapshot.file,
					updatedAt: meta.summary.updatedAt,
				});
				for (const event of stored) {
					this.events.appendEvent({
						sessionId: event.sessionId,
						seq: event.eventId,
						type: event.type,
						data: JSON.stringify(event),
						createdAt: event.timestamp,
					});
				}
				this.events.putSession({
					id: detail.id,
					data: JSON.stringify(meta),
					seq: stored.length,
					file: snapshot.file,
					updatedAt: meta.summary.updatedAt,
				});
			}
		});
	}

	sessionMetas(): SessionMeta[] {
		this.flush();
		this.throwFlushError();
		return this.events.listSessions().map((session) => parseSessionMeta(session.data));
	}

	loadSessionSnapshot(id: string): SavedSession | undefined {
		this.flush();
		this.throwFlushError();
		const snapshot = this.events.getSnapshot(id);
		if (!snapshot) return undefined;
		const session = this.events.getSession(id);
		return {
			detail: JSON.parse(snapshot.data) as SessionDetail,
			file: session?.file,
		};
	}

	loadSessionEvents(id: string, after: number): SessionEvent[] {
		this.flush();
		this.throwFlushError();
		return this.events.eventsAfter(id, after).map((event) => JSON.parse(event.data) as SessionEvent);
	}

	saveSessionMeta(meta: SessionMeta): void {
		this.throwFlushError();
		meta.sequence = Math.max(
			meta.sequence,
			this.sequences.get(meta.summary.id) ?? this.events.latestSeq(meta.summary.id),
		);
		this.pendingMetas.set(meta.summary.id, meta);
		this.scheduleFlush();
	}

	saveSession(detail: SessionDetail, file?: string): void {
		this.pending.set(detail.id, { detail, file });
		this.scheduleFlush();
	}

	append(event: Omit<SessionEvent, "eventId">): SessionEvent {
		this.throwFlushError();
		const seq = this.nextSequence(event.sessionId);
		const stored = { ...event, eventId: seq };
		this.pendingEvents.push({
			sessionId: event.sessionId,
			seq,
			type: event.type,
			data: JSON.stringify(stored),
			createdAt: event.timestamp,
		});
		if (this.pendingEvents.length >= 64) this.flush();
		else this.scheduleFlush();
		return stored;
	}

	private nextSequence(sessionId: string): number {
		const current = this.sequences.get(sessionId) ?? this.events.latestSeq(sessionId);
		const next = current + 1;
		this.sequences.set(sessionId, next);
		return next;
	}

	private scheduleFlush(): void {
		this.flushTimer ??= setTimeout(() => this.flush(), 16).unref();
	}

	private throwFlushError(): void {
		if (!this.flushError) return;
		const error = this.flushError;
		this.flushError = undefined;
		throw error;
	}

	flushPending(): void {
		this.flush();
	}

	/** Coalesces deltas into one transaction; reads flush first. */
	private flush(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (!this.pendingEvents.length && !this.pendingMetas.size && !this.pending.size) return;
		const events = this.pendingEvents;
		const metas = [...this.pendingMetas.values()];
		const snapshots = [...this.pending.values()];
		this.pendingEvents = [];
		this.pendingMetas.clear();
		this.pending.clear();
		try {
			this.events.withTransaction(() => {
				for (const meta of metas)
					this.events.putSession({
						id: meta.summary.id,
						data: JSON.stringify(meta),
						seq: 0,
						file: meta.file,
						updatedAt: meta.summary.updatedAt,
					});
				for (const event of events) this.events.appendEvent(event);
				for (const meta of metas)
					this.events.putSession({
						id: meta.summary.id,
						data: JSON.stringify(meta),
						seq: meta.sequence,
						file: meta.file,
						updatedAt: meta.summary.updatedAt,
					});
				for (const { detail, file } of snapshots) {
					if (file)
						this.events.putSession({
							...(this.events.getSession(detail.id) ?? {
								id: detail.id,
								data: "{}",
								seq: 0,
								updatedAt: detail.updatedAt,
							}),
							file,
						});
					this.events.saveSnapshot({
						sessionId: detail.id,
						seq: detail.sequence,
						data: JSON.stringify(detail),
						createdAt: detail.updatedAt,
					});
				}
			});
		} catch (error) {
			this.flushError = error instanceof Error ? error : new Error(String(error));
			this.pendingEvents = events;
			for (const meta of metas) this.pendingMetas.set(meta.summary.id, meta);
			for (const snapshot of snapshots) this.pending.set(snapshot.detail.id, snapshot);
		}
	}

	deleteSession(id: string): void {
		this.flush();
		this.pending.delete(id);
		this.pendingMetas.delete(id);
		this.pendingEvents = this.pendingEvents.filter((event) => event.sessionId !== id);
		this.sequences.delete(id);
		this.events.deleteSession(id);
	}

	withTransaction<T>(operation: () => T): T {
		return this.events.withTransaction(operation);
	}

	sessionFiles(): Map<string, string> {
		const files = new Map<string, string>();
		for (const session of this.events.listSessions()) {
			if (session.file) files.set(session.id, session.file);
		}
		return files;
	}

	reassignPluginDevelopmentSessions(workspaceId: string): void {
		for (const meta of this.sessionMetas()) {
			if (meta.summary.purpose !== "plugin-development" || meta.summary.workspaceId === workspaceId) continue;
			meta.summary.workspaceId = workspaceId;
			this.saveSessionMeta(meta);
		}
	}

	compact(): void {
		this.flush();
		this.events.compact();
	}

	createApproval(sessionId: string, approval: Approval, toolCallId: string): void {
		this.events.createApproval({
			id: approval.id,
			sessionId,
			toolCallId,
			data: JSON.stringify(approval),
			status: "pending",
			expiresAt: approval.expiresAt,
			createdAt: new Date().toISOString(),
		});
	}

	settleApproval(id: string, status: "approved" | "denied" | "expired"): void {
		this.events.settleApproval(id, status);
	}

	expireApprovals(sessionId?: string): number {
		return this.events.expireApprovals(sessionId);
	}

	close(): void {
		this.flush();
		this.events.close();
	}
}
