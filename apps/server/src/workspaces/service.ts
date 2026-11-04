import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { LocalFolder, LocalFolderListing, Workspace } from "../../../shared/src/protocol.ts";
import { changeGitBranch, changeGitIndex, commitGit, gitChanges, gitDiff, localGitOperations } from "../git.ts";
import { contained, HttpError } from "../security.ts";
import type { ConsoleStore } from "../store.ts";
import type { WorkspaceFiles } from "./workspace-access.ts";
import { WorkspaceAccess } from "./workspace-access.ts";

const hiddenDirectoryNames = new Set([
	".git",
	".pi",
	".pi-console",
	"node_modules",
	"system volume information",
	"$recycle.bin",
]);

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

export interface WorkspaceServiceOptions {
	directory: string;
	roots: string[];
	store: ConsoleStore;
}

export interface AddWorkspaceInput {
	path: string;
	name?: string;
	authorize: boolean;
}

export interface WorktreeInput {
	workspaceId: string;
	mode: "existing" | "new";
	branch: string;
	baseBranch?: string;
}

export interface RepositoryStatus {
	repositoryPath: string;
	branch: string;
	branches: string[];
	worktrees: Array<{ path: string; branch: string }>;
	changedFiles: string[];
}

export class WorkspaceService {
	readonly access: WorkspaceAccess;
	private directory: string;
	private store: ConsoleStore;
	private configuredRoots: string[];
	private roots: string[] = [];
	private pluginWorkspace: Workspace = { id: "", name: "插件开发", path: "", kind: "plugin-development" };

	constructor(options: WorkspaceServiceOptions) {
		this.directory = options.directory;
		this.store = options.store;
		this.configuredRoots = options.roots;
		this.access = new WorkspaceAccess({
			store: options.store,
			roots: () => this.roots,
			pluginWorkspace: () => this.pluginWorkspace,
		});
	}

	/** Canonicalize configured roots, restore saved roots and seed the plugin workspace. */
	async initialize(): Promise<Workspace> {
		const roots = await Promise.all(this.configuredRoots.map((root) => realpath(resolve(root))));
		if (!roots.length) throw new Error("At least one authorized workspace root is required");
		await mkdir(this.directory, { recursive: true });
		const rootsFile = join(this.directory, "authorized-roots.json");
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
		this.roots = roots;
		const pluginWorkspacePath = resolve(this.directory, "plugin-workspace");
		await mkdir(pluginWorkspacePath, { recursive: true });
		const canonicalPluginWorkspacePath = await realpath(pluginWorkspacePath);
		await mkdir(join(canonicalPluginWorkspacePath, "plugins"), { recursive: true });
		const existingPluginWorkspace = this.store
			.workspaces()
			.find(
				(workspace) =>
					workspace.kind === "plugin-development" ||
					(!workspace.remote && workspace.path === canonicalPluginWorkspacePath),
			);
		this.pluginWorkspace = {
			id: existingPluginWorkspace?.id ?? randomUUID(),
			name: "插件开发",
			path: canonicalPluginWorkspacePath,
			kind: "plugin-development",
		};
		this.store.saveWorkspace(this.pluginWorkspace);
		for (const root of roots) {
			if (root === canonicalPluginWorkspacePath) continue;
			if (
				!this.store.workspaceWasRemoved(root) &&
				!this.store.workspaces().some((workspace) => !workspace.remote && workspace.path === root)
			) {
				this.store.saveWorkspace({ id: randomUUID(), name: basename(root) || root, path: root });
			}
		}
		return this.pluginWorkspace;
	}

	rootsSnapshot(): string[] {
		return [...this.roots];
	}

	list(): Workspace[] {
		return this.access.list();
	}

	get(id: string): Workspace {
		return this.access.get(id);
	}

	files(id: string): WorkspaceFiles {
		return this.access.files(this.get(id));
	}

	async readPluginManifest(id: string, path: string): Promise<string> {
		if (/^(?:[\\/]|[A-Za-z]:)/u.test(path)) throw new HttpError(400, "插件清单路径必须是工作区相对路径");
		return (await this.files(id).read(path)).content;
	}

	async git(id: string) {
		const workspace = this.get(id);
		return this.access.git(workspace);
	}

	private async persistRoots(): Promise<void> {
		const rootsFile = join(this.directory, "authorized-roots.json");
		const temporary = `${rootsFile}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.roots, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, rootsFile);
	}

	private async authorizeRoot(path: string): Promise<void> {
		if (this.roots.some((root) => contained(root, path))) return;
		this.roots = [...this.roots, path];
		await this.persistRoots();
	}

	async add(input: AddWorkspaceInput): Promise<Workspace> {
		const path = await realpath(resolve(input.path));
		if (!(await stat(path)).isDirectory()) throw new HttpError(400, "Workspace must be a directory");
		if (!this.roots.some((root) => contained(root, path))) {
			if (!input.authorize) throw new HttpError(403, "Authorize this folder before adding it as a workspace");
			await this.authorizeRoot(path);
		}
		if (path === this.pluginWorkspace.path) throw new HttpError(409, "插件开发工作区由系统管理");
		const existing = this.store.workspaces().find((workspace) => workspace.path === path);
		if (existing) return existing;
		const workspace: Workspace = { id: randomUUID(), path, name: input.name ?? basename(path) };
		this.store.saveWorkspace(workspace);
		return workspace;
	}

	rename(id: string, name: string): Workspace {
		const workspace = this.get(id);
		if (workspace.kind === "plugin-development") throw new HttpError(409, "插件开发工作区名称固定");
		const updated = { ...workspace, name };
		this.store.saveWorkspace(updated);
		return updated;
	}

	async remove(
		id: string,
		deleteSessions: (workspaceId: string) => Promise<number>,
	): Promise<{ deleted: true; sessionsDeleted: number }> {
		const workspace = this.get(id);
		if (workspace.kind === "plugin-development") throw new HttpError(409, "插件开发工作区不能删除");
		const sessionsDeleted = await deleteSessions(id);
		this.store.deleteWorkspace(id, workspace.path, true);
		return { deleted: true, sessionsDeleted };
	}

	async browseLocal(path?: string): Promise<LocalFolderListing> {
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
	}

	async pickFolder(): Promise<string | null> {
		if (process.platform !== "win32")
			throw new HttpError(501, "The native folder picker is available on Windows only");
		return (await pickWindowsFolder()) ?? null;
	}

	private async mcpConfigFile(root: string, kind: "adapter" | "extension", createParent = false): Promise<string> {
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
	}

	async readMcpConfig(id: string, kind: "adapter" | "extension"): Promise<{ path: string; content: string }> {
		const workspace = this.get(id);
		const path = await this.mcpConfigFile(workspace.path, kind);
		const content = await readFile(path, "utf8").catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return '{\n  "mcpServers": {}\n}\n';
			throw error;
		});
		return { path: kind === "adapter" ? ".mcp.json" : ".pi/mcp.json", content };
	}

	async writeMcpConfig(id: string, kind: "adapter" | "extension", content: string): Promise<void> {
		const workspace = this.get(id);
		const path = await this.mcpConfigFile(workspace.path, kind, true);
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	}

	async repositoryStatus(id: string): Promise<RepositoryStatus> {
		const workspace = this.get(id);
		const operations = localGitOperations;
		const run = operations.run;
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
	}

	async changes(id: string) {
		const { root, operations } = await this.git(id);
		return gitChanges(root, operations);
	}

	async diff(id: string, path: string, staged: boolean) {
		const { root, operations } = await this.git(id);
		return gitDiff(root, path, staged, operations);
	}

	async changeIndex(id: string, path: string, staged: boolean, revision: string) {
		const { root, operations } = await this.git(id);
		return changeGitIndex(root, path, staged, revision, operations);
	}

	async commit(id: string, message: string, revision: string) {
		const { root, operations } = await this.git(id);
		return commitGit(root, message, revision, operations);
	}

	async changeBranch(
		id: string,
		action: "create" | "switch" | "delete",
		name: string,
		revision: string,
		base?: string,
	) {
		const { root, operations } = await this.git(id);
		return changeGitBranch(root, action, name, revision, base, operations);
	}

	async addWorktree(input: WorktreeInput): Promise<Workspace> {
		const workspace = this.get(input.workspaceId);
		const operations = localGitOperations;
		const run = operations.run;
		const repositoryPath = (await run(workspace.path, ["rev-parse", "--show-toplevel"])).trim();
		await run(repositoryPath, ["check-ref-format", "--branch", input.branch]);
		const statusOutput = await run(repositoryPath, ["worktree", "list", "--porcelain"]);
		if (parseGitWorktrees(statusOutput).some((worktree) => worktree.branch === input.branch)) {
			throw new HttpError(409, "This branch is already checked out in a worktree");
		}
		const targetName = input.branch.replace(/[\\/]+/gu, "-");
		const target = join(this.directory, "worktrees", input.workspaceId, targetName);
		await mkdir(dirname(target), { recursive: true });
		if (await lstat(target).catch(() => undefined)) throw new HttpError(409, "Worktree destination already exists");
		if (input.mode === "existing") {
			await run(repositoryPath, ["worktree", "add", target, input.branch]);
		} else {
			if (!input.baseBranch) throw new HttpError(400, "Choose a base branch for the new worktree");
			await run(repositoryPath, ["check-ref-format", "--branch", input.baseBranch]);
			await run(repositoryPath, ["worktree", "add", "-b", input.branch, target, input.baseBranch]);
		}
		const path = await realpath(target);
		await this.authorizeRoot(path);
		const nextWorkspace: Workspace = { id: randomUUID(), name: input.branch, path };
		this.store.saveWorkspace(nextWorkspace);
		return nextWorkspace;
	}
}
