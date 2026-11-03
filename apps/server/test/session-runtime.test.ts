import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness, getMessageText } from "../../../packages/coding-agent/test/suite/harness.ts";
import type { SessionDetail } from "../../shared/src/protocol.ts";
import { AgentService } from "../src/agent.ts";
import { ConsoleStore } from "../src/store.ts";

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test(
	"the Pi runtime boundary creates, restores, branches, aborts, reloads and disposes a session",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-runtime-"));
		const root = join(directory, "project");
		const agentDirectory = join(directory, "agent");
		const dataDirectory = join(directory, "data");
		await mkdir(root);
		await mkdir(agentDirectory);
		const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		const harness = await createHarness();
		const store = new ConsoleStore(dataDirectory);
		const workspace = { id: randomUUID(), name: "project", path: root };
		store.saveWorkspace(workspace);
		let created = 0;
		const createSession = (options: Parameters<typeof createAgentSession>[0]) => {
			created++;
			return createAgentSession({
				...options,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
			});
		};
		let agents = new AgentService(store, dataDirectory, { createSession, agentDirectory });
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
			assert.equal(created, 1, "the runtime is created once and reused");

			// Restore: a new service reuses the persisted transcript.
			await agents.close();
			agents = new AgentService(store, dataDirectory, { createSession, agentDirectory });
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
			assert.equal(created, 2, "the restored service opens a new runtime for the existing session");

			// Branch: recalling a user message trims the projected conversation before it.
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

			// Abort: a pending approval is rejected and the run stops.
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

			// Provider reload: the runtime is disposed and recreated on the next run.
			const before = created;
			await agents.prepareForProviderChange();
			harness.setResponses([fauxAssistantMessage("after reload")]);
			await agents.prompt(id, "third task", []);
			await waitFor(() => settled(id), "the answer after the provider reload");
			assert.equal(created, before + 1, "the provider change disposes the runtime and the next run recreates it");

			// Dispose: deleting the session releases the runtime and the transcript.
			const transcript = store.sessions().find((record) => record.detail.id === id)?.file;
			assert.ok(transcript, "the transcript file is tracked");
			await agents.archive(id);
			await agents.delete(id);
			assert.throws(() => agents.get(id), /Session not found/u);
			await assert.rejects(() => access(transcript));
		} finally {
			await agents.close();
			store.close();
			harness.cleanup();
			if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("a failed runtime initialization is not cached and the next run starts clean", { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-runtime-failure-"));
	const root = join(directory, "project");
	const agentDirectory = join(directory, "agent");
	const dataDirectory = join(directory, "data");
	await mkdir(root);
	await mkdir(agentDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const harness = await createHarness();
	const store = new ConsoleStore(dataDirectory);
	const workspace = { id: randomUUID(), name: "project", path: root };
	store.saveWorkspace(workspace);
	let attempts = 0;
	const agents = new AgentService(store, dataDirectory, {
		agentDirectory,
		createSession: (options) => {
			attempts++;
			if (attempts === 1) throw new Error("session factory unavailable");
			return createAgentSession({
				...options,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
			});
		},
	});
	try {
		const session = await agents.create(workspace.id, "retry");
		await assert.rejects(() => agents.prompt(session.id, "first task", []), /session factory unavailable/u);
		assert.equal(agents.get(session.id).status, "idle", "a failed start leaves the session usable");

		harness.setResponses([fauxAssistantMessage("recovered")]);
		await agents.prompt(session.id, "second task", []);
		await waitFor(
			() => agents.get(session.id).messages.some((message) => message.text === "recovered"),
			"the recovered answer",
		);
		assert.equal(attempts, 2, "the failed runtime is dropped instead of being reused");
		const detail: SessionDetail = agents.get(session.id);
		assert.ok(detail.messages.some((message) => message.text === "recovered"));
	} finally {
		await agents.close();
		store.close();
		harness.cleanup();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});
