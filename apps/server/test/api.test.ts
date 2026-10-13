import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness, getMessageText } from "../../../packages/coding-agent/test/suite/harness.ts";
import type {
	FileContent,
	LocalFolderListing,
	SessionDetail,
	SocketMessage,
	Workspace,
} from "../../shared/src/protocol.ts";
import { createApp } from "../src/app.ts";
import { contained } from "../src/security.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for SDK event");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test(
	"local-origin REST + real SDK + WebSocket pipeline, approvals, abort, isolation and restart",
	{ timeout: 60_000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-console-api-"));
		const root = join(directory, "project");
		const data = join(directory, "data");
		const agentDir = join(directory, "agent");
		await mkdir(root);
		await mkdir(agentDir);
		await writeFile(join(root, "hello.txt"), "initial");
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const harness = await createHarness({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		// Deterministic faux responses are used only in tests. The application always uses the real SDK factory.
		let factoryCalls = 0;
		const factory: typeof createAgentSession = (options) => {
			factoryCalls++;
			return createAgentSession({
				...options,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
			});
		};
		const options = {
			directory: data,
			roots: [root],
			port: 8787,
			logger: false,
			createSession: factory,
		};
		let { app } = await createApp(options);
		const baseHeaders = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
		const request = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
			app.inject({
				method,
				url,
				headers: baseHeaders,
				payload: payload as Record<string, unknown> | undefined,
			});
		try {
			await t.test("local origin, host and path guards without an access token", async () => {
				assert.equal((await request("GET", "/api/health")).statusCode, 200);
				assert.equal(
					(
						await app.inject({
							method: "POST",
							url: "/api/workspaces",
							headers: { ...baseHeaders, origin: "https://evil.example" },
							payload: { path: root },
						})
					).statusCode,
					403,
				);
				assert.equal(
					(
						await app.inject({
							method: "GET",
							url: "/api/health",
							headers: { host: baseHeaders.host, "sec-fetch-site": "cross-site" },
						})
					).statusCode,
					403,
				);
				assert.equal(
					(
						await app.inject({
							method: "GET",
							url: "/api/health",
							headers: { host: baseHeaders.host, "sec-fetch-site": "same-origin" },
						})
					).statusCode,
					200,
				);
				assert.equal(
					(await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example" } })).statusCode,
					403,
				);
				const projectFolders = await request("GET", `/api/local-folders?path=${encodeURIComponent(root)}`);
				assert.equal(projectFolders.statusCode, 200, projectFolders.body);
				const projectListing = projectFolders.json<LocalFolderListing>();
				assert.equal(projectListing.currentPath, root);
				assert.deepEqual(projectListing.directories, []);
				const workspaces = (await request("GET", "/api/workspaces")).json<Workspace[]>();
				const id = workspaces[0].id;
				assert.equal((await request("GET", `/api/workspaces/${id}/file?path=../outside`)).statusCode, 403);
				assert.equal((await request("POST", "/api/workspaces", { path: directory })).statusCode, 403);
				const content = (await request("GET", `/api/workspaces/${id}/file?path=hello.txt`)).json<FileContent>();
				assert.equal(content.content, "initial");
				const saved = await request("PUT", `/api/workspaces/${id}/file`, { ...content, content: "edited" });
				assert.equal(saved.statusCode, 200);
				assert.equal(
					(await request("PUT", `/api/workspaces/${id}/file`, { ...content, content: "stale" })).statusCode,
					409,
				);
				assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "edited");
			});
			const workspace = (await request("GET", "/api/workspaces")).json<Workspace[]>()[0];
			const create = async () => {
				const result = await request("POST", "/api/sessions", { workspaceId: workspace.id });
				assert.equal(result.statusCode, 200, result.body);
				return result.json<SessionDetail>();
			};
			const first = await create();
			const second = await create();
			assert.equal(factoryCalls, 0, "creating empty sessions should not initialize the SDK or create transcripts");
			const database = new DatabaseSync(join(data, "console.sqlite"));
			for (const session of [first, second]) {
				const stored = database.prepare("SELECT file FROM sessions WHERE id = ?").get(session.id);
				assert.equal(stored?.file, null, "empty sessions should not create native transcript files");
			}
			database.close();
			const messages: SocketMessage[] = [];
			let socket = await app.injectWS(
				`/ws/sessions/${first.id}`,
				{ headers: baseHeaders },
				{
					onInit: (socket) =>
						socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as SocketMessage)),
				},
			);
			await t.test("streaming and independent session context", async () => {
				harness.setResponses([fauxAssistantMessage("streamed test response")]);
				assert.equal(
					(await request("POST", `/api/sessions/${first.id}/messages`, { text: "first prompt" })).statusCode,
					202,
				);
				assert.equal(factoryCalls, 1, "the first prompt should initialize only its own session");
				await waitFor(() =>
					messages.some((message) => message.type === "agent.status" && message.summary.status === "idle"),
				);
				assert.ok(messages.some((message) => message.type === "message.delta" && message.message?.text));
				const current = (await request("GET", `/api/sessions/${first.id}`)).json<SessionDetail>();
				assert.equal(
					current.messages.filter((message) => message.role === "assistant").at(-1)?.text,
					"streamed test response",
				);
				assert.equal((await request("GET", `/api/sessions/${second.id}`)).json<SessionDetail>().messages.length, 0);
				assert.equal(
					(await request("PUT", `/api/sessions/${first.id}/model`, { provider: "faux", modelId: "faux-2" }))
						.statusCode,
					200,
				);
				assert.equal((await request("GET", `/api/sessions/${first.id}`)).json<SessionDetail>().model?.id, "faux-2");
			});
			await t.test("tool mutation waits for approval, disconnect snapshot catches up", async () => {
				messages.length = 0;
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("write", { path: "hello.txt", content: "written by SDK" }, { id: "write-call" }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("write complete", { timestamp: Date.now() + 1 }),
				]);
				assert.equal(
					(await request("POST", `/api/sessions/${first.id}/messages`, { text: "write file" })).statusCode,
					202,
				);
				await waitFor(() => messages.some((message) => message.type === "approval.requested"));
				assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "edited");
				assert.equal(
					(await request("POST", `/api/sessions/${first.id}/messages`, { text: "parallel prompt" })).statusCode,
					409,
				);
				const pending = (await request("GET", `/api/sessions/${first.id}`)).json<SessionDetail>();
				socket.terminate();
				const result = await request("POST", `/api/sessions/${first.id}/approvals/${pending.approvals[0].id}`, {
					approved: true,
				});
				assert.equal(result.statusCode, 200);
				await waitFor(() => harness.getPendingResponseCount() === 0);
				const snapshots: SocketMessage[] = [];
				socket = await app.injectWS(
					`/ws/sessions/${first.id}`,
					{ headers: baseHeaders },
					{
						onInit: (socket) =>
							socket.on("message", (raw) => snapshots.push(JSON.parse(raw.toString()) as SocketMessage)),
					},
				);
				await waitFor(() => snapshots.some((message) => message.type === "session.snapshot"));
				const snapshot = snapshots.find((message) => message.type === "session.snapshot");
				assert.ok(snapshot && snapshot.type === "session.snapshot");
				assert.ok(snapshot.session.tools.some((tool) => tool.id === "write-call" && tool.status === "completed"));
				assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "written by SDK");
				await waitFor(
					() =>
						snapshots.some((message) => message.type === "agent.status" && message.summary.status === "idle") ||
						snapshots.some((message) => message.type === "session.snapshot" && message.session.status === "idle"),
				);
			});
			await t.test("abort rejects pending tool approval and does not write", async () => {
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("write", { path: "hello.txt", content: "must not write" }, { id: "cancel-call" }),
						{ stopReason: "toolUse" },
					),
				]);
				await request("POST", `/api/sessions/${second.id}/messages`, { text: "cancel mutation" });
				await waitFor(() => harness.getPendingResponseCount() === 0);
				let pending: SessionDetail;
				const deadline = Date.now() + 5000;
				do {
					pending = (await request("GET", `/api/sessions/${second.id}`)).json<SessionDetail>();
					if (Date.now() > deadline) throw new Error(`Approval did not arrive: ${JSON.stringify(pending)}`);
					await new Promise((resolve) => setTimeout(resolve, 10));
				} while (!pending.approvals.length);
				assert.equal((await request("POST", `/api/sessions/${second.id}/abort`, {})).statusCode, 200);
				assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "written by SDK");
			});
			await t.test("restart restores metadata and native SDK transcript", async () => {
				socket.terminate();
				await app.close();
				({ app } = await createApp(options));
				const restored = (await request("GET", `/api/sessions/${first.id}`)).json<SessionDetail>();
				assert.equal(restored.status, "idle");
				assert.ok(restored.messages.some((message) => message.text === "first prompt"));
				harness.setResponses([
					(context) => {
						const containsOriginalPrompt = context.messages.some(
							(message) => message.role === "user" && getMessageText(message) === "first prompt",
						);
						assert.equal(containsOriginalPrompt, true);
						return fauxAssistantMessage("resumed", { timestamp: Date.now() + 2 });
					},
				]);
				const events: SocketMessage[] = [];
				socket = await app.injectWS(
					`/ws/sessions/${first.id}`,
					{ headers: baseHeaders },
					{
						onInit: (socket) =>
							socket.on("message", (raw) => events.push(JSON.parse(raw.toString()) as SocketMessage)),
					},
				);
				assert.equal(
					(await request("POST", `/api/sessions/${first.id}/messages`, { text: "resume" })).statusCode,
					202,
				);
				await waitFor(() =>
					events.some((message) => message.type === "agent.status" && message.summary.status === "idle"),
				);
				assert.ok(
					(await request("GET", `/api/sessions/${first.id}`))
						.json<SessionDetail>()
						.messages.some((message) => message.text === "resumed"),
				);
				socket.terminate();
				assert.equal((await request("DELETE", `/api/sessions/${second.id}`)).statusCode, 200);
			});
			await t.test("workspace aliases and removal preserve project and session files", async () => {
				const renamed = await request("PATCH", `/api/workspaces/${workspace.id}`, { name: "项目别名" });
				assert.equal(renamed.statusCode, 200, renamed.body);
				assert.deepEqual(renamed.json<Workspace>(), { ...workspace, name: "项目别名" });

				const database = new DatabaseSync(join(data, "console.sqlite"));
				const saved = database.prepare("SELECT file FROM sessions WHERE id = ?").get(first.id);
				database.close();
				if (!saved || typeof saved.file !== "string") throw new Error("The native session file was not saved");
				const nativeSessionFile = saved.file;

				const removed = await request("DELETE", `/api/workspaces/${workspace.id}`);
				assert.equal(removed.statusCode, 200, removed.body);
				assert.deepEqual(removed.json(), { deleted: true, sessionsDeleted: 1 });
				assert.deepEqual((await request("GET", "/api/workspaces")).json<Workspace[]>(), []);
				assert.deepEqual((await request("GET", "/api/sessions")).json(), []);
				assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "written by SDK");
				await access(nativeSessionFile);

				socket.terminate();
				await app.close();
				({ app } = await createApp(options));
				assert.deepEqual((await request("GET", "/api/workspaces")).json<Workspace[]>(), []);
				assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "written by SDK");
				await access(nativeSessionFile);
			});
		} finally {
			for (const socket of app.websocketServer.clients) socket.terminate();
			await app.close();
			harness.cleanup();
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			assert.ok(contained(tmpdir(), directory));
			await rm(directory, { recursive: true, force: true });
		}
	},
);
