import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import type { SessionDetail } from "../../shared/src/protocol.ts";
import { createApp } from "../src/app.ts";
import { AppPluginManager, parseAppPluginManifest } from "../src/app-plugins.ts";
import { HttpError } from "../src/security.ts";

function manifest(version: string, required = false, label = "Title") {
	return parseAppPluginManifest(
		JSON.stringify({
			manifestVersion: 1,
			id: "project-tasks",
			name: "Project tasks",
			version,
			description: "Workspace task records",
			fields: [{ id: "title", label, type: "text", required }],
			views: [{ id: "table", title: "Tasks", type: "table" }],
			navigation: [{ id: "tasks", title: "Tasks", viewId: "table" }],
		}),
	);
}

test("application plugin records stay isolated by workspace and persist across manager restart", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".app-plugin-test-"));
	try {
		const workspaceA = randomUUID();
		const workspaceB = randomUUID();
		const manager = new AppPluginManager(directory);
		await manager.install(manifest("1.0.0"));
		const record = await manager.createRecord("project-tasks", workspaceA, { title: "Prepare release" });
		assert.equal(record.values.title, "Prepare release");
		assert.deepEqual(await manager.listRecords("project-tasks", workspaceB), []);

		const restarted = new AppPluginManager(directory);
		assert.deepEqual(await restarted.listRecords("project-tasks", workspaceA), [record]);
		await restarted.setEnabled("project-tasks", false);
		await assert.rejects(restarted.listRecords("project-tasks", workspaceA), (error: unknown) => {
			return error instanceof HttpError && error.statusCode === 404;
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("plugin updates require a higher version and preserve the existing data schema", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".app-plugin-test-update-"));
	try {
		const manager = new AppPluginManager(directory);
		await manager.install(manifest("1.0.0"));
		const updated = await manager.install(manifest("1.1.0", false, "Task title"));
		assert.equal(updated.manifest.version, "1.1.0");

		await assert.rejects(manager.install(manifest("1.1.0", false, "Renamed")), (error: unknown) => {
			return error instanceof HttpError && error.statusCode === 409;
		});
		await assert.rejects(manager.install(manifest("1.2.0", true)), (error: unknown) => {
			return error instanceof HttpError && error.statusCode === 409;
		});
		assert.equal((await manager.list()).plugins[0]?.manifest.version, "1.1.0");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("plugin manifest validation rejects duplicate fields and unsupported properties", () => {
	const duplicateFields = JSON.stringify({
		...manifest("1.0.0"),
		fields: [
			{ id: "title", label: "A", type: "text", required: false },
			{ id: "title", label: "B", type: "text", required: false },
		],
	});
	assert.throws(() => parseAppPluginManifest(duplicateFields), HttpError);
	assert.throws(
		() => parseAppPluginManifest(JSON.stringify({ ...manifest("1.0.0"), script: "process.exit()" })),
		HttpError,
	);
});

test(
	"plugin development chat uses its reserved workspace and confined development tools",
	{ timeout: 30_000 },
	async () => {
		const directory = await mkdtemp(join(process.cwd(), ".app-plugin-test-session-"));
		const workspace = join(directory, "workspace");
		const agentDirectory = join(directory, "agent");
		const dataDirectory = join(directory, "data");
		await mkdir(workspace);
		await mkdir(agentDirectory);
		const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		const harness = await createHarness();
		let getActiveTools: (() => string[]) | undefined;
		let sessionOptions: Parameters<typeof createAgentSession>[0] | undefined;
		const createSession: typeof createAgentSession = async (options) => {
			sessionOptions = options;
			const result = await createAgentSession({
				...options,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
			});
			getActiveTools = () => result.session.getActiveToolNames();
			return result;
		};
		const { app } = await createApp({
			directory: dataDirectory,
			roots: [workspace],
			port: 8787,
			logger: false,
			createSession,
		});
		const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
		const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
			app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined });
		try {
			const workspaces = (await request("GET", "/api/workspaces")).json<
				Array<{ id: string; path: string; kind?: string }>
			>();
			const pluginWorkspace = workspaces.find((workspace) => workspace.kind === "plugin-development");
			assert.ok(pluginWorkspace);
			assert.match(pluginWorkspace.path, /plugin-workspace/u);
			await mkdir(join(pluginWorkspace.path, ".pi"), { recursive: true });
			await writeFile(
				join(pluginWorkspace.path, ".pi", "settings.json"),
				JSON.stringify({ defaultTools: ["bash"] }),
				"utf8",
			);
			const created = await request("POST", "/api/app-plugins/development-session", {});
			assert.equal(created.statusCode, 200, created.body);
			const sessionId = created.json<SessionDetail>().id;
			assert.equal(created.json<SessionDetail>().workspaceId, pluginWorkspace.id);
			const reused = await request("POST", "/api/app-plugins/development-session", {});
			assert.equal(reused.json<SessionDetail>().id, sessionId);
			const ordinaryCreation = await request("POST", "/api/sessions", { workspaceId: pluginWorkspace.id });
			assert.equal(ordinaryCreation.statusCode, 409);
			const rename = await request("PATCH", `/api/workspaces/${pluginWorkspace.id}`, { name: "renamed" });
			assert.equal(rename.statusCode, 409);
			const referenced = await request("POST", `/api/sessions/${sessionId}/messages`, {
				text: "读取文件",
				references: ["secret.txt"],
			});
			assert.equal(referenced.statusCode, 400, referenced.body);
			const manifestPath = "plugins/project-tasks.json";
			await writeFile(join(pluginWorkspace.path, manifestPath), JSON.stringify(manifest("1.0.0")), "utf8");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("plugin_list", {}, { id: "plugin-list" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("plugin_validate", { path: manifestPath }, { id: "plugin-validate" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("plugin_install", { path: manifestPath }, { id: "plugin-install" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("插件清单已校验并安装。"),
			]);
			const accepted = await request("POST", `/api/sessions/${sessionId}/messages`, {
				text: "查看插件、校验并安装测试清单",
				references: [],
			});
			assert.equal(accepted.statusCode, 202, accepted.body);
			const deadline = Date.now() + 10_000;
			let detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
			while (!detail.approvals.length && detail.status === "running" && Date.now() <= deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
			}
			assert.equal(
				detail.approvals[0]?.name,
				"plugin_install",
				JSON.stringify({
					status: detail.status,
					error: detail.error,
					tools: getActiveTools?.(),
					messages: detail.messages,
				}),
			);
			const approved = await request("POST", `/api/sessions/${sessionId}/approvals/${detail.approvals[0]?.id}`, {
				approved: true,
			});
			assert.equal(approved.statusCode, 200, approved.body);
			while (detail.status !== "idle" && Date.now() <= deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
			}
			if (detail.status !== "idle") throw new Error(`Plugin development timed out: ${JSON.stringify(detail)}`);

			assert.equal(detail.purpose, "plugin-development");
			assert.deepEqual(sessionOptions?.tools, [
				"read",
				"edit",
				"write",
				"plugin_list",
				"plugin_validate",
				"plugin_install",
			]);
			assert.equal(sessionOptions?.noTools, "all");
			assert.equal(sessionOptions?.settingsManager?.getProjectSettings().defaultTools, undefined);
			assert.equal(sessionOptions?.customTools?.length, 3);
			const pluginExtensions = sessionOptions?.resourceLoader?.getExtensions().extensions ?? [];
			assert.equal(pluginExtensions.length, 1);
			assert.ok(pluginExtensions.every((extension) => extension.path.startsWith("<inline:")));
			assert.equal(sessionOptions?.resourceLoader?.getSkills().skills.length, 0);
			assert.equal(sessionOptions?.resourceLoader?.getAgentsFiles().agentsFiles.length, 0);
			const activeTools = getActiveTools?.() ?? [];
			assert.deepEqual(activeTools.slice().sort(), [
				"edit",
				"plugin_install",
				"plugin_list",
				"plugin_validate",
				"read",
				"write",
			]);
			assert.equal(
				(await request("GET", "/api/app-plugins")).json<{ plugins: Array<{ manifest: { id: string } }> }>()
					.plugins[0]?.manifest.id,
				"project-tasks",
			);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("plugin_project_tasks_list", {}, { id: "plugin-data-list" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("插件数据工具已可用。"),
			]);
			const next = await request("POST", `/api/sessions/${sessionId}/messages`, { text: "读取插件数据" });
			assert.equal(next.statusCode, 202, next.body);
			const nextDeadline = Date.now() + 10_000;
			detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
			while (detail.status !== "idle" && Date.now() <= nextDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
			}
			assert.equal(detail.status, "idle");
			assert.ok(sessionOptions?.tools?.includes("plugin_project_tasks_list"));
			assert.ok(getActiveTools?.().includes("plugin_project_tasks_list"));
		} finally {
			for (const socket of app.websocketServer.clients) socket.terminate();
			await app.close();
			harness.cleanup();
			if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("plugin changes refresh a session after its current run finishes", { timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(process.cwd(), ".app-plugin-test-refresh-"));
	const workspace = join(directory, "workspace");
	const agentDirectory = join(directory, "agent");
	const dataDirectory = join(directory, "data");
	await mkdir(workspace);
	await mkdir(agentDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const harness = await createHarness();
	const activeToolsByCreation: string[][] = [];
	const createSession: typeof createAgentSession = async (options) => {
		const result = await createAgentSession({
			...options,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
		});
		activeToolsByCreation.push(result.session.getActiveToolNames());
		return result;
	};
	const { app } = await createApp({
		directory: dataDirectory,
		roots: [workspace],
		port: 8787,
		logger: false,
		createSession,
	});
	const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
	const request = (method: "GET" | "POST", url: string, payload?: unknown) =>
		app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined });
	try {
		const workspaces = (await request("GET", "/api/workspaces")).json<Array<{ id: string; kind?: string }>>();
		const userWorkspace = workspaces.find((workspace) => workspace.kind !== "plugin-development");
		const created = await request("POST", "/api/sessions", { workspaceId: userWorkspace?.id });
		assert.equal(created.statusCode, 200, created.body);
		const sessionId = created.json<SessionDetail>().id;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "refresh-test.txt", content: "created" }, { id: "refresh-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("file written"),
			fauxAssistantMessage("plugin tools loaded"),
		]);
		const started = await request("POST", `/api/sessions/${sessionId}/messages`, { text: "write a file" });
		assert.equal(started.statusCode, 202, started.body);
		const deadline = Date.now() + 10_000;
		let pending = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
		while (!pending.approvals.length && Date.now() <= deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			pending = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
		}
		assert.ok(pending.approvals.length, "the write tool should be waiting for approval");
		const installed = await request("POST", "/api/app-plugins/install", {
			manifestJson: JSON.stringify(manifest("1.0.0")),
		});
		assert.equal(installed.statusCode, 200, installed.body);
		assert.equal(activeToolsByCreation.length, 1);
		assert.equal(activeToolsByCreation[0]?.includes("plugin_project_tasks_list"), false);
		const approved = await request("POST", `/api/sessions/${sessionId}/approvals/${pending.approvals[0]?.id}`, {
			approved: true,
		});
		assert.equal(approved.statusCode, 200, approved.body);
		const runDeadline = Date.now() + 10_000;
		let detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
		while (detail.status !== "idle" && Date.now() <= runDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			detail = (await request("GET", `/api/sessions/${sessionId}`)).json<SessionDetail>();
		}
		assert.equal(detail.status, "idle", "the first run should finish");
		const next = await request("POST", `/api/sessions/${sessionId}/messages`, { text: "continue" });
		assert.equal(next.statusCode, 202, next.body);
		const nextDeadline = Date.now() + 10_000;
		while (activeToolsByCreation.length < 2 && Date.now() <= nextDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(activeToolsByCreation.length, 2, "the next run should recreate its SDK session");
		assert.equal(activeToolsByCreation[1]?.includes("plugin_project_tasks_list"), true);
	} finally {
		for (const socket of app.websocketServer.clients) socket.terminate();
		await app.close();
		harness.cleanup();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});
