import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { SessionDetail, SessionEvent, Workspace } from "../../shared/src/protocol.ts";
import { parseSessionMeta, projectSessionMeta, type SessionMeta } from "./persistence/session-projection.ts";

export interface SavedSession {
	detail: SessionDetail;
	file?: string;
}

function decodeSnapshot(data: unknown): SessionDetail {
	return JSON.parse(data instanceof Uint8Array ? gunzipSync(data).toString("utf8") : String(data)) as SessionDetail;
}

export class ConsoleStore {
	db: DatabaseSync;
	private pendingSessions = new Map<string, SavedSession>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	private transactionDepth = 0;
	constructor(directory: string) {
		mkdirSync(directory, { recursive: true });
		this.db = new DatabaseSync(join(directory, "console.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_workspaces (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, file TEXT);
      CREATE TABLE IF NOT EXISTS session_summaries (id TEXT PRIMARY KEY, version INTEGER NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, file TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, data TEXT NOT NULL);`);
		this.db.exec("CREATE INDEX IF NOT EXISTS events_session_id ON events(session_id, id)");
		// Additive migration for databases written before the sequence column existed.
		const metaColumns = new Set(
			Array.from(this.db.prepare("PRAGMA table_info(session_summaries)").iterate(), (row) => String(row.name)),
		);
		if (!metaColumns.has("sequence")) {
			this.db.exec("ALTER TABLE session_summaries ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0");
		}
	}
	/**
	 * Minimal synchronous transaction boundary. Nested calls join the outer
	 * transaction so callers can compose writes without juggling savepoints.
	 * The callback must stay synchronous: no network, prompts or listeners.
	 */
	withTransaction<T>(operation: () => T): T {
		if (this.transactionDepth > 0) return operation();
		this.db.exec("BEGIN IMMEDIATE");
		this.transactionDepth++;
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.transactionDepth--;
		}
	}
	workspaces(): Workspace[] {
		return this.db
			.prepare("SELECT data FROM workspaces")
			.all()
			.map((row) => JSON.parse(String(row.data)) as Workspace);
	}
	saveWorkspace(workspace: Workspace): void {
		this.db.prepare("INSERT OR REPLACE INTO workspaces VALUES (?, ?)").run(workspace.id, JSON.stringify(workspace));
		if (!workspace.remote) this.clearWorkspaceRemoval(workspace.path);
	}
	workspaceWasRemoved(path: string): boolean {
		return this.db.prepare("SELECT 1 FROM removed_workspaces WHERE path = ?").get(path) !== undefined;
	}
	clearWorkspaceRemoval(path: string): void {
		this.db.prepare("DELETE FROM removed_workspaces WHERE path = ?").run(path);
	}
	deleteWorkspace(id: string, path: string, recordRemoval = true): void {
		this.withTransaction(() => {
			this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
			if (recordRemoval) this.db.prepare("INSERT OR REPLACE INTO removed_workspaces VALUES (?)").run(path);
		});
	}
	sessions(): SavedSession[] {
		this.flush();
		return Array.from(this.db.prepare("SELECT data, file FROM sessions").iterate(), (row) => ({
			detail: decodeSnapshot(row.data),
			file: typeof row.file === "string" ? row.file : undefined,
		}));
	}
	/**
	 * Lightweight session records. Rows written by an older version are migrated
	 * once from their full snapshot, so later boots never read the snapshots.
	 */
	sessionMetas(): SessionMeta[] {
		this.flush();
		this.migrateLegacySessions();
		return Array.from(this.db.prepare("SELECT data FROM session_summaries").iterate(), (row) =>
			parseSessionMeta(String(row.data)),
		);
	}
	saveSessionMeta(meta: SessionMeta): void {
		this.db
			.prepare("INSERT OR REPLACE INTO session_summaries (id, version, sequence, data, file) VALUES (?, ?, ?, ?, ?)")
			.run(meta.summary.id, meta.version, meta.sequence, JSON.stringify(meta), meta.file ?? null);
	}
	/** Move plugin-development sessions to the current plugin workspace without reading their bodies. */
	reassignPluginDevelopmentSessions(workspaceId: string): void {
		for (const meta of this.sessionMetas()) {
			if (meta.summary.purpose !== "plugin-development" || meta.summary.workspaceId === workspaceId) continue;
			meta.summary.workspaceId = workspaceId;
			this.saveSessionMeta(meta);
		}
	}
	private migrateLegacySessions(): void {
		// Rows without a summary were written before the lightweight records
		// existed. Rows whose event log is ahead of the summary were written by an
		// older build during the downgrade window, which appends events and full
		// snapshots but knows nothing about session_summaries.
		const rows = this.db
			.prepare(
				`SELECT sessions.id AS id, sessions.data AS data, sessions.file AS file,
					session_summaries.data AS summary_data,
					session_summaries.sequence AS summary_sequence,
					(SELECT MAX(id) FROM events WHERE session_id = sessions.id) AS event_sequence
				FROM sessions
				LEFT JOIN session_summaries ON session_summaries.id = sessions.id
				WHERE session_summaries.id IS NULL
					OR (SELECT MAX(id) FROM events WHERE session_id = sessions.id) > session_summaries.sequence`,
			)
			.all();
		if (!rows.length) return;
		this.withTransaction(() => {
			for (const row of rows) {
				const eventSequence = typeof row.event_sequence === "number" ? row.event_sequence : 0;
				const summarySequence = typeof row.summary_sequence === "number" ? row.summary_sequence : undefined;
				const detail = decodeSnapshot(row.data);
				// Rebuild from the snapshot only when it is at least as new as the
				// summary. Otherwise an older build merely appended an event without
				// rewriting its snapshot, so the existing summary is still the best one.
				const meta =
					summarySequence !== undefined && summarySequence >= detail.sequence
						? parseSessionMeta(String(row.summary_data))
						: projectSessionMeta(detail, typeof row.file === "string" ? row.file : undefined);
				// Adopt the newest event id so an incomplete snapshot write does not
				// trigger the migration on every boot.
				meta.sequence = Math.max(meta.sequence, detail.sequence, eventSequence);
				this.saveSessionMeta(meta);
			}
		});
	}
	/** Read the full snapshot of one session; used as the hydration fallback. */
	loadSessionSnapshot(id: string): SavedSession | undefined {
		this.flush();
		const row = this.db.prepare("SELECT data, file FROM sessions WHERE id = ?").get(id);
		if (!row) return undefined;
		return {
			detail: decodeSnapshot(row.data),
			file: typeof row.file === "string" ? row.file : undefined,
		};
	}
	loadSessionEvents(id: string, after: number): SessionEvent[] {
		return Array.from(
			this.db.prepare("SELECT data FROM events WHERE session_id = ? AND id > ? ORDER BY id").iterate(id, after),
			(row) =>
				JSON.parse(
					row.data instanceof Uint8Array ? gunzipSync(row.data).toString("utf8") : String(row.data),
				) as SessionEvent,
		);
	}
	sessionFiles(): Map<string, string> {
		const files = new Map<string, string>();
		for (const row of this.db.prepare("SELECT id, file FROM session_summaries WHERE file IS NOT NULL").iterate()) {
			files.set(String(row.id), String(row.file));
		}
		for (const row of this.db.prepare("SELECT id, file FROM sessions WHERE file IS NOT NULL").iterate()) {
			if (!files.has(String(row.id))) files.set(String(row.id), String(row.file));
		}
		return files;
	}
	saveSession(detail: SessionDetail, file?: string, defer = false): void {
		if (defer) {
			this.pendingSessions.set(detail.id, { detail, file });
			this.flushTimer ??= setTimeout(() => this.flush(), 1000).unref();
			return;
		}
		this.pendingSessions.delete(detail.id);
		this.db
			.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)")
			.run(detail.id, gzipSync(JSON.stringify(detail), { level: 1 }), file ?? null);
	}
	private flush(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		for (const { detail, file } of this.pendingSessions.values()) this.saveSession(detail, file);
	}
	append(event: Omit<SessionEvent, "eventId">): SessionEvent {
		const result = this.db.prepare("INSERT INTO events (session_id, data) VALUES (?, ?)").run(event.sessionId, "");
		const stored = { ...event, eventId: Number(result.lastInsertRowid) };
		this.db
			.prepare("UPDATE events SET data = ? WHERE id = ?")
			.run(gzipSync(JSON.stringify(stored), { level: 1 }), stored.eventId);
		// Reconnect uses an authoritative snapshot. Keep only recent diagnostic events.
		const metaRow = this.db.prepare("SELECT data FROM session_summaries WHERE id = ?").get(stored.sessionId);
		const meta = metaRow ? parseSessionMeta(String(metaRow.data)) : undefined;
		// Never trim events needed to recover a streaming checkpoint.
		const cutoff = Math.min(stored.eventId - 1000, meta?.checkpointSequence ?? stored.eventId);
		this.db.prepare("DELETE FROM events WHERE session_id = ? AND id < ?").run(stored.sessionId, cutoff);
		return stored;
	}
	deleteSession(id: string): void {
		this.pendingSessions.delete(id);
		this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM session_summaries WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
	}
	compact(): void {
		this.flush();
		// Backfill the lightweight records before a maintenance snapshot of the database.
		this.migrateLegacySessions();
		// Migrate existing JSON rows without loading every transcript into memory at once.
		const updateSession = this.db.prepare("UPDATE sessions SET data = ? WHERE id = ?");
		for (const row of this.db.prepare("SELECT id, data FROM sessions WHERE typeof(data) = 'text'").iterate()) {
			updateSession.run(gzipSync(String(row.data), { level: 1 }), row.id);
		}
		const updateEvent = this.db.prepare("UPDATE events SET data = ? WHERE id = ?");
		for (const row of this.db.prepare("SELECT id, data FROM events WHERE typeof(data) = 'text'").iterate()) {
			updateEvent.run(gzipSync(String(row.data), { level: 1 }), row.id);
		}
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
	}
	close(): void {
		this.flush();
		this.db.close();
	}
}
