import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CURRENT_SESSION_VERSION = 3;

import type { SessionDetail, SessionEvent } from "../../shared/src/protocol.ts";
import { mergeTranscript, projectSessionMeta, type SessionMeta } from "../src/persistence/session-projection.ts";
import { EventProjector, type SessionStore } from "../src/sessions/event-projector.ts";
import type { SavedSession } from "../src/store.ts";

function detail(id: string, overrides: Partial<SessionDetail> = {}): SessionDetail {
	return {
		id,
		workspaceId: "workspace",
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
		...overrides,
	};
}

class CountingStore implements SessionStore {
	metas: SessionMeta[];
	snapshots = new Map<string, SavedSession>();
	snapshotReads = 0;
	metaWrites = 0;
	sessionWrites = 0;
	eventId = 0;

	constructor(metas: SessionMeta[], snapshots: SavedSession[] = []) {
		this.metas = metas;
		for (const snapshot of snapshots) this.snapshots.set(snapshot.detail.id, snapshot);
	}
	sessionMetas(): SessionMeta[] {
		return this.metas;
	}
	loadSessionSnapshot(id: string): SavedSession | undefined {
		this.snapshotReads += 1;
		return this.snapshots.get(id);
	}
	saveSessionMeta(meta: SessionMeta): void {
		this.metaWrites += 1;
		this.metas = [...this.metas.filter((item) => item.summary.id !== meta.summary.id), meta];
	}
	saveSession(session: SessionDetail, file?: string): void {
		this.sessionWrites += 1;
		this.snapshots.set(session.id, { detail: session, file });
	}
	deleteSession(id: string): void {
		this.snapshots.delete(id);
		this.metas = this.metas.filter((meta) => meta.summary.id !== id);
	}
	append(event: Omit<SessionEvent, "eventId">): SessionEvent {
		this.eventId += 1;
		return { ...event, eventId: this.eventId };
	}
	withTransaction<T>(operation: () => T): T {
		return operation();
	}
}

test("boot reads summaries and opens a session body only on demand", () => {
	const running = detail("a", {
		status: "running",
		messages: [
			{
				id: "m1",
				role: "assistant",
				text: "partial",
				thinking: "",
				complete: false,
				timestamp: "2026-01-01T00:00:01.000Z",
			},
		],
		tools: [
			{
				id: "t1",
				name: "write",
				input: {},
				status: "running",
				startedAt: "2026-01-01T00:00:02.000Z",
			},
		],
	});
	const metaA = projectSessionMeta(running);
	const metaB = projectSessionMeta(detail("b"));
	const store = new CountingStore([metaA, metaB], [{ detail: running }]);
	const projector = new EventProjector(store);

	assert.equal(store.snapshotReads, 0, "boot must not read the full snapshots");
	assert.deepEqual(
		projector
			.list()
			.map((session) => session.id)
			.sort(),
		["a", "b"],
	);
	assert.equal(store.snapshotReads, 0, "listing must not read the full snapshots");
	assert.equal(projector.list().find((session) => session.id === "a")?.status, "interrupted");

	const first = projector.get("a");
	assert.equal(store.snapshotReads, 1, "opening a session reads its body once");
	assert.equal(first.status, "interrupted");
	assert.equal(first.messages[0].complete, true);
	assert.equal(first.tools[0].status, "failed", "an unfinished tool is marked failed");
	assert.equal(first.tools[0].output, "Server restarted before execution completed");
	assert.equal(projector.get("a"), first, "the hydrated body is cached");
	assert.equal(store.snapshotReads, 1);

	projector.project("a", { type: "session.updated" }, (draft) => {
		draft.title = "renamed";
	});
	assert.equal(projector.get("a").title, "renamed");
	assert.ok(store.metaWrites > 0, "the lightweight record follows every change");
	assert.ok(store.sessionWrites > 0, "the fallback snapshot is still maintained");
});

test("legacy sparse metadata is upgraded lazily from the retained snapshot", () => {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const saved = detail("legacy", {
		messages: ["first", "second"].map((id) => ({
			id,
			role: "assistant" as const,
			text: id,
			thinking: "",
			complete: true,
			timestamp,
			...(id === "second" ? { changedFiles: ["a.txt"] } : {}),
		})),
	});
	const meta = projectSessionMeta(saved);
	meta.version = 1;
	meta.messages = meta.messages.slice(1);
	const store = new CountingStore([meta], [{ detail: saved }]);
	const projector = new EventProjector(store);
	assert.equal(store.snapshotReads, 0);
	assert.deepEqual(
		projector.get("legacy").messages.map((message) => message.id),
		["first", "second"],
	);
	assert.equal(store.metas[0].version, 3);
	assert.deepEqual(
		store.metas[0].messages.map((message) => message.id),
		["first", "second"],
	);
});

test("ambiguous legacy metadata without a snapshot is not attached to the wrong message", () => {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const messages = ["first", "second"].map((id) => ({
		id,
		role: "assistant" as const,
		text: id,
		thinking: "",
		complete: true,
		timestamp,
	}));
	const meta = projectSessionMeta(detail("legacy", { messages }));
	meta.version = 1;
	meta.messages = [{ ...meta.messages[1], changedFiles: ["a.txt"] }];
	const before = structuredClone(meta);
	assert.throws(() => mergeTranscript(meta, { messages, tools: [] }), /旧会话元数据/);
	assert.deepEqual(meta, before, "the only remaining UI metadata must survive a failed recovery");
	const restored = mergeTranscript(meta, { messages, tools: [] }, [messages[1]]);
	assert.deepEqual(
		restored.messages[1].changedFiles,
		["a.txt"],
		"old snapshots or retained message events disambiguate by original id and content",
	);
	assert.equal(restored.messages[0].changedFiles, undefined);
});

test("missing history never turns remaining UI metadata into an empty writable session", () => {
	const meta = projectSessionMeta(detail("missing"));
	meta.messages = [
		{ id: "user", role: "user", timestamp: "2026-01-01", input: { text: "original", references: ["a.txt"] } },
	];
	const store = new CountingStore([meta]);
	const projector = new EventProjector(store);
	assert.throws(() => projector.get("missing"), /原元数据未被覆盖/);
	assert.equal(store.metaWrites, 0);
	assert.equal(store.sessionWrites, 0);
});

test("a transcript rebuilds the conversation and merges the UI-only fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-transcript-"));
	try {
		const transcript = join(directory, "session.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "transcript-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: directory,
		};
		const entries = [
			header,
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "hello", timestamp: Date.parse("2026-01-01T00:00:00.000Z") },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "hi" },
						{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
					],
					api: "faux",
					provider: "faux",
					model: "faux",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					stopReason: "toolUse",
					timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "read",
					content: [{ type: "text", text: "file content" }],
					details: {},
					isError: false,
					timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
					durationMs: 12,
				},
			},
		];
		await writeFile(transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const meta = projectSessionMeta(detail("transcript-session"), transcript);
		meta.sequence = 7;
		meta.tokens = { input: 3, output: 4, total: 7 };
		meta.activity = [{ id: 7, type: "agent.status", timestamp: "2026-01-01T00:00:03.000Z", description: "idle" }];
		meta.messages = [
			{
				role: "user",
				timestamp: "2026-01-01T00:00:00.000Z",
				id: "live-user",
				input: { text: "hello", references: ["a.txt"] },
			},
			{
				role: "assistant",
				timestamp: "2026-01-01T00:00:01.000Z",
				id: "live-assistant",
				changedFiles: ["a.txt"],
			},
		];
		meta.tools = [{ id: "t1", startedAt: "2026-01-01T00:00:01.500Z" }];
		const store = new CountingStore([meta]);
		store.loadSessionSnapshot = () => {
			throw new Error("the transcript must be preferred over the retained snapshot");
		};
		const projector = new EventProjector(store);
		const restored = projector.get("transcript-session");

		assert.deepEqual(
			restored.messages.map((message) => message.text),
			["hello", "hi"],
		);
		const user = restored.messages.find((message) => message.role === "user");
		assert.equal(user?.id, "live-user", "the live message id survives the restart");
		assert.deepEqual(user?.input, { text: "hello", references: ["a.txt"] });
		const assistant = restored.messages.find((message) => message.role === "assistant");
		assert.equal(assistant?.id, "live-assistant");
		assert.deepEqual(assistant?.changedFiles, ["a.txt"]);
		assert.equal(restored.tools.length, 1);
		assert.equal(restored.tools[0].status, "completed");
		assert.equal(restored.tools[0].startedAt, "2026-01-01T00:00:01.500Z");
		assert.equal(restored.tools[0].durationMs, 12);
		assert.deepEqual(restored.tools[0].output, {
			content: [{ type: "text", text: "file content" }],
			details: {},
		});
		assert.equal(restored.sequence, 7);
		assert.deepEqual(restored.tokens, { input: 3, output: 4, total: 7 });
		assert.equal(restored.activity.length, 1);

		// A failed projection is marked, survives a restart and is cleared by a
		// recovery that rebuilds the same view from the transcript.
		projector.markFailed("transcript-session", "database is gone");
		assert.equal(projector.get("transcript-session").recoveryRequired, true);
		const restarted = new EventProjector(store);
		assert.equal(restarted.failures().get("transcript-session"), "database is gone");
		assert.equal(restarted.get("transcript-session").recoveryRequired, true);
		store.eventId = 7;
		const recovered = restarted.recover("transcript-session");
		assert.equal(recovered.event.type, "session.recovered");
		assert.equal(recovered.event.recoveryRequired, false);
		assert.equal(recovered.detail.recoveryRequired, false);
		assert.deepEqual(
			recovered.detail.messages.map((message) => message.text),
			["hello", "hi"],
		);
		assert.equal(recovered.detail.sequence, recovered.event.eventId);
		assert.equal(restarted.failures().size, 0, "the marker is cleared");
		const recoveredMeta = store.metas.find((item) => item.summary.id === "transcript-session");
		assert.equal(recoveredMeta?.failure, undefined);
		assert.equal(recoveredMeta?.sequence, recovered.event.eventId);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
