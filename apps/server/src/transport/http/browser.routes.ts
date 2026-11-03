import type { FastifyInstance } from "fastify";
import type { AgentService } from "../../agent.ts";
import { type BrowserService, browserCommand } from "../../browser.ts";
import { HttpError } from "../../security.ts";
import { registerBrowserStream } from "../websocket/browser-stream.ts";
import { idParams } from "./schemas.ts";

export interface BrowserRoutesOptions {
	app: FastifyInstance;
	browser: BrowserService;
	agents: AgentService;
}

/** Browser surface of a session: snapshot, commands and the live stream. */
export function registerBrowserRoutes(options: BrowserRoutesOptions): void {
	const { app, agents, browser } = options;
	app.get("/api/sessions/:id/browser", async (request) => {
		const { id } = idParams.parse(request.params);
		agents.get(id);
		return browser.snapshot(id);
	});
	app.post("/api/sessions/:id/browser", async (request) => {
		const { id } = idParams.parse(request.params);
		agents.get(id);
		const command = browserCommand.parse(request.body);
		return browser.run(id, command);
	});
	app.post("/api/sessions/:id/browser/input", async (request) => {
		const { id } = idParams.parse(request.params);
		agents.get(id);
		const command = browserCommand.parse(request.body);
		if (!["pointer", "type", "press", "scroll", "resize"].includes(command.action))
			throw new HttpError(400, "不支持的浏览器输入");
		await browser.run(id, command, undefined, false);
		return { accepted: true };
	});
	app.get("/ws/browser/:id", { websocket: true }, (socket, request) => {
		const { id } = idParams.parse(request.params);
		agents.get(id);
		registerBrowserStream(socket, browser, id);
	});
}
