import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Workspace } from "../../shared/src/protocol.ts";

/**
 * Application-level storage for workspaces and the shared SQLite handle.
 * Session bodies, events, snapshots and approvals live in the kernel store;
 * the legacy session tables are dropped after their one-time import.
 */
export class ConsoleStore {
	db: DatabaseSync;
	private transactionDepth = 0;

	constructor(directory: string) {
		mkdirSync(directory, { recursive: true });
		this.db = new DatabaseSync(join(directory, "console.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_workspaces (path TEXT PRIMARY KEY);`);
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

	close(): void {
		try {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		} catch {
			// A second connection may still be closing; the handle is released below.
		}
		this.db.close();
	}
}
