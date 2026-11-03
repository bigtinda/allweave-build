import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import { AgentService } from "../agent.ts";
import { AppPluginManager } from "../app-plugins.ts";
import { BrowserService } from "../browser.ts";
import { PiPackageManager } from "../packages.ts";
import { KernelSessionStore } from "../persistence/kernel-session-store.ts";
import { ProviderManager } from "../providers.ts";
import { RemoteWorkspaceService } from "../remote-workspaces.ts";
import { HttpError, tokenMatches } from "../security.ts";
import type { SessionFactory } from "../sessions/pi-runtime.adapter.ts";
import { StorageManager } from "../storage.ts";
import { ConsoleStore } from "../store.ts";
import { registerAppPluginRoutes } from "../transport/http/app-plugins.routes.ts";
import { registerBrowserRoutes } from "../transport/http/browser.routes.ts";
import { registerProviderRoutes } from "../transport/http/providers.routes.ts";
import { registerResourceRoutes } from "../transport/http/resources.routes.ts";
import { authorizeSessionWorkspace, registerSessionRoutes } from "../transport/http/sessions.routes.ts";
import { registerWorkspaceRoutes } from "../transport/http/workspaces.routes.ts";
import { WorkspaceService } from "../workspaces/service.ts";

export interface AppOptions {
	directory: string;
	roots: string[];
	port: number;
	logger?: boolean;
	/** Seam for tests: the Pi session factory used by the runtime boundary. */
	createSession?: SessionFactory;
	remoteWorkspaces?: RemoteWorkspaceService;
}

/**
 * The composition root of the workbench: it builds the services, the Fastify
 * instance and the transport hooks, and registers the route modules.
 */
export async function createApp(options: AppOptions) {
	const desktop = process.env.PI_CONSOLE_DESKTOP === "1";
	const desktopShutdownToken = process.env.PI_CONSOLE_SHUTDOWN_TOKEN ?? "";
	const allowedOrigins = new Set([`http://127.0.0.1:${options.port}`, "http://127.0.0.1:5173"]);
	const allowedHosts = new Set([`127.0.0.1:${options.port}`, "127.0.0.1:5173"]);
	const store = new ConsoleStore(options.directory);
	const sessions = new KernelSessionStore(options.directory, store.db);
	const remoteWorkspaces = options.remoteWorkspaces ?? new RemoteWorkspaceService(options.directory);
	const workspaces = new WorkspaceService({
		directory: options.directory,
		roots: options.roots,
		store,
		remote: remoteWorkspaces,
	});
	const pluginWorkspace = await workspaces.initialize();
	sessions.reassignPluginDevelopmentSessions(pluginWorkspace.id);
	sessions.expireApprovals();
	const agentDirectory = resolve(process.env.PI_CODING_AGENT_DIR ?? join(options.directory, "agent"));
	const providers = new ProviderManager(agentDirectory);
	const browser = new BrowserService([...allowedOrigins]);
	const appPlugins = new AppPluginManager(options.directory);
	const agents = new AgentService(store, options.directory, {
		createSession: options.createSession ?? createAgentSession,
		providers,
		agentDirectory,
		browser,
		appPlugins,
		workspaceAccess: workspaces.access,
		sessionStore: sessions,
	});
	providers.setBeforeChange(() => agents.prepareForProviderChange());
	const packages = new PiPackageManager(agentDirectory, agentDirectory, () => agents.prepareForProviderChange());
	const storage = new StorageManager(options.directory, agentDirectory, sessions, agents);
	const app = Fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024 });
	app.addHook("onClose", async () => remoteWorkspaces.close());
	await app.register(websocket, { options: { maxPayload: 4096 } });
	app.addHook("onRequest", async (request, reply) => {
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("Referrer-Policy", "no-referrer");
		reply.header("X-Frame-Options", "DENY");
		reply.header("Cache-Control", "no-store");
		if (!allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403, "Host is not allowed");
		const origin = request.headers.origin;
		if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, "Origin is not allowed");
		if (!["GET", "HEAD"].includes(request.method) && !origin) throw new HttpError(403, "Origin is required");
		if (request.url.startsWith("/ws/") && !origin) throw new HttpError(403, "WebSocket origin is required");
		if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
			const sameLocalOrigin = origin
				? allowedOrigins.has(origin)
				: request.headers["sec-fetch-site"] === "same-origin";
			if (!sameLocalOrigin) throw new HttpError(403, "A same-origin local request is required");
			if (
				desktop &&
				request.url === "/api/desktop/shutdown" &&
				request.method === "POST" &&
				tokenMatches(
					typeof request.headers["x-pi-console-shutdown-token"] === "string"
						? request.headers["x-pi-console-shutdown-token"]
						: "",
					desktopShutdownToken,
				)
			)
				return;
		}
	});
	app.setErrorHandler((error, request, reply) => {
		const status =
			error instanceof HttpError
				? error.statusCode
				: error instanceof z.ZodError
					? 400
					: error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
						? error.statusCode
						: 500;
		if (status >= 500) request.log.error({ err: error }, "Console request failed");
		void reply.code(status).send({ error: error instanceof Error ? error.message : "Request failed" });
	});
	app.get("/api/health", async () => ({
		status: "ok",
		kernel: VERSION,
	}));
	if (desktop) {
		app.post("/api/desktop/shutdown", async () => {
			setTimeout(() => {
				void app.close().finally(() => process.exit(0));
			}, 100);
			return { shuttingDown: true };
		});
	}
	app.get("/api/settings", async () => ({
		mode: "local-single-user",
		roots: workspaces.rootsSnapshot(),
		kernel: { version: VERSION, integration: "in-process" },
		agentDirectory,
		credentialStorage: "auth.json and models.json in the workbench configuration directory",
		approvals: "Every command, file mutation and custom tool requires confirmation",
		isolation:
			"Authorized file APIs; trusted extensions and approved commands run with host permissions. No sandbox.",
		authentication: "Server credentials and environment variables; never sent to the browser",
	}));
	registerProviderRoutes({ app, providers });
	registerResourceRoutes({ app, packages, storage, agents, workspaces, agentDirectory });
	registerAppPluginRoutes({ app, appPlugins, agents, workspaces, pluginWorkspace });
	registerWorkspaceRoutes({ app, workspaces, agents });
	registerBrowserRoutes({ app, browser, agents });
	registerSessionRoutes({ app, agents, workspaces });
	// Re-authorize persisted workspaces on every session route, including WebSocket.
	app.addHook("preHandler", authorizeSessionWorkspace(agents, workspaces));
	const frontend = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
	if (existsSync(frontend)) {
		await app.register(fastifyStatic, { root: frontend, wildcard: false });
		app.setNotFoundHandler((request, reply) => {
			if (request.url.startsWith("/api/") || request.url.startsWith("/ws/"))
				return reply.code(404).send({ error: "Not found" });
			return reply.sendFile("index.html");
		});
	}
	app.addHook("onClose", async () => {
		await agents.close();
		await packages.close();
		await providers.close();
		sessions.close();
		store.close();
	});
	if (!options.createSession) void packages.ensureDefaultPackages();
	return { app };
}

/** Authorized workspace roots of the workbench. */
export function configuredRoots(fallback: string): string[] {
	return process.env.PI_CONSOLE_ROOTS?.split(delimiter).filter(Boolean) ?? [fallback];
}
