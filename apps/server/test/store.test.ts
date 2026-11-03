import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { applyEvent, type SessionDetail, type SessionEvent } from "../../shared/src/protocol.ts";
import { projectSessionMeta } from "../src/persistence/session-projection.ts";
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

test("plugin development sessions move to the current workspace without reading their bodies", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	const store = new ConsoleStore(directory);
	try {
		const plugin = session();
		plugin.id = "plugin-session";
		plugin.purpose = "plugin-development";
		plugin.workspaceId = "old-plugin-workspace";
		store.saveSession(plugin, "plugin.jsonl");
		store.saveSessionMeta(projectSessionMeta(plugin, "plugin.jsonl"));
		const other = session();
		other.id = "other-session";
		store.saveSession(other, "other.jsonl");
		store.saveSessionMeta(projectSessionMeta(other, "other.jsonl"));
		// A corrupt retained snapshot proves the reassignment only reads summaries.
		store.db.prepare("UPDATE sessions SET data = ? WHERE id = ?").run("not gzip", plugin.id);
		store.reassignPluginDevelopmentSessions("current-plugin-workspace");
		const metas = store.sessionMetas();
		assert.equal(
			metas.find((meta) => meta.summary.id === plugin.id)?.summary.workspaceId,
			"current-plugin-workspace",
		);
		assert.equal(metas.find((meta) => meta.summary.id === other.id)?.summary.workspaceId, "workspace");
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

function appendUpdated(store: ConsoleStore, detail: SessionDetail): SessionEvent {
	return store.append({
		type: "session.updated",
		sessionId: detail.id,
		messageId: null,
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
	});
}

test("legacy snapshots migrate into lightweight records that stay smaller", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	const store = new ConsoleStore(directory);
	try {
		const details = Array.from({ length: 10 }, (_, index) => {
			const detail = session();
			detail.id = `session-${index}`;
			detail.title = `Conversation ${index}`;
			for (const [position, message] of detail.messages.entries()) {
				message.text = `Message ${position} of session ${index}. ${message.text}`;
			}
			store.db
				.prepare("INSERT INTO sessions VALUES (?, ?, ?)")
				.run(detail.id, JSON.stringify(detail), `${detail.id}.jsonl`);
			return detail;
		});
		const metas = store.sessionMetas();
		assert.equal(metas.length, details.length, "every legacy row gets a lightweight record");
		assert.ok(
			metas.some((meta) => meta.summary.title === "Conversation 3"),
			"the summary keeps the list fields",
		);
		assert.ok(
			metas.every((meta) => !JSON.stringify(meta).includes("Reasoning about the task")),
			"the lightweight record does not duplicate the conversation bodies",
		);
		const snapshotBytes = Number(
			store.db.prepare("SELECT SUM(length(data)) AS bytes FROM sessions").get()?.bytes ?? 0,
		);
		const metaBytes = Number(
			store.db.prepare("SELECT SUM(length(data)) AS bytes FROM session_summaries").get()?.bytes ?? 0,
		);
		assert.ok(metaBytes > 0);
		assert.ok(
			metaBytes < snapshotBytes / 10,
			`the lightweight records must stay below a tenth of the snapshots (${metaBytes} vs ${snapshotBytes})`,
		);
		assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, details.length);
		assert.deepEqual(
			store.sessions().find((record) => record.detail.id === details[0].id)?.detail,
			details[0],
			"the legacy snapshot stays readable",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("stale summaries written before a downgrade are refreshed from the newer snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	try {
		let store = new ConsoleStore(directory);
		const snapshotNewer = session();
		snapshotNewer.id = "snapshot-newer";
		store.saveSession(snapshotNewer, "snapshot-newer.jsonl");
		store.saveSessionMeta(projectSessionMeta(snapshotNewer, "snapshot-newer.jsonl"));
		const eventOnly = session();
		eventOnly.id = "event-only";
		store.saveSession(eventOnly, "event-only.jsonl");
		store.saveSessionMeta(projectSessionMeta(eventOnly, "event-only.jsonl"));

		// An older build appends events but knows nothing about session_summaries.
		// For one session it also rewrites its full snapshot; for the other it
		// crashed before doing so.
		const renamed = appendUpdated(store, snapshotNewer);
		const saved = { ...snapshotNewer, title: "Renamed by the old build", sequence: renamed.eventId };
		store.saveSession(saved, "snapshot-newer.jsonl");
		const appendedOnly = appendUpdated(store, eventOnly);
		store.close();

		store = new ConsoleStore(directory);
		let metas = store.sessionMetas();
		const refreshed = metas.find((meta) => meta.summary.id === snapshotNewer.id);
		assert.equal(refreshed?.summary.title, "Renamed by the old build", "the newer snapshot wins");
		assert.equal(refreshed?.sequence, renamed.eventId, "the summary adopts the event sequence");
		const preserved = metas.find((meta) => meta.summary.id === eventOnly.id);
		assert.equal(preserved?.summary.title, "Long conversation", "a summary newer than the snapshot is kept");
		assert.equal(preserved?.sequence, appendedOnly.eventId, "the event sequence still settles");
		store.close();

		// The migration ran once: a corrupt snapshot is never read again.
		store = new ConsoleStore(directory);
		store.db.prepare("UPDATE sessions SET data = ?").run("not gzip");
		metas = store.sessionMetas();
		assert.equal(
			metas.find((meta) => meta.summary.id === snapshotNewer.id)?.summary.title,
			"Renamed by the old build",
		);
		assert.equal(metas.find((meta) => meta.summary.id === eventOnly.id)?.summary.title, "Long conversation");
		store.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("databases written before the sequence column become readable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	const detail = session();
	const meta: Record<string, unknown> = { ...projectSessionMeta(detail, "old.jsonl") };
	delete meta.sequence;
	const db = new DatabaseSync(join(directory, "console.sqlite"));
	db.exec(
		"CREATE TABLE session_summaries (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, file TEXT)",
	);
	db.prepare("INSERT INTO session_summaries VALUES (?, ?, ?, ?)").run(detail.id, 1, JSON.stringify(meta), "old.jsonl");
	db.close();
	const store = new ConsoleStore(directory);
	try {
		const columns = Array.from(store.db.prepare("PRAGMA table_info(session_summaries)").iterate(), (row) =>
			String(row.name),
		);
		assert.ok(columns.includes("sequence"), "the additive migration adds the missing column");
		assert.equal(store.sessionMetas()[0].sequence, 0, "an old row defaults to sequence zero");
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

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

test("event rows and session projections commit and roll back as one transaction", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-store-"));
	const store = new ConsoleStore(directory);
	try {
		const detail = session();
		store.saveSession(detail, "transcript.jsonl");
		const before = store.sessions()[0].detail;
		const countEvents = () => Number(store.db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count);
		const eventsBefore = countEvents();
		const appendEvent = () =>
			store.append({
				type: "session.updated",
				sessionId: detail.id,
				messageId: null,
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
				tokens: detail.tokens,
				error: detail.error,
			});

		// Fault injection: the event insert fails after the projection was prepared.
		store.db.exec(
			"CREATE TRIGGER fail_event_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
		);
		assert.throws(
			() =>
				store.withTransaction(() => {
					const event = appendEvent();
					store.saveSession(applyEvent(before, event), "transcript.jsonl");
				}),
			/injected event failure/,
		);
		assert.equal(countEvents(), eventsBefore, "a failed event insert must not leave a row behind");
		assert.deepEqual(store.sessions()[0].detail, before, "the session snapshot must keep its previous value");
		store.db.exec("DROP TRIGGER fail_event_insert");

		// Fault injection: the projection write fails after the event row was prepared.
		store.db.exec(
			"CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected session failure'); END",
		);
		assert.throws(
			() =>
				store.withTransaction(() => {
					const event = appendEvent();
					store.saveSession(applyEvent(before, event), "transcript.jsonl");
				}),
			/injected session failure/,
		);
		assert.equal(countEvents(), eventsBefore, "the prepared event row must roll back with the failed projection");
		assert.deepEqual(store.sessions()[0].detail, before, "the session snapshot must keep its previous value");
		store.db.exec("DROP TRIGGER fail_session_insert");

		// Success path: nested boundaries join the outer transaction and agree on eventId and sequence.
		const { event, updated } = store.withTransaction(() => {
			const event = appendEvent();
			const updated = applyEvent(before, event);
			store.withTransaction(() => store.saveSession(updated, "transcript.jsonl"));
			return { event, updated };
		});
		const persisted = store.sessions()[0].detail;
		assert.equal(persisted.sequence, event.eventId);
		assert.deepEqual(persisted, JSON.parse(JSON.stringify(updated)));
		const row = store.db.prepare("SELECT data FROM events WHERE id = ?").get(event.eventId)?.data;
		assert.ok(row instanceof Uint8Array);
		assert.equal(JSON.parse(gunzipSync(row).toString()).eventId, event.eventId);
		assert.equal(countEvents(), eventsBefore + 1);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
