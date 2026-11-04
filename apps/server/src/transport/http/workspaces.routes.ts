import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LocalFolderListing } from "../../../../shared/src/protocol.ts";
import type { AgentService } from "../../agent.ts";
import { HttpError } from "../../security.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";
import { fileQuery, idParams } from "./schemas.ts";

export interface WorkspaceRoutesOptions {
	app: FastifyInstance;
	workspaces: WorkspaceService;
	agents: AgentService;
}

/**
 * Workbench HTTP routes for local workspaces, files, Git and MCP config.
 */
export function registerWorkspaceRoutes(options: WorkspaceRoutesOptions): void {
	const { app, workspaces, agents } = options;

	app.get("/api/local-folders", async (request): Promise<LocalFolderListing> => {
		const { path } = z.object({ path: z.string().max(4096).optional() }).parse(request.query);
		return workspaces.browseLocal(path);
	});
	app.post("/api/local-folders/pick", async () => ({ path: await workspaces.pickFolder() }));
	app.get("/api/workspaces", async () => workspaces.list());
	app.post("/api/workspaces", async (request) => {
		const input = z
			.object({
				path: z.string().min(1).max(4096),
				name: z.string().min(1).max(100).optional(),
				authorize: z.boolean().default(false),
			})
			.parse(request.body);
		return workspaces.add(input);
	});
	app.patch("/api/workspaces/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		const { name } = z
			.object({ name: z.string().trim().min(1).max(100) })
			.strict()
			.parse(request.body);
		return workspaces.rename(id, name);
	});
	app.delete("/api/workspaces/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		return workspaces.remove(id, (workspaceId) => agents.deleteWorkspaceSessions(workspaceId));
	});
	app.get("/api/plugins/mcp-config", async (request) => {
		const { workspaceId, kind } = z
			.object({ workspaceId: z.string().uuid(), kind: z.enum(["adapter", "extension"]) })
			.parse(request.query);
		return workspaces.readMcpConfig(workspaceId, kind);
	});
	app.put("/api/plugins/mcp-config", async (request) => {
		const input = z
			.object({
				workspaceId: z.string().uuid(),
				kind: z.enum(["adapter", "extension"]),
				content: z.string().max(512_000),
			})
			.parse(request.body);
		let parsed: unknown;
		try {
			parsed = JSON.parse(input.content);
		} catch {
			throw new HttpError(400, "MCP config must be valid JSON");
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed) ||
			!("mcpServers" in parsed) ||
			typeof parsed.mcpServers !== "object" ||
			parsed.mcpServers === null ||
			Array.isArray(parsed.mcpServers)
		) {
			throw new HttpError(400, "MCP config must contain an mcpServers object");
		}
		const content = `${JSON.stringify(parsed, null, 2)}\n`;
		await workspaces.writeMcpConfig(input.workspaceId, input.kind, content);
		await agents.refreshIdleAgentsForPluginChange();
		return { saved: true, path: input.kind === "adapter" ? ".mcp.json" : ".pi/mcp.json" };
	});
	app.get("/api/plugins/git", async (request) => {
		const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.query);
		return workspaces.repositoryStatus(workspaceId);
	});
	app.get("/api/workspaces/:id/git", async (request) => workspaces.changes(idParams.parse(request.params).id));
	app.get("/api/workspaces/:id/git/diff", async (request) => {
		const input = z
			.object({ path: z.string().min(1).max(4096), staged: z.enum(["true", "false"]).default("false") })
			.parse(request.query);
		return workspaces.diff(idParams.parse(request.params).id, input.path, input.staged === "true");
	});
	app.post("/api/workspaces/:id/git/index", async (request) => {
		const input = z
			.object({ path: z.string().min(1).max(4096), staged: z.boolean(), revision: z.string().length(64) })
			.strict()
			.parse(request.body);
		return workspaces.changeIndex(idParams.parse(request.params).id, input.path, input.staged, input.revision);
	});
	app.post("/api/workspaces/:id/git/commit", async (request) => {
		const input = z
			.object({ message: z.string().trim().min(1).max(4000), revision: z.string().length(64) })
			.strict()
			.parse(request.body);
		return workspaces.commit(idParams.parse(request.params).id, input.message, input.revision);
	});
	app.post("/api/workspaces/:id/git/branches", async (request) => {
		const input = z
			.object({
				action: z.enum(["create", "switch", "delete"]),
				name: z.string().min(1).max(200),
				revision: z.string().length(64),
				base: z.string().min(1).max(200).optional(),
			})
			.strict()
			.parse(request.body);
		const workspace = workspaces.get(idParams.parse(request.params).id);
		if (
			input.action === "switch" &&
			agents
				.list()
				.some(
					(session) =>
						session.workspaceId === workspace.id &&
						(session.status === "running" || session.status === "approval"),
				)
		)
			throw new HttpError(409, "此项目有任务正在执行，请停止任务后切换分支。");
		return workspaces.changeBranch(workspace.id, input.action, input.name, input.revision, input.base);
	});
	app.post("/api/plugins/git/worktrees", async (request) => {
		const input = z
			.object({
				workspaceId: z.string().uuid(),
				mode: z.enum(["existing", "new"]),
				branch: z.string().trim().min(1).max(120),
				baseBranch: z.string().trim().min(1).max(120).optional(),
			})
			.parse(request.body);
		const workspace = await workspaces.addWorktree(input);
		const session = await agents.create(workspace.id, `工作树 · ${input.branch}`);
		return { workspace, session };
	});
	app.get("/api/workspaces/:id/files", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path } = fileQuery.parse(request.query);
		return workspaces.files(id).list(path);
	});
	app.get("/api/workspaces/:id/file", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path, preview } = fileQuery.parse(request.query);
		return workspaces.files(id).read(path, preview === "true");
	});
	app.get("/api/workspaces/:id/image", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path } = fileQuery.parse(request.query);
		return workspaces.files(id).readImage(path);
	});
	app.get("/api/workspaces/:id/document", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path } = fileQuery.parse(request.query);
		return workspaces.files(id).readDocument(path);
	});
	app.put("/api/workspaces/:id/file", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path, content, revision } = z
			.object({
				path: z.string().min(1).max(4096),
				content: z.string().max(1024 * 1024),
				revision: z.string().length(64),
			})
			.parse(request.body);
		return workspaces.files(id).write(path, content, revision);
	});
}
