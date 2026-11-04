import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateText } from "../src/context/budget.ts";
import { buildContext } from "../src/context/builder.ts";
import { compactMessages } from "../src/context/compaction.ts";
import type { NativeMessage, NativeTool } from "../src/engine/types.ts";
import { LocalWorkspace } from "../src/workspace/local.ts";

const read: NativeTool = {
	name: "read",
	description: "",
	parameters: {},
	readOnly: true,
	async execute() {
		return { content: "" };
	},
};

test("estimates CJK and latin text without dependencies", () => {
	assert.ok(estimateText("中文内容") > estimateText("hello"));
	assert.equal(estimateText(""), 0);
});

test("builds a stable prefix from AGENTS.md", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-context-"));
	writeFileSync(join(directory, "AGENTS.md"), "use tabs");
	try {
		const workspace = new LocalWorkspace(directory);
		const first = await buildContext({ cwd: directory, workspace, messages: [], tools: [read] });
		const second = await buildContext({ cwd: directory, workspace, messages: [], tools: [read] });
		assert.equal(first.system, second.system);
		assert.match(first.system, /use tabs/u);
		assert.match(first.system, /可用工具: read/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("compacts old turns and keeps recent messages", async () => {
	const messages: NativeMessage[] = Array.from({ length: 6 }, (_, index) => ({
		role: "user" as const,
		text: `message ${index} ${"x".repeat(400)}`,
		timestamp: index,
	}));
	const result = await compactMessages(messages, { keepRecentTokens: 200, summarize: async () => "short summary" });
	assert.equal(result.compacted, true);
	assert.match(result.messages[0]?.text ?? "", /short summary/u);
	assert.ok(result.messages.length < messages.length + 1);
});

test("budget compacts before the model request", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-context-"));
	try {
		const workspace = new LocalWorkspace(directory);
		const messages: NativeMessage[] = Array.from({ length: 10 }, (_, index) => ({
			role: "user" as const,
			text: `message ${index} ${"x".repeat(500)}`,
			timestamp: index,
		}));
		let summarized = false;
		const result = await buildContext({
			cwd: directory,
			workspace,
			messages,
			tools: [read],
			maxTokens: 2000,
			keepRecentTokens: 300,
			summarize: async () => {
				summarized = true;
				return "summary";
			},
		});
		assert.equal(result.compacted, 1);
		assert.equal(summarized, true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("estimate scale applies to the whole context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kernel-context-"));
	try {
		const workspace = new LocalWorkspace(directory);
		const messages: NativeMessage[] = [{ role: "user", text: "x".repeat(400), timestamp: 0 }];
		const cold = await buildContext({ cwd: directory, workspace, messages, tools: [read] });
		const calibrated = await buildContext({
			cwd: directory,
			workspace,
			messages,
			tools: [read],
			estimateScale: 1.5,
		});
		assert.ok(calibrated.estimatedTokens > cold.estimatedTokens);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
