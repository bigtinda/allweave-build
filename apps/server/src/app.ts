import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open as openFile, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, VERSION, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import type {
	AccessMode,
	FileContent,
	FileEntry,
	LocalFolder,
	LocalFolderListing,
	SessionDetail,
	Workspace,
} from "../../shared/src/protocol.ts";
import { AgentService } from "./agent.ts";
import { AppPluginManager, parseAppPluginManifest } from "./app-plugins.ts";
import { BrowserService, browserCommand } from "./browser.ts";
import { changeGitBranch, changeGitIndex, commitGit, gitChanges, gitDiff, gitRoot, localGitOperations } from "./git.ts";
import { PiPackageManager } from "./packages.ts";
import { ProviderManager } from "./providers.ts";
import { RemoteWorkspaceService } from "./remote-workspaces.ts";
import { importSkillPackage, stagePluginPackage } from "./resource-imports.ts";
import { contained, HttpError, tokenMatches, workspacePath } from "./security.ts";
import { StorageManager } from "./storage.ts";
import { ConsoleStore } from "./store.ts";

const idParams = z.object({ id: z.string().uuid() });
const fileQuery = z.object({ path: z.string().max(4096).default("."), preview: z.enum(["true", "false"]).optional() });
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const accessMode = z.enum(["plan", "ask", "auto", "full"]);
const resourceImportFiles = z
	.array(z.object({ path: z.string().min(1).max(2048), base64: z.string().max(10_000_000) }).strict())
	.min(1)
	.max(300);
const hiddenDirectoryNames = new Set([
	".git",
	".pi",
	".pi-console",
	"node_modules",
	"system volume information",
	"$recycle.bin",
]);
const maxEditableFileBytes = 1024 * 1024;
const maxLargeFilePreviewBytes = 256 * 1024;

function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			output = `${output}${chunk.toString()}`.slice(-256_000);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			output = `${output}${chunk.toString()}`.slice(-256_000);
		});
		child.once("error", rejectPromise);
		child.once("close", (code) => {
			if (code === 0) resolvePromise(output.trim());
			else
				rejectPromise(new Error(output.trim() || `git ${args.join(" ")} exited with status ${code ?? "unknown"}`));
		});
	});
}

function parseGitWorktrees(output: string): Array<{ path: string; branch: string }> {
	const worktrees: Array<{ path: string; branch: string }> = [];
	let path = "";
	let branch = "";
	for (const line of output.split(/\r?\n/u)) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
		else if (!line && path) {
			worktrees.push({ path, branch });
			path = "";
			branch = "";
		}
	}
	if (path) worktrees.push({ path, branch });
	return worktrees;
}

function pickWindowsFolder(): Promise<string | undefined> {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms",
		"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
		"$dialog.Description = '选择要授权给构序的项目文件夹'",
		"$dialog.ShowNewFolderButton = $false",
		"$dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer",
		"try {",
		"  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
		"    [Console]::Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($dialog.SelectedPath)))",
		"  }",
		"} finally { $dialog.Dispose() }",
	].join("\n");
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			output = `${output}${chunk.toString("ascii")}`.slice(-8192);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
		});
		child.once("error", rejectPromise);
		child.once("close", (code) => {
			if (code !== 0) {
				rejectPromise(new Error(stderr.trim() || `Windows folder picker exited with status ${code ?? "unknown"}`));
				return;
			}
			const encodedPath = output.trim();
			if (!encodedPath) {
				resolvePromise(undefined);
				return;
			}
			const path = Buffer.from(encodedPath, "base64").toString("utf16le");
			if (!path || path.includes("\u0000")) {
				rejectPromise(new Error("Windows folder picker returned an invalid path"));
				return;
			}
			resolvePromise(path);
		});
	});
}

export interface AppOptions {
	directory: string;
	roots: string[];
	port: number;
	logger?: boolean;
	createSession?: typeof createAgentSession;
	remoteWorkspaces?: RemoteWorkspaceService;
}

export async function createApp(options: AppOptions) {
	let roots = await Promise.all(options.roots.map((root) => realpath(resolve(root))));
	if (!roots.length) throw new Error("At least one authorized workspace root is required");
	await mkdir(options.directory, { recursive: true });
	const rootsFile = join(options.directory, "authorized-roots.json");
	const savedRoots = await readFile(rootsFile, "utf8")
		.then((content) => JSON.parse(content) as unknown)
		.catch(() => []);
	if (Array.isArray(savedRoots)) {
		for (const savedRoot of savedRoots) {
			if (typeof savedRoot !== "string") continue;
			const canonical = await realpath(resolve(savedRoot)).catch(() => undefined);
			if (canonical && (await stat(canonical)).isDirectory() && !roots.includes(canonical)) roots.push(canonical);
		}
	}
	const persistRoots = async () => {
		const temporary = `${rootsFile}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(roots, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, rootsFile);
	};
	const authorizeRoot = async (path: string) => {
		if (roots.some((root) => contained(root, path))) return;
		roots = [...roots, path];
		await persistRoots();
	};
	const desktop = process.env.PI_CONSOLE_DESKTOP === "1";
	const desktopShutdownToken = process.env.PI_CONSOLE_SHUTDOWN_TOKEN ?? "";
	const allowedOrigins = new Set([`http://127.0.0.1:${options.port}`, "http://127.0.0.1:5173"]);
	const allowedHosts = new Set([`127.0.0.1:${options.port}`, "127.0.0.1:5173"]);
	const store = new ConsoleStore(options.directory);
	const remoteWorkspaces = options.remoteWorkspaces ?? new RemoteWorkspaceService(options.directory);
	const pluginWorkspacePath = resolve(options.directory, "plugin-workspace");
	await mkdir(pluginWorkspacePath, { recursive: true });
	const canonicalPluginWorkspacePath = await realpath(pluginWorkspacePath);
	await mkdir(join(canonicalPluginWorkspacePath, "plugins"), { recursive: true });
	const existingPluginWorkspace = store
		.workspaces()
		.find(
			(workspace) =>
				workspace.kind === "plugin-development" ||
				(!workspace.remote && workspace.path === canonicalPluginWorkspacePath),
		);
	const pluginWorkspace: Workspace = {
		id: existingPluginWorkspace?.id ?? randomUUID(),
		name: "插件开发",
		path: canonicalPluginWorkspacePath,
		kind: "plugin-development",
	};
	store.saveWorkspace(pluginWorkspace);
	for (const root of roots) {
		if (root === canonicalPluginWorkspacePath) continue;
		if (
			!store.workspaceWasRemoved(root) &&
			!store.workspaces().some((workspace) => !workspace.remote && workspace.path === root)
		) {
			store.saveWorkspace({ id: randomUUID(), name: basename(root) || root, path: root });
		}
	}
	for (const saved of store.sessions()) {
		if (saved.detail.purpose !== "plugin-development" || saved.detail.workspaceId === pluginWorkspace.id) continue;
		saved.detail.workspaceId = pluginWorkspace.id;
		store.saveSession(saved.detail, saved.file);
	}
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
		remoteWorkspaces,
	});
	providers.setBeforeChange(() => agents.prepareForProviderChange());
	const packages = new PiPackageManager(agentDirectory, agentDirectory, () => agents.prepareForProviderChange());
	const storage = new StorageManager(options.directory, agentDirectory, store, agents);
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
		roots,
		kernel: { version: VERSION, integration: "in-process" },
		agentDirectory,
		credentialStorage: "auth.json and models.json in the workbench configuration directory",
		approvals: "Every command, file mutation and custom tool requires confirmation",
		isolation:
			"Authorized file APIs; trusted extensions and approved commands run with host permissions. No sandbox.",
		authentication: "Server credentials and environment variables; never sent to the browser",
	}));
	app.get("/api/providers", async () => providers.list());
	app.get("/api/app-plugins", async () => appPlugins.list());
	let pluginDevelopmentSession: Promise<SessionDetail> | undefined;
	app.post("/api/app-plugins/development-session", async () => {
		if (!pluginDevelopmentSession) {
			pluginDevelopmentSession = (async () => {
				const existing = agents
					.list()
					.find(
						(session) => session.purpose === "plugin-development" && session.workspaceId === pluginWorkspace.id,
					);
				return existing
					? agents.get(existing.id)
					: agents.createPluginDevelopmentSession(pluginWorkspace.id, "插件开发");
			})().finally(() => {
				pluginDevelopmentSession = undefined;
			});
		}
		return pluginDevelopmentSession;
	});
	app.post("/api/app-plugins/install", async (request) => {
		const { manifestJson } = z
			.object({ manifestJson: z.string().min(1).max(96_000) })
			.strict()
			.parse(request.body);
		const plugin = await appPlugins.install(parseAppPluginManifest(manifestJson));
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
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
	app.post("/api/provider-logins", async (request) => {
		const input = z
			.object({ providerId: z.string().min(1).max(100), type: z.enum(["api_key", "oauth"]) })
			.parse(request.body);
		return providers.startLogin(input.providerId, input.type);
	});
	app.get("/api/provider-logins/:id", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		return providers.getLogin(id);
	});
	app.post("/api/provider-logins/:id/answer", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		const { answer } = z.object({ answer: z.string().max(4096) }).parse(request.body);
		providers.answerLogin(id, answer);
		return { accepted: true };
	});
	app.delete("/api/provider-logins/:id", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		providers.cancelLogin(id);
		return { cancelled: true };
	});
	app.delete("/api/providers/:providerId/credentials", async (request) => {
		const { providerId } = z.object({ providerId: z.string().min(1).max(100) }).parse(request.params);
		await providers.logout(providerId);
		return { loggedOut: true };
	});
	app.post("/api/providers/custom", async (request) => providers.addCustomProvider(request.body));
	app.get("/api/local-folders", async (request): Promise<LocalFolderListing> => {
		const { path } = z.object({ path: z.string().max(4096).optional() }).parse(request.query);
		if (!path) {
			const paths: string[] = [];
			if (process.platform === "win32") {
				for (let index = 0; index < 26; index += 1) {
					const candidate = `${String.fromCharCode(65 + index)}:\\`;
					if ((await stat(candidate).catch(() => undefined))?.isDirectory()) paths.push(candidate);
				}
			} else paths.push(resolve("/"));
			const roots: LocalFolder[] = [];
			for (const candidate of paths) {
				if (!(await stat(candidate).catch(() => undefined))?.isDirectory()) continue;
				roots.push({ name: candidate, path: candidate });
			}
			return { roots, directories: [] };
		}
		const target = resolve(path);
		const entry = await lstat(target);
		if (entry.isSymbolicLink() || !entry.isDirectory()) throw new HttpError(400, "Choose a local directory");
		const canonical = await realpath(target);
		const entries = await readdir(canonical, { withFileTypes: true });
		const directories: LocalFolder[] = [];
		for (const child of entries) {
			if (!child.isDirectory() || child.isSymbolicLink()) continue;
			if (hiddenDirectoryNames.has(child.name.toLowerCase())) continue;
			const childPath = join(canonical, child.name);
			const childStats = await lstat(childPath).catch(() => undefined);
			if (!childStats?.isDirectory() || childStats.isSymbolicLink()) continue;
			directories.push({ name: child.name, path: childPath });
		}
		directories.sort((left, right) => left.name.localeCompare(right.name));
		const parent = dirname(canonical);
		return {
			currentPath: canonical,
			...(parent !== canonical ? { parentPath: parent } : {}),
			roots: [],
			directories,
		};
	});
	app.post("/api/local-folders/pick", async () => {
		if (process.platform !== "win32")
			throw new HttpError(501, "The native folder picker is available on Windows only");
		return { path: (await pickWindowsFolder()) ?? null };
	});
	app.get("/api/remote-hosts/trusted", async (request) => {
		const { host } = z.object({ host: z.string().min(1).max(255) }).parse(request.query);
		return { trusted: await remoteWorkspaces.isTrusted(host) };
	});
	app.post("/api/remote-hosts/scan", async (request) => {
		const { host } = z
			.object({ host: z.string().trim().min(1).max(255) })
			.strict()
			.parse(request.body);
		return remoteWorkspaces.scan(host);
	});
	app.post("/api/remote-hosts/trust", async (request) => {
		const { host, fingerprint, replace } = z
			.object({
				host: z.string().trim().min(1).max(255),
				fingerprint: z.string().trim().min(1).max(512),
				replace: z.boolean().optional(),
			})
			.strict()
			.parse(request.body);
		return remoteWorkspaces.trust(host, fingerprint, replace);
	});
	app.get("/api/remote-hosts/folders", async (request) => {
		const input = z
			.object({ host: z.string().min(1).max(255), path: z.string().max(4096).optional() })
			.parse(request.query);
		return remoteWorkspaces.browse(input.host, input.path);
	});
	app.get("/api/workspaces", async () => store.workspaces());
	app.post("/api/workspaces", async (request) => {
		const input = z
			.object({
				path: z.string().min(1).max(4096),
				name: z.string().min(1).max(100).optional(),
				remoteHost: z.string().trim().min(1).max(255).optional(),
				authorize: z.boolean().default(false),
			})
			.parse(request.body);
		if (input.remoteHost) {
			const path = await remoteWorkspaces.addWorkspace(input.remoteHost, input.path);
			const existing = store
				.workspaces()
				.find(
					(workspace) =>
						workspace.remote?.host.toLowerCase() === input.remoteHost!.toLowerCase() && workspace.path === path,
				);
			if (existing) return existing;
			const name =
				input.name ??
				path
					.split(/[\\/]+/u)
					.filter(Boolean)
					.at(-1) ??
				input.remoteHost;
			const workspace: Workspace = { id: randomUUID(), path, name, remote: { host: input.remoteHost } };
			store.saveWorkspace(workspace);
			return workspace;
		}
		const path = await realpath(resolve(input.path));
		if (!(await stat(path)).isDirectory()) throw new HttpError(400, "Workspace must be a directory");
		if (!roots.some((root) => contained(root, path))) {
			if (!input.authorize) throw new HttpError(403, "Authorize this folder before adding it as a workspace");
			await authorizeRoot(path);
		}
		if (path === pluginWorkspace.path) throw new HttpError(409, "插件开发工作区由系统管理");
		const existing = store.workspaces().find((workspace) => !workspace.remote && workspace.path === path);
		if (existing) return existing;
		const workspace: Workspace = { id: randomUUID(), path, name: input.name ?? basename(path) };
		store.saveWorkspace(workspace);
		return workspace;
	});
	app.patch("/api/workspaces/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		const workspace = workspaceFor(id);
		if (workspace.kind === "plugin-development") throw new HttpError(409, "插件开发工作区名称固定");
		const { name } = z
			.object({ name: z.string().trim().min(1).max(100) })
			.strict()
			.parse(request.body);
		const updated = { ...workspace, name };
		store.saveWorkspace(updated);
		return updated;
	});
	app.delete("/api/workspaces/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		const workspace = workspaceFor(id);
		if (workspace.kind === "plugin-development") throw new HttpError(409, "插件开发工作区不能删除");
		const sessionsDeleted = await agents.deleteWorkspaceSessions(id);
		store.deleteWorkspace(id, workspace.path, !workspace.remote);
		return { deleted: true, sessionsDeleted };
	});
	const workspaceFor = (id: string): Workspace => {
		const workspace = store.workspaces().find((item) => item.id === id);
		if (
			!workspace ||
			(!workspace.remote &&
				!roots.some((root) => contained(root, workspace.path)) &&
				!(
					workspace.kind === "plugin-development" &&
					workspace.id === pluginWorkspace.id &&
					workspace.path === pluginWorkspace.path
				))
		)
			throw new HttpError(404, "Authorized workspace not found");
		return workspace;
	};
	const gitFor = async (workspace: Workspace) => {
		const operations = workspace.remote ? await remoteWorkspaces.gitOperations(workspace) : localGitOperations;
		return { root: await gitRoot(workspace.path, operations), operations };
	};
	app.post("/api/app-plugins/import", async (request) => {
		const { workspaceId, manifestPath } = z
			.object({
				workspaceId: z.string().uuid(),
				manifestPath: z.string().trim().min(1).max(512).default(".allweave/plugins/plugin.json"),
			})
			.strict()
			.parse(request.body);
		if (/^(?:[\\/]|[A-Za-z]:)/u.test(manifestPath)) throw new HttpError(400, "插件清单路径必须是工作区相对路径");
		const workspace = workspaceFor(workspaceId);
		const content = workspace.remote
			? (await remoteWorkspaces.readFile(workspace, manifestPath)).content
			: await readFile(await workspacePath(workspace.path, manifestPath), "utf8");
		const plugin = await appPlugins.install(parseAppPluginManifest(content));
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.post("/api/app-plugins/:id/enable", async (request) => {
		const { id } = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u) }).parse(request.params);
		const plugin = await appPlugins.setEnabled(id, true);
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.post("/api/app-plugins/:id/disable", async (request) => {
		const { id } = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u) }).parse(request.params);
		const plugin = await appPlugins.setEnabled(id, false);
		await agents.refreshIdleAgentsForPluginChange();
		return plugin;
	});
	app.delete("/api/app-plugins/:id", async (request) => {
		const { id } = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u) }).parse(request.params);
		await appPlugins.remove(id);
		await agents.refreshIdleAgentsForPluginChange();
		return { removed: true };
	});
	app.get("/api/workspaces/:workspaceId/app-plugins/:pluginId/records", async (request) => {
		const { workspaceId, pluginId } = z
			.object({
				workspaceId: z.string().uuid(),
				pluginId: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u),
			})
			.parse(request.params);
		workspaceFor(workspaceId);
		return appPlugins.listRecords(pluginId, workspaceId);
	});
	app.post("/api/workspaces/:workspaceId/app-plugins/:pluginId/records", async (request) => {
		const { workspaceId, pluginId } = z
			.object({
				workspaceId: z.string().uuid(),
				pluginId: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u),
			})
			.parse(request.params);
		workspaceFor(workspaceId);
		return appPlugins.createRecord(pluginId, workspaceId, request.body);
	});
	app.patch("/api/workspaces/:workspaceId/app-plugins/:pluginId/records/:recordId", async (request) => {
		const { workspaceId, pluginId, recordId } = z
			.object({
				workspaceId: z.string().uuid(),
				pluginId: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u),
				recordId: z.string().uuid(),
			})
			.parse(request.params);
		workspaceFor(workspaceId);
		return appPlugins.updateRecord(pluginId, workspaceId, recordId, request.body);
	});
	app.delete("/api/workspaces/:workspaceId/app-plugins/:pluginId/records/:recordId", async (request) => {
		const { workspaceId, pluginId, recordId } = z
			.object({
				workspaceId: z.string().uuid(),
				pluginId: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u),
				recordId: z.string().uuid(),
			})
			.parse(request.params);
		workspaceFor(workspaceId);
		await appPlugins.deleteRecord(pluginId, workspaceId, recordId);
		return { deleted: true };
	});
	const mcpConfigFile = async (root: string, kind: "adapter" | "extension", createParent = false) => {
		const canonicalRoot = await realpath(root);
		const target = resolve(canonicalRoot, kind === "adapter" ? ".mcp.json" : join(".pi", "mcp.json"));
		if (!contained(canonicalRoot, target)) throw new HttpError(403, "MCP config path is outside the workspace");
		const parent = dirname(target);
		if (parent !== canonicalRoot) {
			const parentStats = await lstat(parent).catch(() => undefined);
			if (parentStats?.isSymbolicLink()) throw new HttpError(403, "MCP config cannot use linked directories");
			if (parentStats && !parentStats.isDirectory())
				throw new HttpError(400, "MCP config parent must be a directory");
			if (!parentStats && createParent) await mkdir(parent);
		}
		const fileStats = await lstat(target).catch(() => undefined);
		if (fileStats?.isSymbolicLink()) throw new HttpError(403, "MCP config cannot be a symbolic link");
		if (fileStats && !fileStats.isFile()) throw new HttpError(400, "MCP config path must be a file");
		return target;
	};
	app.get("/api/plugins/mcp-config", async (request) => {
		const { workspaceId, kind } = z
			.object({ workspaceId: z.string().uuid(), kind: z.enum(["adapter", "extension"]) })
			.parse(request.query);
		const workspace = workspaceFor(workspaceId);
		if (workspace.remote) return remoteWorkspaces.readMcpConfig(workspace, kind);
		const path = await mcpConfigFile(workspace.path, kind);
		const content = await readFile(path, "utf8").catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return '{\n  "mcpServers": {}\n}\n';
			throw error;
		});
		return { path: kind === "adapter" ? ".mcp.json" : ".pi/mcp.json", content };
	});
	app.put("/api/plugins/mcp-config", async (request) => {
		const input = z
			.object({
				workspaceId: z.string().uuid(),
				kind: z.enum(["adapter", "extension"]),
				content: z.string().max(512_000),
			})
			.parse(request.body);
		const workspace = workspaceFor(input.workspaceId);
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
		if (workspace.remote) await remoteWorkspaces.writeMcpConfig(workspace, input.kind, content);
		else {
			const path = await mcpConfigFile(workspace.path, input.kind, true);
			const temporary = `${path}.${randomUUID()}.tmp`;
			await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, path);
		}
		await agents.refreshIdleAgentsForPluginChange();
		return { saved: true, path: input.kind === "adapter" ? ".mcp.json" : ".pi/mcp.json" };
	});
	app.get("/api/plugins/git", async (request) => {
		const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.query);
		const workspace = workspaceFor(workspaceId);
		const run = workspace.remote
			? (root: string, args: string[]) =>
					remoteWorkspaces.execute(workspace, ["git", "--literal-pathspecs", ...args], root)
			: runGit;
		const repositoryPath = (await run(workspace.path, ["rev-parse", "--show-toplevel"])).trim();
		const [branch, branchOutput, worktreeOutput, statusOutput] = await Promise.all([
			run(repositoryPath, ["branch", "--show-current"]),
			run(repositoryPath, ["branch", "--format=%(refname:short)"]),
			run(repositoryPath, ["worktree", "list", "--porcelain"]),
			run(repositoryPath, ["status", "--short"]),
		]);
		return {
			repositoryPath,
			branch: branch.trim(),
			branches: branchOutput.split(/\r?\n/u).filter(Boolean),
			worktrees: parseGitWorktrees(worktreeOutput),
			changedFiles: statusOutput.split(/\r?\n/u).filter(Boolean),
		};
	});
	app.get("/api/workspaces/:id/git", async (request) => {
		const { root, operations } = await gitFor(workspaceFor(idParams.parse(request.params).id));
		return gitChanges(root, operations);
	});
	app.get("/api/workspaces/:id/git/diff", async (request) => {
		const input = z
			.object({ path: z.string().min(1).max(4096), staged: z.enum(["true", "false"]).default("false") })
			.parse(request.query);
		const { root, operations } = await gitFor(workspaceFor(idParams.parse(request.params).id));
		return gitDiff(root, input.path, input.staged === "true", operations);
	});
	app.post("/api/workspaces/:id/git/index", async (request) => {
		const input = z
			.object({ path: z.string().min(1).max(4096), staged: z.boolean(), revision: z.string().length(64) })
			.strict()
			.parse(request.body);
		const { root, operations } = await gitFor(workspaceFor(idParams.parse(request.params).id));
		return changeGitIndex(root, input.path, input.staged, input.revision, operations);
	});
	app.post("/api/workspaces/:id/git/commit", async (request) => {
		const input = z
			.object({ message: z.string().trim().min(1).max(4000), revision: z.string().length(64) })
			.strict()
			.parse(request.body);
		const { root, operations } = await gitFor(workspaceFor(idParams.parse(request.params).id));
		return commitGit(root, input.message, input.revision, operations);
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
		const workspace = workspaceFor(idParams.parse(request.params).id);
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
		const { root, operations } = await gitFor(workspace);
		return changeGitBranch(root, input.action, input.name, input.revision, input.base, operations);
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
		const workspace = workspaceFor(input.workspaceId);
		const run = workspace.remote
			? (root: string, args: string[]) =>
					remoteWorkspaces.execute(workspace, ["git", "--literal-pathspecs", ...args], root)
			: runGit;
		const repositoryPath = (await run(workspace.path, ["rev-parse", "--show-toplevel"])).trim();
		await run(repositoryPath, ["check-ref-format", "--branch", input.branch]);
		const statusOutput = await run(repositoryPath, ["worktree", "list", "--porcelain"]);
		if (parseGitWorktrees(statusOutput).some((worktree) => worktree.branch === input.branch)) {
			throw new HttpError(409, "This branch is already checked out in a worktree");
		}
		const targetName = input.branch.replace(/[\\/]+/gu, "-");
		const target = workspace.remote
			? await remoteWorkspaces.worktreeTarget(workspace, targetName)
			: join(options.directory, "worktrees", input.workspaceId, targetName);
		if (!workspace.remote) {
			await mkdir(dirname(target), { recursive: true });
			if (await lstat(target).catch(() => undefined))
				throw new HttpError(409, "Worktree destination already exists");
		}
		if (input.mode === "existing") {
			await run(repositoryPath, ["worktree", "add", target, input.branch]);
		} else {
			if (!input.baseBranch) throw new HttpError(400, "Choose a base branch for the new worktree");
			await run(repositoryPath, ["check-ref-format", "--branch", input.baseBranch]);
			await run(repositoryPath, ["worktree", "add", "-b", input.branch, target, input.baseBranch]);
		}
		const path = workspace.remote
			? await remoteWorkspaces.addWorkspace(workspace.remote.host, target)
			: await realpath(target);
		if (!workspace.remote) await authorizeRoot(path);
		const nextWorkspace: Workspace = {
			id: randomUUID(),
			name: input.branch,
			path,
			...(workspace.remote ? { remote: workspace.remote } : {}),
		};
		store.saveWorkspace(nextWorkspace);
		const session = await agents.create(nextWorkspace.id, `工作树 · ${input.branch}`);
		return { workspace: nextWorkspace, session };
	});
	app.get("/api/workspaces/:id/files", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path } = fileQuery.parse(request.query);
		const workspace = workspaceFor(id);
		if (workspace.remote) return remoteWorkspaces.listFiles(workspace, path);
		const target = await workspacePath(workspace.path, path);
		const entries = await readdir(target, { withFileTypes: true });
		const files: FileEntry[] = [];
		for (const entry of entries) {
			const protectedName = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
			if (
				entry.isSymbolicLink() ||
				["node_modules", ".git", ".pi", ".pi-console", ".env"].includes(protectedName) ||
				protectedName.startsWith(".env.")
			)
				continue;
			const child = join(target, entry.name);
			const stats = await lstat(child);
			files.push({
				name: entry.name,
				path: path === "." ? entry.name : `${path}/${entry.name}`,
				directory: stats.isDirectory(),
				size: stats.size,
				modifiedAt: stats.mtime.toISOString(),
			});
		}
		return files.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
	});
	const readContent = async (root: string, path: string, allowLargePreview = false): Promise<FileContent> => {
		const target = await workspacePath(root, path);
		const stats = await stat(target);
		if (!stats.isFile() || (stats.size > maxEditableFileBytes && !allowLargePreview))
			throw new HttpError(413, "Only text files up to 1 MB can be edited");
		const truncated = stats.size > maxEditableFileBytes;
		let buffer: Buffer;
		if (truncated) {
			const handle = await openFile(target, "r");
			try {
				const preview = Buffer.alloc(maxLargeFilePreviewBytes);
				const { bytesRead } = await handle.read(preview, 0, preview.length, 0);
				buffer = preview.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		} else buffer = await readFile(target);
		if (buffer.includes(0)) throw new HttpError(415, "Binary file preview is not supported");
		const content = new TextDecoder("utf-8").decode(buffer, { stream: truncated });
		return {
			path,
			content,
			revision: createHash("sha256").update(buffer).digest("hex"),
			...(truncated ? { truncated: true } : {}),
		};
	};
	app.get("/api/workspaces/:id/file", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path, preview } = fileQuery.parse(request.query);
		const workspace = workspaceFor(id);
		return workspace.remote
			? remoteWorkspaces.readFile(workspace, path, preview === "true")
			: readContent(workspace.path, path, preview === "true");
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
		const workspace = workspaceFor(id);
		if (workspace.remote) {
			const checked = await remoteWorkspaces.checkedPath(workspace, path);
			const queueKey = remoteWorkspaces.mutationKey(workspace, checked.path, checked.paths);
			return withFileMutationQueue(queueKey, async () => {
				const current = await remoteWorkspaces.readFile(workspace, path);
				if (current.revision !== revision) {
					throw new HttpError(409, "文件已在远程主机上发生变化，请重新加载后保存。");
				}
				await remoteWorkspaces.writeFile(workspace, path, content);
				return remoteWorkspaces.readFile(workspace, path);
			});
		}
		const root = workspace.path;
		const target = await workspacePath(root, path);
		return withFileMutationQueue(target, async () => {
			const current = await readContent(root, path);
			if (current.revision !== revision) throw new HttpError(409, "The file changed on disk. Reload before saving.");
			await writeFile(await workspacePath(root, path), content, "utf8");
			return readContent(root, path);
		});
	});
	app.get("/api/sessions", async () => agents.list());
	app.post("/api/sessions", async (request) => {
		const input = z
			.object({ workspaceId: z.string().uuid(), title: z.string().min(1).max(120).default("新会话") })
			.parse(request.body);
		const workspace = workspaceFor(input.workspaceId);
		if (workspace.kind === "plugin-development") throw new HttpError(409, "请从插件开发入口创建开发会话");
		return agents.create(input.workspaceId, input.title);
	});
	// Re-authorize persisted workspaces on every session route, including WebSocket.
	app.addHook("preHandler", async (request) => {
		const match = request.url.match(/^\/(?:api|ws)\/sessions\/([^/?]+)/);
		if (match) workspaceFor(agents.get(z.string().uuid().parse(match[1])).workspaceId);
	});
	app.get("/api/sessions/:id", async (request) => agents.get(idParams.parse(request.params).id));
	app.patch("/api/sessions/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		agents.rename(id, z.object({ title: z.string().min(1).max(120) }).parse(request.body).title);
		return agents.get(id);
	});
	app.delete("/api/sessions/:id", async (request) => {
		await agents.delete(idParams.parse(request.params).id);
		return { deleted: true };
	});
	app.post("/api/sessions/:id/messages", async (request, reply) => {
		const { text, attachments, references, interrupt } = z
			.object({
				text: z.string().trim().min(1).max(100_000),
				attachments: z
					.array(z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(100_000) }))
					.max(6)
					.default([]),
				references: z.array(z.string().max(4096)).max(20).default([]),
				interrupt: z.boolean().default(false),
			})
			.parse(request.body);
		const { id } = idParams.parse(request.params);
		const prompt =
			text +
			attachments
				.map(
					(file) =>
						`\n\nAttached text file ${JSON.stringify(file.name)}:\n<attachment>\n${file.content}\n</attachment>`,
				)
				.join("");
		if (interrupt) await agents.interrupt(id, prompt, references);
		else await agents.prompt(id, prompt, references);
		return reply.code(202).send({ accepted: true });
	});
	app.post("/api/sessions/:id/recall", async (request) => {
		const { messageId } = z
			.object({ messageId: z.string().min(1).max(200) })
			.strict()
			.parse(request.body);
		return agents.recall(idParams.parse(request.params).id, messageId);
	});
	app.post("/api/sessions/:id/branch", async (request) => {
		const { messageId } = z
			.object({ messageId: z.string().min(1).max(200) })
			.strict()
			.parse(request.body);
		return agents.branch(idParams.parse(request.params).id, messageId);
	});
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
		const unsubscribe = browser.subscribe(id, (event) => {
			if (socket.readyState !== 1) return;
			if (socket.bufferedAmount > 2 * 1024 * 1024) {
				if (event.type === "state") socket.close(1013, "Reconnect for current browser state");
				return;
			}
			socket.send(JSON.stringify(event));
		});
		const heartbeat = setInterval(() => {
			if (socket.readyState === 1) socket.ping();
		}, 30_000);
		const cleanup = () => {
			unsubscribe();
			clearInterval(heartbeat);
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	});
	app.post("/api/sessions/:id/abort", async (request) => {
		await agents.abort(idParams.parse(request.params).id);
		return { stopped: true };
	});
	app.put("/api/sessions/:id/model", async (request) => {
		const input = z
			.object({ provider: z.string(), modelId: z.string(), thinkingLevel: thinkingLevel.optional() })
			.parse(request.body);
		const { id } = idParams.parse(request.params);
		await agents.setModel(id, input.provider, input.modelId, input.thinkingLevel);
		return agents.get(id);
	});
	app.put("/api/sessions/:id/access-mode", async (request) => {
		const { id } = idParams.parse(request.params);
		const input = z.object({ accessMode }).parse(request.body);
		return agents.setAccessMode(id, input.accessMode as AccessMode);
	});
	app.post("/api/sessions/:id/approvals/:approvalId", async (request) => {
		const { id, approvalId } = z
			.object({ id: z.string().uuid(), approvalId: z.string().uuid() })
			.parse(request.params);
		agents.approve(id, approvalId, z.object({ approved: z.boolean() }).parse(request.body).approved);
		return { accepted: true };
	});
	app.get("/api/models", async (request) => {
		const { sessionId } = z.object({ sessionId: z.string().uuid().optional() }).parse(request.query);
		if (sessionId) workspaceFor(agents.get(sessionId).workspaceId);
		return agents.models(sessionId);
	});
	app.get("/api/skills", async (request) => {
		const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.query);
		workspaceFor(agents.get(sessionId).workspaceId);
		return agents.resources(sessionId);
	});
	app.post("/api/skills/import", { bodyLimit: 12 * 1024 * 1024 }, async (request) => {
		const { files } = z.object({ files: resourceImportFiles }).strict().parse(request.body);
		return importSkillPackage(agentDirectory, files);
	});
	app.get("/ws/sessions/:id", { websocket: true }, (socket, request) => {
		const { id } = idParams.parse(request.params);
		// Subscribe and snapshot synchronously: no event can fall between these operations.
		const unsubscribe = agents.subscribe(id, (event) => {
			if (socket.readyState !== 1) return;
			if (socket.bufferedAmount > 4 * 1024 * 1024) {
				socket.close(1013, "Reconnect for latest snapshot");
				return;
			}
			socket.send(JSON.stringify(event));
		});
		socket.send(JSON.stringify({ type: "session.snapshot", session: agents.get(id) }));
		let alive = true;
		socket.on("pong", () => {
			alive = true;
		});
		const heartbeat = setInterval(() => {
			if (!alive) {
				socket.terminate();
				return;
			}
			alive = false;
			socket.ping();
		}, 30_000);
		const cleanup = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	});
	const frontend = fileURLToPath(new URL("../../web/dist/", import.meta.url));
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
		store.close();
	});
	if (!options.createSession) void packages.ensureDefaultPackages();
	return { app };
}

export function configuredRoots(fallback: string): string[] {
	return process.env.PI_CONSOLE_ROOTS?.split(delimiter).filter(Boolean) ?? [fallback];
}
