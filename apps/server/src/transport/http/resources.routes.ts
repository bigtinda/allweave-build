import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../../agent.ts";
import { importSkillPackage } from "../../resource-imports.ts";
import type { StorageManager } from "../../storage.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";
import { resourceImportFiles } from "./schemas.ts";

export interface ResourceRoutesOptions {
	app: FastifyInstance;
	storage: StorageManager;
	agents: AgentService;
	workspaces: WorkspaceService;
	agentDirectory: string;
}

/** Storage maintenance, model catalogue and skill imports. */
export function registerResourceRoutes(options: ResourceRoutesOptions): void {
	const { app, agents, agentDirectory, storage, workspaces } = options;
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
