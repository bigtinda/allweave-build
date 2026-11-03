import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, type SessionDetail, type SessionEvent } from "../src/index.ts";

function detail(): SessionDetail {
	return {
		id: "session-1",
		workspaceId: "workspace-1",
		title: "Test",
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

function event(overrides: Partial<SessionEvent>): SessionEvent {
	return {
		type: "session.updated",
		sessionId: "session-1",
		eventId: 1,
		messageId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		summary: {
			id: "session-1",
			workspaceId: "workspace-1",
			title: "Test",
			status: "running",
			updatedAt: "2026-01-01T00:00:01.000Z",
			thinkingLevel: "medium",
			accessMode: "ask",
		},
		approvals: [],
		...overrides,
	};
}

test("applyEvent is a no-op for stale or foreign events", () => {
	const session = { ...detail(), sequence: 2 };
	assert.equal(applyEvent(session, event({ eventId: 2 })), session);
	assert.equal(applyEvent(session, event({ sessionId: "other" })), session);
});

test("applyEvent materializes summary, messages, tools, and activity", () => {
	const message = {
		id: "message-1",
		role: "assistant" as const,
		text: "hello",
		thinking: "",
		complete: true,
		timestamp: "2026-01-01T00:00:01.000Z",
	};
	const tool = {
		id: "tool-1",
		name: "read",
		input: { path: "a.txt" },
		status: "completed" as const,
		startedAt: "2026-01-01T00:00:01.000Z",
	};
	const next = applyEvent(detail(), event({ message, tool, approvals: [] }));
	assert.equal(next.sequence, 1);
	assert.equal(next.status, "running");
	assert.deepEqual(next.messages, [message]);
	assert.deepEqual(next.tools, [tool]);
	assert.equal(next.activity.length, 1);
	assert.equal(next.activity[0]?.description, "read");
});

test("applyEvent treats conversation as an authoritative replacement", () => {
	const current = {
		...detail(),
		messages: [
			{
				id: "old",
				role: "user" as const,
				text: "old",
				thinking: "",
				complete: true,
				timestamp: "2025-01-01T00:00:00.000Z",
			},
		],
		sequence: 1,
	};
	const next = applyEvent(current, event({ eventId: 2, conversation: { messages: [], tools: [] } }));
	assert.deepEqual(next.messages, []);
	assert.deepEqual(next.tools, []);
});

test("applyEvent keeps recoveryRequired until explicitly cleared", () => {
	const current = { ...detail(), recoveryRequired: true };
	const next = applyEvent(current, event({ eventId: 1 }));
	assert.equal(next.recoveryRequired, true);
});
