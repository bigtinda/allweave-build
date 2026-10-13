import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai/compat";
import { applyEvent, type SessionDetail, type SessionEvent } from "../../shared/src/protocol.ts";
import { adaptSdkEvent } from "../src/adapter.ts";

test("SDK adapter retains streamed message identity, real thinking and tool failures", () => {
	const state: SessionDetail = {
		id: "one",
		workspaceId: "workspace",
		title: "test",
		status: "running",
		updatedAt: "2026-01-01",
		accessMode: "ask",
		thinkingLevel: "off",
		messages: [],
		tools: [],
		approvals: [],
		activity: [],
		sequence: 0,
	};
	const first = fauxAssistantMessage("hello", { timestamp: 100 });
	const second = fauxAssistantMessage([fauxThinking("returned by provider"), { type: "text", text: "hello world" }], {
		timestamp: 100,
	});
	const started = adaptSdkEvent({ type: "message_start", message: first }, state)!;
	state.messages.push(started.message!);
	const completed = adaptSdkEvent({ type: "message_end", message: second }, state)!;
	assert.equal(started.message?.id, completed.message?.id);
	assert.equal(completed.message?.thinking, "returned by provider");
	assert.equal(completed.message?.complete, true);
	const event: SessionEvent = {
		...completed,
		type: completed.type,
		sessionId: state.id,
		eventId: 2,
		messageId: completed.message!.id,
		timestamp: "2026-01-01",
		summary: state,
		approvals: [],
	};
	const updated = applyEvent(state, event);
	assert.equal(updated.messages.length, 1);
	assert.equal(updated.messages[0].text, "hello world");
	assert.equal(applyEvent(updated, event), updated);
	assert.equal(applyEvent(updated, { ...event, eventId: 1 }), updated);
	assert.equal(applyEvent(updated, { ...event, sessionId: "other", eventId: 3 }), updated);
	const failed = adaptSdkEvent(
		{
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "failed" }] },
			isError: true,
			durationMs: 125,
		},
		state,
	);
	assert.equal(failed?.tool?.status, "failed");
	assert.equal(failed?.tool?.durationMs, 125);
});
