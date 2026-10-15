import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
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
	Workspace,
} from "../../shared/src/protocol.ts";
import { AgentService } from "./agent.ts";
import { BrowserService, browserCommand } from "./browser.ts";
import { changeGitBranch, changeGitIndex, commitGit, gitChanges, gitDiff, gitRoot } from "./git.ts";
import { PiPackageManager } from "./packages.ts";
import { ProviderManager } from "./providers.ts";
import { importSkillPackage, stagePluginPackage } from "./resource-imports.ts";
import { contained, HttpError, tokenMatches, workspacePath } from "./security.ts";
import { StorageManager } from "./storage.ts";
import { ConsoleStore } from "./store.ts";

const idParams = z.object({ id: z.string().uuid() });
const fileQuery = z.object({ path: z.string().max(4096).default(".") });
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
	for (const root of roots) {
		if (!store.workspaceWasRemoved(root) && !store.workspaces().some((workspace) => workspace.path === root)) {
			store.saveWorkspace({ id: randomUUID(), name: basename(root) || root, path: root });
		}
	}
	const agentDirectory = resolve(process.env.PI_CODING_AGENT_DIR ?? join(options.directory, "agent"));
	const providers = new ProviderManager(agentDirectory);
	const browser = new BrowserService([...allowedOrigins]);
	const agents = new AgentService(store, options.directory, {
		createSession: options.createSession ?? createAgentSession,
		providers,
		agentDirectory,
		browser,
	});
	providers.setBeforeChange(() => agents.prepareForProviderChange());
	const packages = new PiPackageManager(agentDirectory, agentDirectory, () => agents.prepareForProviderChange());
	const storage = new StorageManager(options.directory, agentDirectory, store, agents);
	const app = Fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024 });
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
	app.get("/api/workspaces", async () => store.workspaces());
	app.post("/api/workspaces", async (request) => {
		const input = z
			.object({
				path: z.string().min(1).max(4096),
				name: z.string().min(1).max(100).optional(),
				authorize: z.boolean().default(false),
			})
			.parse(request.body);
		const path = await realpath(resolve(input.path));
		if (!(await stat(path)).isDirectory()) throw new HttpError(400, "Workspace must be a directory");
		if (!roots.some((root) => contained(root, path))) {
			if (!input.authorize) throw new HttpError(403, "Authorize this folder before adding it as a workspace");
			await authorizeRoot(path);
		}
		const existing = store.workspaces().find((workspace) => workspace.path === path);
		if (existing) return existing;
		const workspace: Workspace = { id: randomUUID(), path, name: input.name ?? basename(path) };
		store.saveWorkspace(workspace);
		return workspace;
	});
	app.patch("/api/workspaces/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		const workspace = workspaceFor(id);
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
		const sessionsDeleted = await agents.deleteWorkspaceSessions(id);
		store.deleteWorkspace(id, workspace.path);
		return { deleted: true, sessionsDeleted };
	});
	const workspaceFor = (id: string): Workspace => {
		const workspace = store.workspaces().find((item) => item.id === id);
		if (!workspace || !roots.some((root) => contained(root, workspace.path)))
			throw new HttpError(404, "Authorized workspace not found");
		return workspace;
	};
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
		const path = await mcpConfigFile(workspace.path, input.kind, true);
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
		return { saved: true, path: input.kind === "adapter" ? ".mcp.json" : ".pi/mcp.json" };
	});
	app.get("/api/plugins/git", async (request) => {
		const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.query);
		const workspace = workspaceFor(workspaceId);
		const repositoryPath = await runGit(workspace.path, ["rev-parse", "--show-toplevel"]);
		const [branch, branchOutput, worktreeOutput, statusOutput] = await Promise.all([
			runGit(repositoryPath, ["branch", "--show-current"]),
			runGit(repositoryPath, ["branch", "--format=%(refname:short)"]),
			runGit(repositoryPath, ["worktree", "list", "--porcelain"]),
			runGit(repositoryPath, ["status", "--short"]),
		]);
		return {
			repositoryPath,
			branch,
			branches: branchOutput.split(/\r?\n/u).filter(Boolean),
			worktrees: parseGitWorktrees(worktreeOutput),
			changedFiles: statusOutput.split(/\r?\n/u).filter(Boolean),
		};
	});
	app.get("/api/workspaces/:id/git", async (request) => {
		return gitChanges(await gitRoot(workspaceFor(idParams.parse(request.params).id).path));
	});
	app.get("/api/workspaces/:id/git/diff", async (request) => {
		const input = z
			.object({ path: z.string().min(1).max(4096), staged: z.enum(["true", "false"]).default("false") })
			.parse(request.query);
		return gitDiff(
			await gitRoot(workspaceFor(idParams.parse(request.params).id).path),
			input.path,
			input.staged === "true",
		);
	});
	app.post("/api/workspaces/:id/git/index", async (request) => {
		const input = z
			.object({ path: z.string().min(1).max(4096), staged: z.boolean(), revision: z.string().length(64) })
			.strict()
			.parse(request.body);
		return changeGitIndex(
			await gitRoot(workspaceFor(idParams.parse(request.params).id).path),
			input.path,
			input.staged,
			input.revision,
		);
	});
	app.post("/api/workspaces/:id/git/commit", async (request) => {
		const input = z
			.object({ message: z.string().trim().min(1).max(4000), revision: z.string().length(64) })
			.strict()
			.parse(request.body);
		return commitGit(
			await gitRoot(workspaceFor(idParams.parse(request.params).id).path),
			input.message,
			input.revision,
		);
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
		return changeGitBranch(await gitRoot(workspace.path), input.action, input.name, input.revision, input.base);
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
		const repositoryPath = await runGit(workspace.path, ["rev-parse", "--show-toplevel"]);
		await runGit(repositoryPath, ["check-ref-format", "--branch", input.branch]);
		const statusOutput = await runGit(repositoryPath, ["worktree", "list", "--porcelain"]);
		if (parseGitWorktrees(statusOutput).some((worktree) => worktree.branch === input.branch)) {
			throw new HttpError(409, "This branch is already checked out in a worktree");
		}
		const targetName = input.branch.replace(/[\\/]+/gu, "-");
		const target = join(options.directory, "worktrees", input.workspaceId, targetName);
		await mkdir(dirname(target), { recursive: true });
		if (await lstat(target).catch(() => undefined)) throw new HttpError(409, "Worktree destination already exists");
		if (input.mode === "existing") {
			await runGit(repositoryPath, ["worktree", "add", target, input.branch]);
		} else {
			if (!input.baseBranch) throw new HttpError(400, "Choose a base branch for the new worktree");
			await runGit(repositoryPath, ["check-ref-format", "--branch", input.baseBranch]);
			await runGit(repositoryPath, ["worktree", "add", "-b", input.branch, target, input.baseBranch]);
		}
		const path = await realpath(target);
		await authorizeRoot(path);
		const nextWorkspace: Workspace = { id: randomUUID(), name: input.branch, path };
		store.saveWorkspace(nextWorkspace);
		const session = await agents.create(nextWorkspace.id, `工作树 · ${input.branch}`);
		return { workspace: nextWorkspace, session };
	});
	app.get("/api/workspaces/:id/files", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path } = fileQuery.parse(request.query);
		const workspace = workspaceFor(id);
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
	const readContent = async (root: string, path: string): Promise<FileContent> => {
		const target = await workspacePath(root, path);
		const stats = await stat(target);
		if (!stats.isFile() || stats.size > 1024 * 1024)
			throw new HttpError(413, "Only text files up to 1 MB can be edited");
		const buffer = await readFile(target);
		if (buffer.includes(0)) throw new HttpError(415, "Binary file preview is not supported");
		return { path, content: buffer.toString("utf8"), revision: createHash("sha256").update(buffer).digest("hex") };
	};
	app.get("/api/workspaces/:id/file", async (request) => {
		const { id } = idParams.parse(request.params);
		const { path } = fileQuery.parse(request.query);
		return readContent(workspaceFor(id).path, path);
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
		const root = workspaceFor(id).path;
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
		workspaceFor(input.workspaceId);
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
		const { text, references, interrupt } = z
			.object({
				text: z.string().trim().min(1).max(100_000),
				references: z.array(z.string().max(4096)).max(20).default([]),
				interrupt: z.boolean().default(false),
			})
			.parse(request.body);
		const { id } = idParams.parse(request.params);
		if (interrupt) await agents.interrupt(id, text, references);
		else await agents.prompt(id, text, references);
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
	app.get("/api/sessions/:id/browser", async (request) => browser.snapshot(idParams.parse(request.params).id));
	app.post("/api/sessions/:id/browser", async (request) => {
		const command = browserCommand.parse(request.body);
		return browser.run(idParams.parse(request.params).id, command);
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
