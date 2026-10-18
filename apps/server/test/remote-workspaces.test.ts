import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Connection } from "@earendil-works/pi-env";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import type { Workspace } from "../../shared/src/protocol.ts";
import { AgentService } from "../src/agent.ts";
import { createApp } from "../src/app.ts";
import { HttpError } from "../src/security.ts";
import { ConsoleStore } from "../src/store.ts";
import { daemon, LoopbackRemoteWorkspaces } from "./remote-fixture.ts";

test(
	"remote daemon file operations, project isolation and real SDK tools",
	{ timeout: 30_000, skip: !daemon || !existsSync(daemon) ? "Run npm run hydrate:env-daemons first" : false },
	async (t) => {
		assert.ok(daemon);
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-remote-workspaces-")));
		const root = join(directory, "remote-project");
		const outside = join(directory, "outside");
		const agentDirectory = join(directory, "agent");
		await mkdir(root);
		await mkdir(outside);
		await mkdir(agentDirectory);
		const transport = new Connection({ command: [daemon] });
		const remote = new LoopbackRemoteWorkspaces(directory, transport);
		const store = new ConsoleStore(directory);
		const harness = await createHarness();
		const agents = new AgentService(store, directory, {
			agentDirectory,
			remoteWorkspaces: remote,
			createSession: (options) =>
				createAgentSession({ ...options, model: harness.getModel(), modelRuntime: harness.session.modelRuntime }),
		});
		const workspace: Workspace = { id: "remote", name: "Remote", path: root, remote: { host: "loopback" } };
		store.saveWorkspace(workspace);
		try {
			await t.test("new files, browsing and protected paths use the daemon", async () => {
				await writeFile(join(root, ".env"), "secret");
				await remote.createDirectory(workspace, "nested");
				await remote.writeFile(workspace, "nested/new.txt", "remote content");
				assert.equal((await remote.readFile(workspace, "nested/new.txt")).content, "remote content");
				assert.deepEqual(
					(await remote.listFiles(workspace, "nested")).map((file) => file.path),
					["nested/new.txt"],
				);
				assert.deepEqual(
					(await remote.browse("loopback", root)).directories.map((folder) => folder.name),
					["nested"],
				);
				await assert.rejects(
					remote.readFile(workspace, "../outside.txt"),
					(error) => error instanceof HttpError && error.statusCode === 403,
				);
				await assert.rejects(
					remote.readFile(workspace, ".env"),
					(error) => error instanceof HttpError && error.statusCode === 403,
				);
				await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
				await assert.rejects(
					remote.checkedPath(workspace, "linked"),
					(error) => error instanceof HttpError && error.statusCode === 403,
				);
			});
			await t.test("nested SDK paths map to POSIX hosts from the local operating system", async () => {
				const posixRemote = new LoopbackRemoteWorkspaces(directory, transport, posix);
				const proxy = join(directory, "proxy");
				assert.equal(
					await posixRemote.toolPath(
						{ ...workspace, path: "/srv/project" },
						proxy,
						join(proxy, "src", "index.ts"),
					),
					"/srv/project/src/index.ts",
				);
			});
			await t.test("session file tools and shell execute in the remote project", async () => {
				const session = await agents.create(workspace.id, "Remote tools");
				await agents.setAccessMode(session.id, "full");
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("write", { path: "agent/new.txt", content: "initial" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(fauxToolCall("read", { path: join(root, "agent", "new.txt") }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(
						fauxToolCall("edit", { path: "agent/new.txt", oldText: "initial", newText: "updated" }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'shell output' > shell.txt" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				await agents.prompt(session.id, "Create and update the remote file", []);
				const deadline = Date.now() + 10_000;
				while (agents.get(session.id).status === "running") {
					if (Date.now() > deadline) throw new Error("Remote tools did not finish");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				const completed = agents.get(session.id);
				assert.equal(completed.status, "idle", completed.error);
				assert.equal(completed.tools.length, 4);
				assert.ok(
					completed.tools.every((tool) => tool.status === "completed"),
					JSON.stringify(completed.tools),
				);
				assert.equal(await readFile(join(root, "agent", "new.txt"), "utf8"), "updated");
				assert.equal(await readFile(join(root, "shell.txt"), "utf8"), "shell output");
				await assert.rejects(access(join(directory, "remote-projects", workspace.id, "agent", "new.txt")));
			});
		} finally {
			await agents.close();
			transport.close();
			store.close();
			harness.cleanup();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("local and remote projects with the same path retain separate identities and removal state", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-workspace-identities-")));
	const root = join(directory, "project");
	const data = join(directory, "data");
	await mkdir(root);
	const remote: Workspace = { id: randomUUID(), name: "Remote", path: root, remote: { host: "remote-host" } };
	let store = new ConsoleStore(data);
	store.saveWorkspace(remote);
	store.close();
	const options = { directory: data, roots: [root], port: 8787, logger: false, createSession: createAgentSession };
	let { app } = await createApp(options);
	const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
	try {
		const workspaces = (await app.inject({ url: "/api/workspaces", headers })).json<Workspace[]>();
		const local = workspaces.find((workspace) => workspace.path === root && !workspace.remote);
		assert.ok(local);
		assert.ok(workspaces.some((workspace) => workspace.id === remote.id && workspace.remote?.host === "remote-host"));
		const duplicate = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { path: root } });
		assert.equal(duplicate.statusCode, 200, duplicate.body);
		assert.equal(duplicate.json<Workspace>().id, local.id);
		const removed = await app.inject({ method: "DELETE", url: `/api/workspaces/${local.id}`, headers });
		assert.equal(removed.statusCode, 200, removed.body);
		await app.close();
		store = new ConsoleStore(data);
		store.saveWorkspace({ ...remote, name: "Renamed remote" });
		assert.equal(store.workspaceWasRemoved(root), true);
		store.close();
		({ app } = await createApp(options));
		const restored = (await app.inject({ url: "/api/workspaces", headers })).json<Workspace[]>();
		assert.equal(restored.filter((workspace) => workspace.path === root).length, 1);
		assert.equal(restored.find((workspace) => workspace.id === remote.id)?.remote?.host, "remote-host");
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
