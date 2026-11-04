import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { type Browser, chromium } from "playwright-core";
import { createServer } from "vite";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import type { FileContent, SessionDetail, SocketMessage, Workspace } from "../../shared/src/protocol.ts";
import { createApp } from "../src/bootstrap/create-app.ts";
import { nativeGateway } from "./native-harness.ts";

test(
	"the chat feature preserves streaming, reconnect, workspace navigation and adjacent pages",
	{ timeout: 60000 },
	async () => {
		const probe = createTcpServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		assert.ok(address && typeof address !== "string");
		const port = address.port;
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const directory = await mkdtemp(join(tmpdir(), "pi-workbench-smoke-"));
		const root = join(directory, "project");
		const secondRoot = join(directory, "second-project");
		await mkdir(root);
		await mkdir(secondRoot);
		await writeFile(join(root, "smoke.ts"), "export const smoke = 1;\n");
		await writeFile(join(secondRoot, "smoke.ts"), "export const smoke = 1;\n");
		const harness = await createHarness();
		const { app } = await createApp({
			directory: join(directory, "data"),
			roots: [root, secondRoot],
			port,
			logger: false,
			createGateway: () => nativeGateway(harness),
		});
		const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
		const vite = existsSync(join(webRoot, "dist/index.html"))
			? undefined
			: await createServer({
					root: webRoot,
					configFile: join(webRoot, "vite.config.ts"),
					server: { middlewareMode: true },
					appType: "spa",
					logLevel: "error",
				});
		if (vite)
			app.setNotFoundHandler((request, reply) => {
				reply.hijack();
				vite.middlewares(request.raw, reply.raw, () => {
					reply.raw.statusCode = 404;
					reply.raw.end();
				});
			});
		const fixture = createHttpServer((_request, response) => {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end("<title>Chat browser fixture</title><h1>Local browser preview</h1>");
		});
		let browser: Browser | undefined;
		try {
			await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
			const fixtureAddress = fixture.address();
			assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
			await app.listen({ host: "127.0.0.1", port });
			for (const channel of ["msedge", "chrome", undefined]) {
				try {
					browser = await chromium.launch({ channel, headless: true });
					break;
				} catch {}
			}
			assert.ok(browser);
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			const errors: string[] = [];
			const messages: SocketMessage[] = [];
			const monacoRequests: string[] = [];
			page.on("request", (request) => {
				if (request.url().includes("/assets/monaco-")) monacoRequests.push(request.url());
			});
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("websocket", (socket) => {
				if (socket.url().includes("/ws/sessions/"))
					socket.on("framereceived", ({ payload }) => messages.push(JSON.parse(String(payload)) as SocketMessage));
			});
			const model = harness.getModel();
			// Only model discovery is supplied by the fixture; session commands and WS use the real server and SDK.
			await page.route("**/api/models?sessionId=*", (route) =>
				route.fulfill({ json: [{ id: model.id, provider: model.provider, name: model.name, available: true }] }),
			);
			await page.goto(`http://127.0.0.1:${port}/`);
			const sessions = await page.evaluate(
				async (model) => {
					const workspaces = await fetch("/api/workspaces").then(
						(response) => response.json() as Promise<Workspace[]>,
					);
					const sessions: SessionDetail[] = [];
					for (const workspace of workspaces.filter((item) => item.kind !== "plugin-development")) {
						const session = await fetch("/api/sessions", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ workspaceId: workspace.id }),
						}).then((response) => response.json() as Promise<SessionDetail>);
						const selected = await fetch(`/api/sessions/${session.id}/model`, {
							method: "PUT",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(model),
						});
						if (!selected.ok) throw new Error(await selected.text());
						sessions.push(session);
					}
					return sessions;
				},
				{ provider: model.provider, modelId: model.id },
			);
			assert.equal(sessions.length, 2);
			const sessionId = sessions[0].id;
			await page.goto(`http://127.0.0.1:${port}/sessions/${sessionId}`);
			harness.setResponses([fauxAssistantMessage("Workbench smoke answer")]);
			const composer = page.getByRole("textbox", { name: "向构序发送任务" });
			await composer.fill("Workbench smoke task");
			await page.getByRole("button", { name: "发送任务", exact: true }).click();
			await page.getByText("Workbench smoke answer", { exact: true }).waitFor();
			assert.ok(messages.some((message) => message.type === "message.delta"));
			assert.equal(await composer.inputValue(), "");
			await composer.fill("Draft survives reconnect and workspace switch");
			for (const socket of app.websocketServer.clients) socket.close(1012, "Smoke reconnect");
			await page.getByText(/连接已断开，正在重试/u).waitFor();
			harness.setResponses([fauxAssistantMessage("Answer while disconnected")]);
			const accepted = await app.inject({
				method: "POST",
				url: `/api/sessions/${sessionId}/messages`,
				headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
				payload: { text: "Reconnect snapshot task" },
			});
			assert.equal(accepted.statusCode, 202);
			await page.getByText("Answer while disconnected", { exact: true }).waitFor();
			assert.ok(messages.filter((message) => message.type === "session.snapshot").length >= 2);
			assert.equal(await composer.inputValue(), "Draft survives reconnect and workspace switch");
			await page.locator(`.session-row a[href="/sessions/${sessions[1].id}"]`).click();
			await page.locator(`.chat-page[data-session-motion-id="${sessions[1].id}"]`).waitFor();
			assert.equal(await composer.inputValue(), "");
			assert.equal(
				await page.locator(`.chat-page[data-session-motion-id="${sessions[1].id}"] .message-assistant`).count(),
				0,
			);
			await page.locator(`.session-row a[href="/sessions/${sessionId}"]`).click();
			await page.locator(`.chat-page[data-session-motion-id="${sessionId}"]:not([inert])`).waitFor();
			await page.getByText("Answer while disconnected", { exact: true }).waitFor();
			assert.equal(await composer.inputValue(), "Draft survives reconnect and workspace switch");
			assert.equal(
				await page
					.locator(`.chat-page[data-session-motion-id="${sessionId}"]:not([inert]) .message-assistant`)
					.count(),
				2,
			);
			await page.getByRole("textbox", { name: "浏览器网址" }).fill(`http://127.0.0.1:${fixtureAddress.port}`);
			await page.getByRole("button", { name: "打开网址" }).click();
			await page.getByRole("tab", { name: "Chat browser fixture", exact: true }).waitFor();
			await page.getByRole("img", { name: "Chat browser fixture", exact: true }).waitFor();
			if (!vite) assert.equal(monacoRequests.length, 0, "chat must not preload Monaco");
			await page.getByRole("tab", { name: "文件", exact: true }).click();
			await page.getByRole("button", { name: /smoke\.ts/u }).click();
			await page.locator(".monaco-editor textarea.inputarea").focus();
			if (!vite) assert.ok(monacoRequests.length > 0, "file preview loads the local editor chunks");
			await page.keyboard.press("ControlOrMeta+A");
			await page.keyboard.insertText("export const smoke = 2;\n");
			await page.getByRole("button", { name: "保存", exact: true }).click();
			await page.getByRole("button", { name: "确认保存", exact: true }).click();
			await page.getByText("已保存 smoke.ts", { exact: true }).waitFor();
			const saved = await app.inject({
				method: "GET",
				url: `/api/workspaces/${sessions[0].workspaceId}/file?path=smoke.ts`,
				headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
			});
			assert.equal(saved.json<FileContent>().content, "export const smoke = 2;\n");
			await page.reload();
			await page.getByText("Workbench smoke answer", { exact: true }).waitFor();
			await page.getByText("Answer while disconnected", { exact: true }).waitFor();
			await page.getByRole("tab", { name: "Chat browser fixture", exact: true }).waitFor();
			await page.getByRole("link", { name: "插件开发", exact: true }).first().click();
			await page.waitForURL(/\/sessions\/[^/]+$/u);
			await page.getByText("默认插件开发工作区 · 文件修改与安装需确认").waitFor();
			assert.notEqual(new URL(page.url()).pathname, `/sessions/${sessionId}`);
			await page.getByRole("link", { name: "模型与设置", exact: true }).first().click();
			await page.waitForURL(/\/settings$/u);
			await page.locator('.console-route-switch a[href="/settings/plugins"]').click();
			await page.waitForURL(/\/settings\/plugins$/u);
			assert.deepEqual(errors, []);
		} finally {
			await browser?.close();
			await app.close();
			await vite?.close();
			await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
			harness.cleanup();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
