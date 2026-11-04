import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { SessionDetail, SessionEvent } from "../../shared/src/protocol.ts";
import { KernelSessionStore } from "../src/persistence/kernel-session-store.ts";
import { projectSessionMeta } from "../src/persistence/session-projection.ts";

function detail(id: string): SessionDetail {
	return {
		id,
		workspaceId: "w",
		title: id,
		status: "idle",
		updatedAt: "2026-01-01T00:00:00.000Z",
		thinkingLevel: "medium",
		accessMode: "ask",
		messages: [],
		tools: [],
		approvals: [],
		activity: [],
		sequence: 0,
	};
}

test("imports legacy global event ids as per-session sequences", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "allweave-kernel-migrate-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "console.sqlite");
	const old = new DatabaseSync(path);
	old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, file TEXT);
		CREATE TABLE session_summaries (id TEXT PRIMARY KEY, version INTEGER NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, file TEXT);
		CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, data TEXT NOT NULL);`);
	const saved = detail("s");
	const meta = projectSessionMeta(saved, "s.jsonl");
	meta.sequence = 11;
	meta.checkpointSequence = 10;
	saved.sequence = 10;
	old.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("s", gzipSync(JSON.stringify(saved)), "s.jsonl");
	old.prepare("INSERT INTO session_summaries VALUES (?, ?, ?, ?, ?)").run(
		"s",
		meta.version,
		11,
		JSON.stringify(meta),
		"s.jsonl",
	);
	const event = (eventId: number): SessionEvent => ({
		eventId,
		sessionId: "s",
		type: "message.delta",
		messageId: "m",
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: meta.summary,
		approvals: [],
	});
	old.prepare("INSERT INTO events (session_id, data) VALUES (?, ?)").run("s", gzipSync(JSON.stringify(event(10))));
	old.prepare("INSERT INTO events (session_id, data) VALUES (?, ?)").run("s", gzipSync(JSON.stringify(event(11))));
	old.close();

	const store = new KernelSessionStore(directory);
	try {
		const imported = store.sessionMetas()[0];
		assert.equal(imported.sequence, 2, "event ids are local to the session");
		assert.equal(imported.checkpointSequence, 1, "the checkpoint maps to the imported sequence");
		assert.equal(store.loadSessionSnapshot("s")?.detail.sequence, 1);
		assert.deepEqual(
			store.loadSessionEvents("s", 1).map((entry) => entry.eventId),
			[2],
		);
		const appended = store.append({
			sessionId: "s",
			type: "message.delta",
			messageId: "m",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: meta.summary,
			approvals: [],
		});
		assert.equal(appended.eventId, 3);
	} finally {
		store.close();
	}
});
