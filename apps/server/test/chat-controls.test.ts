import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness, getMessageText } from "../../../packages/coding-agent/test/suite/harness.ts";
import { applyEvent, type SessionDetail, type SocketMessage } from "../../shared/src/protocol.ts";
import { createApp } from "../src/app.ts";

test(
	"interrupt and recall change the native context, broadcast rewind and survive restart",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-chat-controls-"));
		const root = join(directory, "project");
		const agentDir = join(directory, "agent");
		await mkdir(root);
		await mkdir(agentDir);
		await writeFile(join(root, "reference.txt"), "reference");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const harness = await createHarness();
		const options = {
			directory: join(directory, "data"),
			roots: [root],
			port: 8787,
			logger: false,
			createSession: ((options) =>
				createAgentSession({
					...options,
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
				})) as typeof createAgentSession,
		};
		let { app } = await createApp(options);
		const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
		const request = (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
			app.inject({ method, url, headers, payload });
		try {
			const workspace = (await request("GET", "/api/workspaces")).json<Array<{ id: string }>>()[0];
			const id = (await request("POST", "/api/sessions", { workspaceId: workspace.id })).json<SessionDetail>().id;
			const get = async () => (await request("GET", `/api/sessions/${id}`)).json<SessionDetail>();
			const waitFor = async (predicate: (session: SessionDetail) => boolean) => {
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const session = await get();
					if (predicate(session)) return session;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error(`Timed out waiting for chat state: ${JSON.stringify(await get())}`);
			};
			harness.setResponses([fauxAssistantMessage("keep this answer")]);
			assert.equal(
				(await request("POST", `/api/sessions/${id}/messages`, { text: "keep this task" })).statusCode,
				202,
			);
			await waitFor((session) => session.status === "idle");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write", { path: "blocked.txt", content: "must not write" }, { id: "pending-write" }),
					{ stopReason: "toolUse" },
				),
			]);
			await request("POST", `/api/sessions/${id}/messages`, { text: "old task" });
			await waitFor((session) => session.approvals.length === 1);
			harness.setResponses([fauxAssistantMessage("replacement answer")]);
			assert.equal(
				(
					await request("POST", `/api/sessions/${id}/messages`, {
						text: "replacement task",
						references: ["reference.txt"],
						interrupt: true,
					})
				).statusCode,
				202,
			);
			const completed = await waitFor((session) => session.status === "idle");
			assert.equal(completed.approvals.length, 0);
			assert.ok(completed.tools.some((tool) => tool.id === "pending-write" && tool.status === "failed"));
			const target = completed.messages.find((message) => message.input?.text === "old task");
			assert.ok(target);
			const events: SocketMessage[] = [];
			const socket = await app.injectWS(
				`/ws/sessions/${id}`,
				{ headers },
				{
					onInit: (socket) =>
						socket.on("message", (raw) => events.push(JSON.parse(raw.toString()) as SocketMessage)),
				},
			);
			const recalled = await request("POST", `/api/sessions/${id}/recall`, { messageId: target.id });
			assert.equal(recalled.statusCode, 200, recalled.body);
			const result = recalled.json<{ session: SessionDetail; text: string; references: string[] }>();
			assert.equal(result.text, "old task");
			assert.deepEqual(
				result.session.messages.map((message) => message.text),
				["keep this task", "keep this answer"],
			);
			assert.deepEqual(result.session.tools, []);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const rewind = events.find((event) => event.type === "conversation.rewound");
			assert.ok(rewind && rewind.type !== "session.snapshot");
			assert.deepEqual(applyEvent(completed, rewind).messages, result.session.messages);
			assert.equal((await request("POST", `/api/sessions/${id}/recall`, { messageId: target.id })).statusCode, 404);
			socket.terminate();
			await app.close();
			({ app } = await createApp(options));
			assert.deepEqual(
				(await get()).messages.map((message) => message.text),
				["keep this task", "keep this answer"],
			);
			harness.setResponses([
				(context) => {
					const texts = context.messages.map(getMessageText);
					assert.ok(texts.includes("keep this task"));
					assert.ok(!texts.includes("old task"));
					assert.ok(!texts.some((text) => text.includes("replacement task")));
					return fauxAssistantMessage("edited answer");
				},
			]);
			await request("PUT", `/api/sessions/${id}/access-mode`, { accessMode: "plan" });
			assert.equal(
				(
					await request("POST", `/api/sessions/${id}/messages`, {
						text: "edited task",
						references: ["reference.txt"],
					})
				).statusCode,
				202,
			);
			const edited = await waitFor((session) => session.status === "idle");
			const editedTask = edited.messages.find((message) => message.input?.text === "edited task");
			assert.ok(editedTask);
			const lastRecall = (await request("POST", `/api/sessions/${id}/recall`, { messageId: editedTask.id })).json<{
				text: string;
				references: string[];
			}>();
			assert.equal(
				lastRecall.text,
				"edited task",
				"editor must receive the original text without plan instructions",
			);
			assert.deepEqual(lastRecall.references, ["reference.txt"]);
			const firstUser = (await get()).messages.find((message) => message.role === "user");
			assert.ok(firstUser);
			const emptyRecall = await request("POST", `/api/sessions/${id}/recall`, { messageId: firstUser.id });
			assert.equal(emptyRecall.statusCode, 200, emptyRecall.body);
			assert.deepEqual(emptyRecall.json<{ session: SessionDetail }>().session.messages, []);
			await app.close();
			({ app } = await createApp(options));
			let started!: () => void;
			const streaming = new Promise<void>((resolve) => {
				started = resolve;
			});
			harness.setResponses([
				async (context, options) => {
					assert.ok(!context.messages.some((message) => getMessageText(message) === "keep this task"));
					assert.ok(options?.signal);
					started();
					await new Promise<void>((resolve) =>
						options.signal!.addEventListener("abort", () => resolve(), { once: true }),
					);
					return fauxAssistantMessage("cancelled stream");
				},
				fauxAssistantMessage("new stream answer"),
			]);
			await request("POST", `/api/sessions/${id}/messages`, { text: "streaming task" });
			await streaming;
			assert.equal(
				(await request("POST", `/api/sessions/${id}/messages`, { text: "interrupt stream", interrupt: true }))
					.statusCode,
				202,
			);
			const interrupted = await waitFor((session) => session.status === "idle");
			assert.equal(interrupted.messages.at(-1)?.text, "new stream answer");
		} finally {
			for (const socket of app.websocketServer.clients) socket.terminate();
			await app.close();
			harness.cleanup();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(directory, { recursive: true, force: true });
		}
	},
);
