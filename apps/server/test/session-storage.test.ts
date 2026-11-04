import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { SessionDetail } from "../../shared/src/protocol.ts";
import { AgentService } from "../src/agent.ts";
import { KernelSessionStore } from "../src/persistence/kernel-session-store.ts";
import { ConsoleStore } from "../src/store.ts";
import { createHarness, getMessageText, nativeGateway } from "./faux-native.ts";

test("native conversation survives restart and branching from kernel snapshots", { timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-session-storage-"));
	const root = join(directory, "workspace");
	const agentDirectory = join(directory, "agent");
	await mkdir(root);
	await mkdir(agentDirectory);
	const harness = await createHarness();
	let store = new ConsoleStore(directory);
	const options = { agentDirectory, gateway: () => nativeGateway(harness) };
	let agents = new AgentService(store, directory, {
		...options,
		sessionStore: new KernelSessionStore(directory, store.db),
	});
	try {
		store.saveWorkspace({ id: "workspace", name: "Project", path: root });
		const { id } = await agents.create("workspace", "Storage regression");
		const waitForIdle = async (): Promise<SessionDetail> => {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const detail = agents.get(id);
				if (detail.status === "idle" || detail.status === "error") {
					assert.equal(detail.error, undefined);
					return detail;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error("Conversation did not settle");
		};
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await agents.prompt(id, "first task", []);
		await waitForIdle();
		await agents.prompt(id, "second task", []);
		const completed = await waitForIdle();
		const expected = completed.messages.map((message) => message.text);
		const expectedIds = completed.messages.map((message) => message.id);
		assert.equal(completed.lastRunUsage?.status, "available");
		assert.equal(completed.lastRunUsage?.outcome, "completed");
		const metaRow = store.db.prepare("SELECT data FROM kernel_sessions WHERE id = ?").get(id);
		assert.ok(metaRow, "the lightweight record is written beside the snapshot");
		assert.ok(!String(metaRow.data).includes("first answer"), "the lightweight record does not carry the body");
		await agents.close();
		store.close();
		store = new ConsoleStore(directory);
		agents = new AgentService(store, directory, {
			...options,
			sessionStore: new KernelSessionStore(directory, store.db),
		});
		const restored = agents.get(id);
		assert.deepEqual(
			restored.messages.map((message) => message.id),
			expectedIds,
		);
		assert.deepEqual(
			restored.messages.map((message) => message.text),
			expected,
		);
		assert.equal(
			restored.messages.find((message) => message.role === "user" && message.text === "second task")?.input?.text,
			"second task",
			"the original input is merged back from the lightweight record",
		);
		const firstAnswer = restored.messages.find((message) => message.text === "first answer");
		assert.ok(firstAnswer);
		const branch = await agents.branch(id, firstAnswer.id);
		assert.deepEqual(
			branch.messages.map((message) => message.text),
			["first task", "first answer"],
		);
		harness.setResponses([
			(context) => {
				const texts = context.messages.map(getMessageText);
				assert.ok(texts.includes("first task"));
				assert.ok(!texts.includes("second task"));
				return fauxAssistantMessage("continued answer");
			},
		]);
		await agents.prompt(id, "continue task", []);
		assert.equal((await waitForIdle()).messages.at(-1)?.text, "continued answer");
	} finally {
		await agents.close();
		store.close();
		harness.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});
