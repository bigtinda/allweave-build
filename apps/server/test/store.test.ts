import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { SessionDetail, SessionEvent } from "../../shared/src/protocol.ts";
import { ConsoleStore } from "../src/store.ts";

function session(): SessionDetail {
	return {
		id: "session",
		workspaceId: "workspace",
		title: "Long conversation",
		status: "idle",
		updatedAt: new Date().toISOString(),
		thinkingLevel: "medium",
		accessMode: "ask",
		messages: Array.from({ length: 100 }, (_, index) => ({
			id: String(index),
			role: "assistant",
			text: "A detailed explanation of the implementation. ".repeat(100),
			thinking: "Reasoning about the task. ".repeat(100),
			complete: true,
			timestamp: new Date().toISOString(),
		})),
		tools: [],
		approvals: [],
		activity: [],
		sequence: 0,
	};
}

test("compressed snapshots round trip and deferred writes coalesce without losing final state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	let store = new ConsoleStore(directory);
	try {
		const detail = session();
		store.saveSession(detail, "transcript.jsonl");
		const data = store.db.prepare("SELECT data FROM sessions").get()?.data;
		assert.ok(data instanceof Uint8Array);
		assert.ok(data.byteLength < Buffer.byteLength(JSON.stringify(detail)) / 10);
		assert.deepEqual(store.sessions(), [{ detail, file: "transcript.jsonl" }]);
		assert.equal(store.sessionFiles().get(detail.id), "transcript.jsonl");
		for (let index = 1; index <= 100; index++) {
			store.saveSession({ ...detail, sequence: index }, "transcript.jsonl", true);
		}
		assert.equal(JSON.parse(gunzipSync(data).toString()).sequence, 0);
		const unchanged = store.db.prepare("SELECT data FROM sessions").get()?.data;
		assert.deepEqual(unchanged, data, "streaming updates must not rewrite the full transcript on every token");
		store.close();
		store = new ConsoleStore(directory);
		assert.equal(store.sessions()[0].detail.sequence, 100);
		store.saveSession({ ...detail, sequence: 101 }, undefined, true);
		store.saveSession({ ...detail, sequence: 102 });
		assert.equal(store.sessions()[0].detail.sequence, 102, "final writes supersede pending snapshots");
		store.saveSession(detail, undefined, true);
		store.deleteSession(detail.id);
		assert.deepEqual(store.sessions(), [], "flushing must not resurrect a deleted session");
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("compaction migrates existing JSON and events stay bounded and recoverable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	const store = new ConsoleStore(directory);
	try {
		const detail = session();
		store.db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(detail.id, JSON.stringify(detail), "old.jsonl");
		assert.deepEqual(store.sessions(), [{ detail, file: "old.jsonl" }]);
		store.db
			.prepare("INSERT INTO events (session_id, data) VALUES (?, ?)")
			.run(detail.id, JSON.stringify({ old: true }));
		store.compact();
		assert.deepEqual(store.sessions(), [{ detail, file: "old.jsonl" }]);
		assert.equal(
			store.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE typeof(data) = 'text'").get()?.count,
			0,
		);
		const oldEvent = store.db.prepare("SELECT data FROM events").get()?.data;
		assert.ok(oldEvent instanceof Uint8Array);
		assert.deepEqual(JSON.parse(gunzipSync(oldEvent).toString()), { old: true });
		let latest: SessionEvent | undefined;
		for (let index = 0; index < 1005; index++) {
			latest = store.append({
				type: "message.delta",
				sessionId: detail.id,
				messageId: detail.messages[0].id,
				timestamp: detail.updatedAt,
				summary: {
					id: detail.id,
					workspaceId: detail.workspaceId,
					title: detail.title,
					status: detail.status,
					updatedAt: detail.updatedAt,
					thinkingLevel: detail.thinkingLevel,
					accessMode: detail.accessMode,
				},
				approvals: [],
				message: detail.messages[0],
			});
		}
		assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1001);
		const row = store.db.prepare("SELECT data FROM events ORDER BY id DESC LIMIT 1").get()?.data;
		assert.ok(row instanceof Uint8Array);
		assert.deepEqual(JSON.parse(gunzipSync(row).toString()), latest);
		store.compact();
		assert.deepEqual(store.sessions()[0].detail, detail);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
