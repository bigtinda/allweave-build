import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type AgentSession, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import { AgentService } from "../src/agent.ts";
import { usageDelta } from "../src/sessions/run-usage.ts";
import { ConsoleStore } from "../src/store.ts";

test(
	"a retried prompt includes compaction usage and tool sizes without changing its result",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-usage-observation-"));
		const root = join(directory, "project");
		await mkdir(root);
		await writeFile(join(root, "reference.txt"), "fixed fixture");
		const harness = await createHarness();
		const store = new ConsoleStore(join(directory, "data"));
		store.saveWorkspace({ id: "workspace", name: "Fixture", path: root });
		let sdk: AgentSession | undefined;
		const agents = new AgentService(store, directory, {
			agentDirectory: join(directory, "agent"),
			createSession: async (options) => {
				options!.settingsManager!.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
				const result = await createAgentSession({
					...options,
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
				});
				sdk = result.session;
				return result;
			},
		});
		try {
			const session = await agents.create("workspace", "usage");
			await agents.setAccessMode(session.id, "full");
			let attempts = 0;
			harness.setResponses([
				() => {
					attempts++;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
				},
				() => {
					attempts++;
					sdk!.sessionManager.appendCompaction("fixture summary", null, 500, undefined, true, {
						input: 11,
						output: 3,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 17,
						cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
					});
					return fauxAssistantMessage(fauxToolCall("read", { path: "reference.txt" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("fixed answer"),
			]);
			await agents.prompt(session.id, "Read the reference", ["reference.txt"]);
			const deadline = Date.now() + 15000;
			while (!agents.get(session.id).lastRunUsage && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			const detail = agents.get(session.id);
			assert.equal(attempts, 2);
			assert.equal(detail.lastRunUsage?.outcome, "completed");
			assert.equal(detail.messages.at(-1)?.text, "fixed answer");
			assert.equal(detail.lastRunUsage?.compactions, 1);
			assert.equal(detail.lastRunUsage?.tokens?.cost, 4);
			const stats = sdk!.getSessionStats();
			assert.deepEqual(
				detail.lastRunUsage?.tokens,
				usageDelta(
					{ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					{ ...stats.tokens, cost: stats.cost },
				),
			);
			assert.ok(detail.lastRunUsage!.toolResultCharacters > 0);
			assert.deepEqual(
				detail.lastRunUsage!.toolResults.map((tool) => tool.name),
				["read"],
			);
			assert.ok(!JSON.stringify(detail.lastRunUsage).includes("fixed fixture"));
			assert.ok(detail.messages.some((message) => message.input?.references.includes("reference.txt")));
		} finally {
			await agents.close();
			store.close();
			harness.cleanup();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
