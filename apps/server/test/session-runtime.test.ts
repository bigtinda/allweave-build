import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@allweave/model/compat";
import { AgentService } from "../src/agent.ts";
import { KernelSessionStore } from "../src/persistence/kernel-session-store.ts";
import { ConsoleStore } from "../src/store.ts";
import { createHarness, getMessageText, nativeGateway } from "./faux-native.ts";

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test(
	"the native runtime boundary creates, restores, branches, aborts, reloads and disposes a session",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-runtime-"));
		const root = join(directory, "project");
		const agentDirectory = join(directory, "agent");
		const dataDirectory = join(directory, "data");
		await mkdir(root);
		await mkdir(agentDirectory);
		const previousAgentDirectory = process.env.ALLWEAVE_AGENT_DIR;
		process.env.ALLWEAVE_AGENT_DIR = agentDirectory;
		const harness = await createHarness();
		const store = new ConsoleStore(dataDirectory);
		const workspace = { id: randomUUID(), name: "project", path: root };
		store.saveWorkspace(workspace);
		let opened = 0;
		const options = {
			agentDirectory,
			gateway: () => {
				opened++;
				return nativeGateway(harness);
			},
		};
		const sessions = new KernelSessionStore(dataDirectory, store.db);
		let agents = new AgentService(store, dataDirectory, { ...options, sessionStore: sessions });
		const settled = (id: string) => {
			const status = agents.get(id).status;
			return status === "idle" || status === "error";
		};
		try {
			const session = await agents.create(workspace.id, "runtime");
			const id = session.id;

			harness.setResponses([fauxAssistantMessage("first answer")]);
			await agents.prompt(id, "first task", []);
			await waitFor(() => settled(id), "the first answer");
			assert.equal(agents.get(id).messages.at(-1)?.text, "first answer");
			assert.equal(opened, 1, "the gateway is opened once and reused");

			await agents.close();
			agents = new AgentService(store, dataDirectory, {
				...options,
				sessionStore: new KernelSessionStore(dataDirectory, store.db),
			});
			const restored = agents.get(id);
			assert.ok(restored.messages.some((message) => message.text === "first answer"));
			harness.setResponses([
				(context) => {
					const hasFirstTask = context.messages.some(
						(message) => message.role === "user" && getMessageText(message) === "first task",
					);
					assert.equal(hasFirstTask, true, "the restored runtime keeps the transcript context");
					return fauxAssistantMessage("second answer");
				},
			]);
			await agents.prompt(id, "second task", []);
			await waitFor(() => settled(id), "the second answer");
			assert.equal(agents.get(id).messages.at(-1)?.text, "second answer");
			assert.equal(opened, 2, "the restored service opens a new runtime for the existing session");

			const secondUserMessage = agents
				.get(id)
				.messages.find((message) => message.role === "user" && message.input?.text === "second task");
			assert.ok(secondUserMessage, "the user message keeps its input");
			const recalled = await agents.recall(id, secondUserMessage.id);
			assert.equal(recalled.text, "second task");
			assert.deepEqual(
				recalled.session.messages.map((message) => message.text),
				["first task", "first answer"],
			);

			const abortSession = await agents.create(workspace.id, "abort");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write", { path: "blocked.txt", content: "must not write" }, { id: "abort-write" }),
					{ stopReason: "toolUse" },
				),
			]);
			await agents.prompt(abortSession.id, "write file", []);
			await waitFor(() => agents.get(abortSession.id).approvals.length === 1, "the pending approval");
			await agents.abort(abortSession.id);
			const aborted = agents.get(abortSession.id);
			assert.equal(aborted.approvals.length, 0, "abort clears pending approvals");
			assert.ok(aborted.tools.some((tool) => tool.id === "abort-write" && tool.status === "failed"));

			const before = opened;
			await agents.prepareForProviderChange();
			harness.setResponses([fauxAssistantMessage("after reload")]);
			await agents.prompt(id, "third task", []);
			await waitFor(() => settled(id), "the answer after the provider reload");
			assert.equal(opened, before + 1, "the provider change disposes the runtime and the next run recreates it");

			await agents.archive(id);
			await agents.delete(id);
			assert.throws(() => agents.get(id), /Session not found/u);
			assert.equal(store.db.prepare("SELECT 1 FROM kernel_sessions WHERE id = ?").get(id), undefined);
		} finally {
			await agents.close();
			store.close();
			harness.cleanup();
			if (previousAgentDirectory === undefined) delete process.env.ALLWEAVE_AGENT_DIR;
			else process.env.ALLWEAVE_AGENT_DIR = previousAgentDirectory;
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("a failed native gateway is not cached and the next run starts clean", { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-runtime-failure-"));
	const root = join(directory, "project");
	const agentDirectory = join(directory, "agent");
	const dataDirectory = join(directory, "data");
	await mkdir(root);
	await mkdir(agentDirectory);
	const previousAgentDirectory = process.env.ALLWEAVE_AGENT_DIR;
	process.env.ALLWEAVE_AGENT_DIR = agentDirectory;
	const harness = await createHarness();
	const store = new ConsoleStore(dataDirectory);
	const workspace = { id: randomUUID(), name: "project", path: root };
	store.saveWorkspace(workspace);
	let attempts = 0;
	const agents = new AgentService(store, dataDirectory, {
		agentDirectory,
		gateway: () => {
			attempts++;
			if (attempts === 1) throw new Error("gateway unavailable");
			return nativeGateway(harness);
		},
	});
	try {
		const session = await agents.create(workspace.id, "retry");
		await assert.rejects(() => agents.prompt(session.id, "first task", []), /gateway unavailable/u);
		assert.equal(agents.get(session.id).status, "idle", "a failed start leaves the session usable");

		harness.setResponses([fauxAssistantMessage("recovered")]);
		await agents.prompt(session.id, "second task", []);
		await waitFor(
			() => agents.get(session.id).messages.some((message) => message.text === "recovered"),
			"the recovered answer",
		);
		assert.equal(attempts, 2, "the failed runtime is dropped instead of being reused");
	} finally {
		await agents.close();
		store.close();
		harness.cleanup();
		if (previousAgentDirectory === undefined) delete process.env.ALLWEAVE_AGENT_DIR;
		else process.env.ALLWEAVE_AGENT_DIR = previousAgentDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});
