import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import type { BrowserSnapshot, BrowserStreamEvent } from "../../shared/src/browser.ts";
import type { SessionDetail, Workspace } from "../../shared/src/protocol.ts";
import { createApp } from "../src/app.ts";

test("user input, live browser frames and agent tools share the same isolated page", { timeout: 60_000 }, async () => {
	const fixture = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.end(
			'<title>Agent browser fixture</title><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>',
		);
	});
	await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
	const address = fixture.address();
	assert.ok(address && typeof address !== "string");
	const directory = await mkdtemp(join(tmpdir(), "pi-browser-agent-"));
	const root = join(directory, "project");
	await mkdir(root);
	const harness = await createHarness();
	const { app } = await createApp({
		directory: join(directory, "data"),
		roots: [root],
		port: 8787,
		logger: false,
		createSession: (options) =>
			createAgentSession({ ...options, model: harness.getModel(), modelRuntime: harness.session.modelRuntime }),
	});
	const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
	const request = (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
		app.inject({ method, url, headers, payload });
	try {
		const workspace = (await request("GET", "/api/workspaces"))
			.json<Workspace[]>()
			.find((item) => item.path === root)!;
		const session = (await request("POST", "/api/sessions", { workspaceId: workspace.id })).json<SessionDetail>();
		const path = `/api/sessions/${session.id}/browser`;
		const frames: BrowserStreamEvent[] = [];
		const socket = await app.injectWS(
			`/ws/browser/${session.id}`,
			{ headers },
			{
				onInit: (socket) =>
					socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as BrowserStreamEvent)),
			},
		);
		const opened = await request("POST", path, { action: "navigate", url: `http://127.0.0.1:${address.port}` });
		assert.equal(opened.statusCode, 200, opened.body);
		await request("POST", path, { action: "fill", selector: "#name", text: "用户输入" });
		await request("PUT", `/api/sessions/${session.id}/access-mode`, { accessMode: "full" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("browser", { action: "snapshot" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("browser", { action: "click", selector: "#save" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("browser", { action: "fill", selector: "#name", text: "Agent 中文输入" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("browser", { action: "click", selector: "#save" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const sent = await request("POST", `/api/sessions/${session.id}/messages`, { text: "Operate the shared page" });
		assert.equal(sent.statusCode, 202, sent.body);
		let detail = (await request("GET", `/api/sessions/${session.id}`)).json<SessionDetail>();
		const deadline = Date.now() + 15_000;
		while (detail.status === "running") {
			assert.ok(Date.now() < deadline, "agent browser calls should finish");
			await new Promise((resolve) => setTimeout(resolve, 20));
			detail = (await request("GET", `/api/sessions/${session.id}`)).json<SessionDetail>();
		}
		assert.equal(detail.status, "idle", detail.error);
		assert.equal(
			detail.tools.filter((tool) => tool.name === "browser" && tool.status === "completed").length,
			4,
			JSON.stringify(detail.tools),
		);
		assert.match(JSON.stringify(detail.tools[0]?.output), /用户输入/);
		assert.match((await request("GET", path)).json<BrowserSnapshot>().text, /Agent 中文输入/);
		assert.ok(frames.some((event) => event.type === "frame" && event.image.length > 1000));
		const clicked = await request("POST", path, { action: "click", selector: "#name" });
		assert.equal(clicked.statusCode, 200, clicked.body);
		assert.equal(
			(await request("POST", `${path}/input`, { action: "press", key: "ControlOrMeta+A" })).statusCode,
			200,
		);
		assert.equal(
			(await request("POST", `${path}/input`, { action: "type", text: "direct keyboard input" })).statusCode,
			200,
		);
		await request("POST", path, { action: "click", selector: "#save" });
		assert.match((await request("GET", path)).json<BrowserSnapshot>().text, /direct keyboard input/);
		const other = (await request("POST", "/api/sessions", { workspaceId: workspace.id })).json<SessionDetail>();
		assert.equal((await request("GET", `/api/sessions/${other.id}/browser`)).json(), null);
		socket.terminate();
	} finally {
		for (const socket of app.websocketServer.clients) socket.terminate();
		await app.close();
		harness.cleanup();
		await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
		await rm(directory, { recursive: true, force: true });
	}
});
