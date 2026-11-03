import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteEventStore } from "../src/index.ts";

function store(t: { after: (fn: () => void) => void }): SqliteEventStore {
	const directory = mkdtempSync(join(tmpdir(), "pi-console-kernel-store-"));
	let opened: SqliteEventStore | undefined;
	t.after(() => {
		opened?.close();
		rmSync(directory, { recursive: true, force: true });
	});
	opened = new SqliteEventStore(join(directory, "console.sqlite"));
	return opened;
}

function create(value: SqliteEventStore, id = "s1"): void {
	value.createSession({ id, data: JSON.stringify({ id }), seq: 0, updatedAt: "2026-01-01T00:00:00.000Z" });
}

test("appends ordered events and resumes after a sequence", (t) => {
	const value = store(t);
	create(value);
	for (let seq = 1; seq <= 3; seq++) {
		value.appendEvent({
			sessionId: "s1",
			seq,
			type: "message.delta",
			data: `event-${seq}`,
			createdAt: `2026-01-01T00:00:0${seq}.000Z`,
		});
	}
	assert.equal(value.latestSeq("s1"), 3);
	assert.deepEqual(
		value.eventsAfter("s1").map((entry) => entry.seq),
		[1, 2, 3],
	);
	assert.deepEqual(
		value.eventsAfter("s1", 1).map((entry) => entry.seq),
		[2, 3],
	);
	assert.equal(value.getSession("s1")?.seq, 3);
});

test("rejects gaps and unknown sessions without advancing state", (t) => {
	const value = store(t);
	create(value);
	assert.throws(
		() =>
			value.appendEvent({
				sessionId: "s1",
				seq: 2,
				type: "message.delta",
				data: "gap",
				createdAt: "2026-01-01T00:00:01.000Z",
			}),
		/does not follow 0/u,
	);
	assert.throws(
		() =>
			value.appendEvent({
				sessionId: "missing",
				seq: 1,
				type: "message.delta",
				data: "missing",
				createdAt: "2026-01-01T00:00:01.000Z",
			}),
		/does not exist/u,
	);
	assert.equal(value.latestSeq("s1"), 0);
	assert.deepEqual(value.eventsAfter("s1"), []);
});

test("stores snapshots independently of the event log", (t) => {
	const value = store(t);
	create(value);
	value.appendEvent({
		sessionId: "s1",
		seq: 1,
		type: "session.started",
		data: "one",
		createdAt: "2026-01-01T00:00:01.000Z",
	});
	value.saveSnapshot({ sessionId: "s1", seq: 1, data: '{"messages":[]}', createdAt: "2026-01-01T00:00:02.000Z" });
	assert.deepEqual(value.getSnapshot("s1"), {
		sessionId: "s1",
		seq: 1,
		data: '{"messages":[]}',
		createdAt: "2026-01-01T00:00:02.000Z",
	});
	value.saveSnapshot({ sessionId: "s1", seq: 1, data: '{"messages":[1]}', createdAt: "2026-01-01T00:00:03.000Z" });
	assert.equal(value.getSnapshot("s1")?.data, '{"messages":[1]}');
});

test("expires pending approvals on restart and settles only pending rows", (t) => {
	const value = store(t);
	create(value);
	for (const id of ["a1", "a2"]) {
		value.createApproval({
			id,
			sessionId: "s1",
			toolCallId: `tool-${id}`,
			data: "{}",
			status: "pending",
			expiresAt: "2026-01-01T00:05:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
	}
	assert.equal(value.expireApprovals(), 2);
	assert.equal(value.getApproval("a1")?.status, "expired");
	value.settleApproval("a2", "approved");
	assert.equal(value.getApproval("a2")?.status, "expired");
});

test("deletes a session with its events, snapshots, and approvals", (t) => {
	const value = store(t);
	create(value);
	value.appendEvent({
		sessionId: "s1",
		seq: 1,
		type: "session.started",
		data: "one",
		createdAt: "2026-01-01T00:00:01.000Z",
	});
	value.saveSnapshot({ sessionId: "s1", seq: 1, data: "{}", createdAt: "2026-01-01T00:00:02.000Z" });
	value.createApproval({
		id: "a1",
		sessionId: "s1",
		toolCallId: "tool-a1",
		data: "{}",
		status: "pending",
		expiresAt: "2026-01-01T00:05:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	value.deleteSession("s1");
	assert.equal(value.getSession("s1"), undefined);
	assert.deepEqual(value.eventsAfter("s1"), []);
	assert.equal(value.getSnapshot("s1"), undefined);
	assert.deepEqual(value.listApprovals("s1"), []);
});
