import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../../agent.ts";
import type { PiPackageManager } from "../../packages.ts";
import { importSkillPackage, stagePluginPackage } from "../../resource-imports.ts";
import type { StorageManager } from "../../storage.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";
import { resourceImportFiles } from "./schemas.ts";

export interface ResourceRoutesOptions {
	app: FastifyInstance;
	packages: PiPackageManager;
	storage: StorageManager;
	agents: AgentService;
	workspaces: WorkspaceService;
	agentDirectory: string;
}

/** Pi packages, storage maintenance, model catalogue and skill imports. */
export function registerResourceRoutes(options: ResourceRoutesOptions): void {
	const { app, agents, agentDirectory, packages, storage, workspaces } = options;
	app.get("/api/packages", async () => packages.list());
	app.get("/api/packages/defaults", async () => packages.defaultPlugins());
	app.post("/api/packages/install", async (request) => {
		const { input } = z.object({ input: z.string().trim().min(1).max(512) }).parse(request.body);
		return packages.install(input);
	});
	app.post("/api/packages/import", { bodyLimit: 12 * 1024 * 1024 }, async (request) => {
		const { files } = z.object({ files: resourceImportFiles }).strict().parse(request.body);
		return stagePluginPackage(agentDirectory, files);
	});
	app.post("/api/packages/remove", async (request) => {
		const { source } = z.object({ source: z.string().trim().min(1).max(512) }).parse(request.body);
		return packages.remove(source);
	});
	app.post("/api/packages/apply", async (request) => {
		const input = z.object({ source: z.string().trim().min(1).max(512), applied: z.boolean() }).parse(request.body);
		return packages.setApplied(input.source, input.applied);
	});
	app.get("/api/packages/jobs/:id", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		return packages.getJob(id);
	});
	app.get("/api/storage", async () => storage.summary());
	app.post("/api/storage/compact", async () => storage.compact());
	app.get("/api/models", async (request) => {
		const { sessionId } = z.object({ sessionId: z.string().uuid().optional() }).parse(request.query);
		if (sessionId) workspaces.get(agents.get(sessionId).workspaceId);
		return agents.models(sessionId);
	});
	app.get("/api/skills", async (request) => {
		const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.query);
		workspaces.get(agents.get(sessionId).workspaceId);
		return agents.resources(sessionId);
	});
	app.post("/api/skills/import", { bodyLimit: 12 * 1024 * 1024 }, async (request) => {
		const { files } = z.object({ files: resourceImportFiles }).strict().parse(request.body);
		return importSkillPackage(agentDirectory, files);
	});
}
