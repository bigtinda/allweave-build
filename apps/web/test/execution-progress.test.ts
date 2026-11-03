import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionDetail, ToolCall } from "../../shared/src/protocol.ts";
import { executionProgress, toolAction } from "../src/features/chat/execution-progress.ts";

const timestamp = "2026-11-02T10:00:00.000Z";
function fixture(): SessionDetail {
	return {
		id: "s",
		workspaceId: "w",
		title: "Task",
		status: "running",
		updatedAt: timestamp,
		thinkingLevel: "medium",
		accessMode: "auto",
		messages: [{ id: "u", role: "user", text: "Task", thinking: "", complete: true, timestamp }],
		tools: [],
		approvals: [],
		activity: [],
		sequence: 0,
	};
}
const tool: ToolCall = {
	id: "t",
	name: "read",
	input: { path: "src/app.ts" },
	status: "running",
	startedAt: timestamp,
};

test("progress follows actual tool and message events without mixing earlier turns", () => {
	const session = fixture();
	session.tools = [{ ...tool, id: "old", startedAt: "2026-11-02T09:00:00.000Z" }, tool];
	assert.equal(executionProgress(session, Date.parse(timestamp)).label, "读取文件 · src/app.ts");
	assert.equal(executionProgress(session, Date.parse(timestamp)).tools.length, 1);
	session.tools[1] = { ...tool, status: "completed" };
	assert.equal(executionProgress(session, Date.parse(timestamp)).completed, 1);
	assert.match(executionProgress(session, Date.parse(timestamp)).label, /分析工具结果/u);
	session.messages.push({ id: "a", role: "assistant", text: "Result", thinking: "", complete: false, timestamp });
	assert.equal(executionProgress(session, Date.parse(timestamp)).label, "正在生成回复");
});

test("silence, approval, failure and completion remain distinct", () => {
	const session = fixture();
	assert.equal(executionProgress(session, Date.parse(timestamp) + 95_000).silentSeconds, 95);
	session.status = "approval";
	assert.match(executionProgress(session, Date.parse(timestamp)).label, /等待你确认/u);
	session.status = "error";
	assert.equal(executionProgress(session, Date.parse(timestamp)).active, false);
	assert.equal(executionProgress(session, Date.parse(timestamp)).label, "执行已停止");
	session.status = "idle";
	assert.equal(executionProgress(session, Date.parse(timestamp)).label, "本轮执行结束");
	assert.equal(toolAction({ ...tool, input: null }), "读取文件");
});
