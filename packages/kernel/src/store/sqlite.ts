import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./schema.ts";
import type {
	ApprovalStatus,
	EventStore,
	StoredApproval,
	StoredEvent,
	StoredSession,
	StoredSnapshot,
} from "./types.ts";

function text(value: unknown): string {
	return String(value);
}

function session(row: Record<string, unknown>): StoredSession {
	const file = row.file;
	return {
		id: text(row.id),
		data: text(row.data),
		...(file === null || file === undefined ? {} : { file: text(file) }),
		seq: Number(row.seq),
		updatedAt: text(row.updated_at),
	};
}

function event(row: Record<string, unknown>): StoredEvent {
	return {
		sessionId: text(row.session_id),
		seq: Number(row.seq),
		type: text(row.type),
		data: text(row.data),
		createdAt: text(row.created_at),
	};
}

function snapshot(row: Record<string, unknown>): StoredSnapshot {
	return {
		sessionId: text(row.session_id),
		seq: Number(row.seq),
		data: text(row.data),
		createdAt: text(row.created_at),
	};
}

function approval(row: Record<string, unknown>): StoredApproval {
	return {
		id: text(row.id),
		sessionId: text(row.session_id),
		toolCallId: text(row.tool_call_id),
		data: text(row.data),
		status: text(row.status) as ApprovalStatus,
		expiresAt: text(row.expires_at),
		createdAt: text(row.created_at),
	};
}

export class SqliteEventStore implements EventStore {
	private readonly db: DatabaseSync;
	private readonly ownsConnection: boolean;
	private depth = 0;

	constructor(pathOrDatabase: string | DatabaseSync) {
		if (typeof pathOrDatabase === "string") {
			mkdirSync(dirname(pathOrDatabase), { recursive: true });
			this.db = new DatabaseSync(pathOrDatabase);
			this.ownsConnection = true;
		} else {
			this.db = pathOrDatabase;
			this.ownsConnection = false;
		}
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		this.db.exec(SCHEMA);
	}

	withTransaction<T>(operation: () => T): T {
		return this.transaction(operation);
	}

	private transaction<T>(operation: () => T): T {
		if (this.depth > 0) return operation();
		this.db.exec("BEGIN IMMEDIATE");
		this.depth++;
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.depth--;
		}
	}

	createSession(value: StoredSession): void {
		this.db
			.prepare("INSERT INTO kernel_sessions (id, data, file, seq, updated_at) VALUES (?, ?, ?, ?, ?)")
			.run(value.id, value.data, value.file ?? null, value.seq, value.updatedAt);
	}

	putSession(value: StoredSession): void {
		this.db
			.prepare(
				"INSERT INTO kernel_sessions (id, data, file, seq, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, file=excluded.file, seq=excluded.seq, updated_at=excluded.updated_at",
			)
			.run(value.id, value.data, value.file ?? null, value.seq, value.updatedAt);
	}

	getSession(id: string): StoredSession | undefined {
		const row = this.db.prepare("SELECT * FROM kernel_sessions WHERE id = ?").get(id);
		return row ? session(row) : undefined;
	}

	listSessions(): StoredSession[] {
		return this.db
			.prepare("SELECT * FROM kernel_sessions ORDER BY updated_at DESC")
			.all()
			.map((row) => session(row));
	}

	deleteSession(id: string): void {
		this.transaction(() => {
			this.db.prepare("DELETE FROM kernel_session_events WHERE session_id = ?").run(id);
			this.db.prepare("DELETE FROM kernel_session_snapshots WHERE session_id = ?").run(id);
			this.db.prepare("DELETE FROM kernel_approvals WHERE session_id = ?").run(id);
			this.db.prepare("DELETE FROM kernel_sessions WHERE id = ?").run(id);
		});
	}

	appendEvent(value: StoredEvent): void {
		this.transaction(() => {
			const current = this.latestSeq(value.sessionId);
			if (value.seq !== current + 1) {
				throw new Error(`event seq ${value.seq} does not follow ${current} for session ${value.sessionId}`);
			}
			this.db
				.prepare(
					"INSERT INTO kernel_session_events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(value.sessionId, value.seq, value.type, value.data, value.createdAt);
			const changed = this.db
				.prepare("UPDATE kernel_sessions SET seq = ?, updated_at = ? WHERE id = ?")
				.run(value.seq, value.createdAt, value.sessionId);
			if (Number(changed.changes) !== 1) {
				throw new Error(`session ${value.sessionId} does not exist`);
			}
		});
	}

	eventsAfter(sessionId: string, afterSeq = 0): StoredEvent[] {
		return this.db
			.prepare("SELECT * FROM kernel_session_events WHERE session_id = ? AND seq > ? ORDER BY seq")
			.all(sessionId, afterSeq)
			.map((row) => event(row));
	}

	latestSeq(sessionId: string): number {
		const row = this.db
			.prepare(
				"SELECT MAX(seq) AS seq FROM (SELECT seq FROM kernel_sessions WHERE id = ? UNION ALL SELECT seq FROM kernel_session_events WHERE session_id = ?)",
			)
			.get(sessionId, sessionId) as Record<string, unknown> | undefined;
		return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq);
	}

	saveSnapshot(value: StoredSnapshot): void {
		this.db
			.prepare(
				"INSERT INTO kernel_session_snapshots (session_id, seq, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq, data=excluded.data, created_at=excluded.created_at",
			)
			.run(value.sessionId, value.seq, value.data, value.createdAt);
	}

	getSnapshot(sessionId: string): StoredSnapshot | undefined {
		const row = this.db.prepare("SELECT * FROM kernel_session_snapshots WHERE session_id = ?").get(sessionId);
		return row ? snapshot(row) : undefined;
	}

	createApproval(value: StoredApproval): void {
		this.db
			.prepare(
				"INSERT INTO kernel_approvals (id, session_id, tool_call_id, data, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(value.id, value.sessionId, value.toolCallId, value.data, value.status, value.expiresAt, value.createdAt);
	}

	settleApproval(id: string, status: Exclude<ApprovalStatus, "pending">): void {
		this.db.prepare("UPDATE kernel_approvals SET status = ? WHERE id = ? AND status = 'pending'").run(status, id);
	}

	expireApprovals(sessionId?: string): number {
		const result = sessionId
			? this.db
					.prepare("UPDATE kernel_approvals SET status = 'expired' WHERE status = 'pending' AND session_id = ?")
					.run(sessionId)
			: this.db.prepare("UPDATE kernel_approvals SET status = 'expired' WHERE status = 'pending'").run();
		return Number(result.changes);
	}

	getApproval(id: string): StoredApproval | undefined {
		const row = this.db.prepare("SELECT * FROM kernel_approvals WHERE id = ?").get(id);
		return row ? approval(row) : undefined;
	}

	listApprovals(sessionId: string): StoredApproval[] {
		return this.db
			.prepare("SELECT * FROM kernel_approvals WHERE session_id = ? ORDER BY created_at")
			.all(sessionId)
			.map((row) => approval(row));
	}

	compact(): void {
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		this.db.exec("VACUUM;");
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
	}

	close(): void {
		if (this.ownsConnection) this.db.close();
	}
}
