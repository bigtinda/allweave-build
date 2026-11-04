import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@allweave/model/compat";
import { AgentService } from "../src/agent.ts";
import { KernelSessionStore } from "../src/persistence/kernel-session-store.ts";
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
	const sessions = new KernelSessionStore(join(directory, "data"), store.db);
	const agents = new AgentService(store, directory, {
		agentDirectory: join(directory, "agent"),
		gateway: () => nativeGateway(harness),
		sessionStore: sessions,
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

test("native records prompt cache usage from the provider", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-cache-observation-"));
	const root = join(directory, "project");
	await mkdir(root);
	const harness = await createHarness();
	const store = new ConsoleStore(join(directory, "data"));
	store.saveWorkspace({ id: "workspace", name: "Fixture", path: root });
	const sessions = new KernelSessionStore(join(directory, "data"), store.db);
	const agents = new AgentService(store, directory, {
		agentDirectory: join(directory, "agent"),
		gateway: () => nativeGateway(harness),
		sessionStore: sessions,
	});
	try {
		const session = await agents.create("workspace", "cache");
		const response = fauxAssistantMessage("cache measured");
		response.usage = {
			input: 100,
			output: 10,
			cacheRead: 80,
			cacheWrite: 20,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		harness.setResponses([response]);
		await agents.prompt(session.id, "measure the cache", []);
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const detail = agents.get(session.id);
			if (detail.status === "idle" && detail.lastRunUsage) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const detail = agents.get(session.id);
		assert.equal(detail.lastRunUsage?.tokens?.cacheRead, 80);
		assert.equal(detail.lastRunUsage?.tokens?.cacheWrite, 20);
		assert.ok((detail.lastRunUsage?.tokens?.total ?? 0) >= 210);
		const firstStartedAt = detail.lastRunUsage?.startedAt;
		const second = fauxAssistantMessage("cache measured again");
		second.usage = {
			input: 5,
			output: 2,
			cacheRead: 90,
			cacheWrite: 0,
			totalTokens: 97,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		harness.setResponses([second]);
		await agents.prompt(session.id, "measure the cache again", []);
		const secondDeadline = Date.now() + 15000;
		while (Date.now() < secondDeadline) {
			const current = agents.get(session.id);
			if (current.status === "idle" && current.lastRunUsage?.startedAt !== firstStartedAt) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const afterSecond = agents.get(session.id);
		assert.equal(afterSecond.tokens?.cacheRead, 170, "session usage accumulates across runs");
		assert.equal(afterSecond.lastRunUsage?.tokens?.cacheRead, 90, "run usage stays a delta");
	} finally {
		await agents.close();
		store.close();
		harness.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});
