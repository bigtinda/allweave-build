import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { AgentService } from "../src/agent.ts";
import { ConsoleStore } from "../src/store.ts";
import { createHarness, nativeGateway } from "./faux-native.ts";

test("native retries retryable provider errors and records the completed run", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-usage-observation-"));
	const root = join(directory, "project");
	await mkdir(root);
	await writeFile(join(root, "reference.txt"), "fixed fixture");
	const harness = await createHarness();
	const store = new ConsoleStore(join(directory, "data"));
	store.saveWorkspace({ id: "workspace", name: "Fixture", path: root });
	const agents = new AgentService(store, directory, {
		agentDirectory: join(directory, "agent"),
		gateway: () => nativeGateway(harness),
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
				return fauxAssistantMessage(fauxToolCall("read", { path: "reference.txt" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("fixed answer"),
		]);
		await agents.prompt(session.id, "Read the reference", ["reference.txt"]);
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const detail = agents.get(session.id);
			if (detail.status === "idle" && detail.lastRunUsage) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const detail = agents.get(session.id);
		assert.equal(attempts, 2, "the retryable provider error is retried once");
		assert.equal(detail.lastRunUsage?.outcome, "completed");
		assert.equal(detail.messages.at(-1)?.text, "fixed answer");
		assert.equal(detail.tools.find((tool) => tool.name === "read")?.status, "completed");
		assert.ok(detail.lastRunUsage?.toolResultCharacters && detail.lastRunUsage.toolResultCharacters > 0);
	} finally {
		await agents.close();
		store.close();
		harness.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});
