import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness, getMessageText } from "../../../packages/coding-agent/test/suite/harness.ts";
import type { SessionDetail } from "../../shared/src/protocol.ts";
import { AgentService } from "../src/agent.ts";
import { ConsoleStore } from "../src/store.ts";

test(
	"compressed conversation survives restart, branching and continued model context",
	{ timeout: 30_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-session-storage-"));
		const root = join(directory, "workspace");
		const agentDirectory = join(directory, "agent");
		await mkdir(root);
		await mkdir(agentDirectory);
		const harness = await createHarness();
		let store = new ConsoleStore(directory);
		const options = {
			agentDirectory,
			createSession: ((options) =>
				createAgentSession({
					...options,
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
				})) as typeof createAgentSession,
		};
		let agents = new AgentService(store, directory, options);
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
			await agents.close();
			store.close();
			store = new ConsoleStore(directory);
			agents = new AgentService(store, directory, options);
			assert.deepEqual(
				agents.get(id).messages.map((message) => message.text),
				expected,
			);
			store.compact();
			const firstAnswer = agents.get(id).messages.find((message) => message.text === "first answer");
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
	},
);
