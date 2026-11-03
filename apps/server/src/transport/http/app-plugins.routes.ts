import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Workspace } from "../../../../shared/src/protocol.ts";
import type { AgentService } from "../../agent.ts";
import { type AppPluginManager, parseAppPluginManifest } from "../../app-plugins.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";

export interface AppPluginRoutesOptions {
	app: FastifyInstance;
	appPlugins: AppPluginManager;
	agents: AgentService;
	workspaces: WorkspaceService;
	/** The system managed plugin development workspace. */
	pluginWorkspace: Workspace;
}

/** Application plugin manifests, installation and workspace scoped records. */
export function registerAppPluginRoutes(options: AppPluginRoutesOptions): void {
	const { app, agents, appPlugins, pluginWorkspace, workspaces } = options;
	const pluginIdParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u) });
	const recordParams = z.object({
		workspaceId: z.string().uuid(),
		pluginId: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u),
	});
	app.get("/api/app-plugins", async () => appPlugins.list());
	app.post("/api/app-plugins/development-session", async () =>
		agents.getOrCreatePluginDevelopmentSession(pluginWorkspace.id),
	);
	app.post("/api/app-plugins/install", async (request) => {
		const { manifestJson } = z
			.object({ manifestJson: z.string().min(1).max(96_000) })
			.strict()
			.parse(request.body);
		const plugin = await appPlugins.install(parseAppPluginManifest(manifestJson));
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.post("/api/app-plugins/import", async (request) => {
		const { workspaceId, manifestPath } = z
			.object({
				workspaceId: z.string().uuid(),
				manifestPath: z.string().trim().min(1).max(512).default(".allweave/plugins/plugin.json"),
			})
			.strict()
			.parse(request.body);
		const content = await workspaces.readPluginManifest(workspaceId, manifestPath);
		const plugin = await appPlugins.install(parseAppPluginManifest(content));
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.post("/api/app-plugins/:id/enable", async (request) => {
		const { id } = pluginIdParams.parse(request.params);
		const plugin = await appPlugins.setEnabled(id, true);
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.post("/api/app-plugins/:id/disable", async (request) => {
		const { id } = pluginIdParams.parse(request.params);
		const plugin = await appPlugins.setEnabled(id, false);
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.delete("/api/app-plugins/:id", async (request) => {
		const { id } = pluginIdParams.parse(request.params);
		await appPlugins.remove(id);
		await agents.refreshIdleAgentsForPluginChange();
		return { removed: true };
	});
	app.get("/api/workspaces/:workspaceId/app-plugins/:pluginId/records", async (request) => {
		const { workspaceId, pluginId } = recordParams.parse(request.params);
		workspaces.get(workspaceId);
		return appPlugins.listRecords(pluginId, workspaceId);
	});
	app.post("/api/workspaces/:workspaceId/app-plugins/:pluginId/records", async (request) => {
		const { workspaceId, pluginId } = recordParams.parse(request.params);
		workspaces.get(workspaceId);
		return appPlugins.createRecord(pluginId, workspaceId, request.body);
	});
	app.patch("/api/workspaces/:workspaceId/app-plugins/:pluginId/records/:recordId", async (request) => {
		const { workspaceId, pluginId, recordId } = recordParams
			.extend({ recordId: z.string().uuid() })
			.parse(request.params);
		workspaces.get(workspaceId);
		return appPlugins.updateRecord(pluginId, workspaceId, recordId, request.body);
	});
	app.delete("/api/workspaces/:workspaceId/app-plugins/:pluginId/records/:recordId", async (request) => {
		const { workspaceId, pluginId, recordId } = recordParams
			.extend({ recordId: z.string().uuid() })
			.parse(request.params);
		workspaces.get(workspaceId);
		await appPlugins.deleteRecord(pluginId, workspaceId, recordId);
		return { deleted: true };
	});
}
