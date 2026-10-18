import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { SessionDetail, SessionEvent, Workspace } from "../../shared/src/protocol.ts";

export interface SavedSession {
	detail: SessionDetail;
	file?: string;
}

export class ConsoleStore {
	db: DatabaseSync;
	private pendingSessions = new Map<string, SavedSession>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	constructor(directory: string) {
		mkdirSync(directory, { recursive: true });
		this.db = new DatabaseSync(join(directory, "console.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_workspaces (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, file TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, data TEXT NOT NULL);`);
		this.db.exec("CREATE INDEX IF NOT EXISTS events_session_id ON events(session_id, id)");
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
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
			if (recordRemoval) this.db.prepare("INSERT OR REPLACE INTO removed_workspaces VALUES (?)").run(path);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	sessions(): SavedSession[] {
		this.flush();
		return Array.from(this.db.prepare("SELECT data, file FROM sessions").iterate(), (row) => ({
			detail: JSON.parse(
				row.data instanceof Uint8Array ? gunzipSync(row.data).toString("utf8") : String(row.data),
			) as SessionDetail,
			file: typeof row.file === "string" ? row.file : undefined,
		}));
	}
	sessionFiles(): Map<string, string> {
		return new Map(
			Array.from(this.db.prepare("SELECT id, file FROM sessions WHERE file IS NOT NULL").iterate(), (row) => [
				String(row.id),
				String(row.file),
			]),
		);
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
		this.db
			.prepare("DELETE FROM events WHERE session_id = ? AND id < ?")
			.run(stored.sessionId, stored.eventId - 1000);
		return stored;
	}
	deleteSession(id: string): void {
		this.pendingSessions.delete(id);
		this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
	}
	compact(): void {
		this.flush();
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
