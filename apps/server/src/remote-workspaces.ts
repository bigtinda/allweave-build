import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	dirname,
	join,
	relative as localRelative,
	resolve as localResolve,
	sep as localSeparator,
	type PlatformPath,
	posix,
	win32,
} from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	acceptHostKey,
	forgetHostKey,
	RemoteExecutionEnv,
	type SshTarget,
	scanHostKey,
	sshArguments,
	sshConnection,
} from "@earendil-works/pi-env";
import type { FileContent, FileEntry, LocalFolder, LocalFolderListing, Workspace } from "../../shared/src/protocol.ts";
import type { GitOperations } from "./git.ts";
import { remoteMcpValueCommand, wrapRemoteMcpConfig } from "./remote-mcp.ts";
import { HttpError } from "./security.ts";

const hiddenNames = new Set([
	".git",
	".pi",
	".pi-console",
	".ssh",
	".env",
	"node_modules",
	"system volume information",
	"$recycle.bin",
]);
const maxEditableFileBytes = 1024 * 1024;
const maxLargeFilePreviewBytes = 256 * 1024;

function remoteResult<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

function normalizedPath(path: string, paths: PlatformPath): string {
	return paths === win32 ? path.replaceAll("\\", "/") : path;
}

function isContained(root: string, target: string, paths: PlatformPath): boolean {
	const relativePath = paths.relative(root, target);
	return (
		relativePath === "" ||
		(!paths.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${paths.sep}`))
	);
}

function isHiddenName(name: string, paths: PlatformPath): boolean {
	const normalized = paths === win32 ? name.replace(/[ .]+$/gu, "").toLowerCase() : name;
	return hiddenNames.has(normalized) || normalized.startsWith(".env.");
}

function fileContext(signal?: AbortSignal) {
	return signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
}

export class RemoteWorkspaceService {
	private connections = new Map<string, ReturnType<typeof sshConnection>>();
	private pendingHostKeys = new Map<string, { lines: string[]; fingerprints: string[]; expiresAt: number }>();
	private knownHostsFile: string;

	constructor(directory: string) {
		this.knownHostsFile = join(directory, "ssh", "known_hosts");
	}

	private target(host: string): SshTarget {
		if (!host.trim() || host.startsWith("-") || /[\s\x00-\x1f\x7f]/u.test(host)) {
			throw new HttpError(400, "SSH 主机必须是主机名或 SSH 配置别名");
		}
		const alias = createHash("sha256").update(host.toLowerCase()).digest("hex").slice(0, 20);
		return { host, knownHostsFile: this.knownHostsFile, hostKeyAlias: `pi-console-${alias}` };
	}

	async scan(host: string): Promise<{ fingerprints: string[] }> {
		const target = this.target(host);
		const scanned = await scanHostKey(target);
		this.pendingHostKeys.set(host, {
			lines: scanned.lines,
			fingerprints: scanned.fingerprints,
			expiresAt: Date.now() + 5 * 60_000,
		});
		return { fingerprints: scanned.fingerprints };
	}

	async trust(host: string, fingerprint: string, replace = false): Promise<{ trusted: true }> {
		const staged = this.pendingHostKeys.get(host);
		if (!staged || staged.expiresAt < Date.now()) {
			this.pendingHostKeys.delete(host);
			throw new HttpError(409, "主机密钥扫描已过期，请重新扫描");
		}
		if (!staged.fingerprints.includes(fingerprint)) {
			throw new HttpError(400, "请先确认本次扫描显示的主机指纹");
		}
		const target = this.target(host);
		if (replace) await forgetHostKey(target);
		await acceptHostKey(target, staged.lines);
		this.connections.get(host)?.connection.close();
		this.connections.delete(host);
		this.pendingHostKeys.delete(host);
		return { trusted: true };
	}

	async isTrusted(host: string): Promise<boolean> {
		const alias = this.target(host).hostKeyAlias;
		const contents = await readFile(this.knownHostsFile, "utf8").catch(() => "");
		return contents.split(/\r?\n/u).some((line) => line.startsWith(`${alias} `));
	}

	private connection(host: string): ReturnType<typeof sshConnection> {
		let connection = this.connections.get(host);
		if (!connection) {
			connection = sshConnection(this.target(host));
			this.connections.set(host, connection);
		}
		return connection;
	}

	async environment(host: string, cwd = "."): Promise<{ env: RemoteExecutionEnv; paths: PlatformPath; home: string }> {
		const connection = this.connection(host).connection;
		const info = await connection.info();
		return {
			env: new RemoteExecutionEnv({ connection, id: `pi-console:${host.toLowerCase()}`, cwd }),
			paths: info.os === "windows" ? win32 : posix,
			home: info.home,
		};
	}

	async workspaceEnvironment(workspace: Workspace): Promise<{ env: RemoteExecutionEnv; paths: PlatformPath }> {
		if (!workspace.remote) throw new HttpError(400, "此工作区不是远程主机项目");
		const remote = await this.environment(workspace.remote.host, workspace.path);
		return { env: remote.env, paths: remote.paths };
	}

	async toolPath(workspace: Workspace, localProjectDirectory: string, toolPath: string): Promise<string> {
		const relativePath = localRelative(localResolve(localProjectDirectory), localResolve(toolPath));
		const { paths } = await this.workspaceEnvironment(workspace);
		return paths.resolve(workspace.path, ...relativePath.split(localSeparator));
	}

	mutationKey(workspace: Workspace, path: string, paths: PlatformPath): string {
		if (!workspace.remote) throw new HttpError(400, "此工作区不是远程主机项目");
		const key = createHash("sha256")
			.update(workspace.remote.host.toLowerCase())
			.update("\0")
			.update(paths === win32 ? path.toLowerCase() : path)
			.digest("hex");
		// The SDK queue expects a local path, even when the remote filename is invalid on this OS.
		return join(dirname(this.knownHostsFile), "file-locks", key);
	}

	async addWorkspace(host: string, path: string): Promise<string> {
		const { env, paths } = await this.environment(host);
		const context = BACKGROUND_CONTEXT;
		const canonical = remoteResult(await env.canonicalPath(path, context));
		if (canonical.split(paths.sep).some((part) => isHiddenName(part, paths))) {
			throw new HttpError(403, "不能将私有配置目录作为远程项目");
		}
		const info = remoteResult(await env.fileInfo(canonical, context));
		if (info.kind !== "directory") throw new HttpError(400, "远程项目路径必须是文件夹");
		return canonical;
	}

	async browse(host: string, path?: string): Promise<LocalFolderListing> {
		const { env, paths, home } = await this.environment(host);
		const context = BACKGROUND_CONTEXT;
		const currentPath = remoteResult(await env.canonicalPath(path ?? home, context));
		const currentInfo = remoteResult(await env.fileInfo(currentPath, context));
		if (currentInfo.kind !== "directory") throw new HttpError(400, "远程路径不是文件夹");
		const entries = remoteResult(await env.listDir(currentPath, context));
		const directories: LocalFolder[] = entries
			.filter((entry) => entry.kind === "directory" && !isHiddenName(entry.name, paths))
			.map((entry) => ({ name: entry.name, path: paths.join(currentPath, entry.name) }))
			.sort((left, right) => left.name.localeCompare(right.name));
		const parentPath = paths.dirname(currentPath);
		return {
			currentPath,
			...(parentPath !== currentPath ? { parentPath } : {}),
			roots: [],
			directories,
		};
	}

	async checkedPath(
		workspace: Workspace,
		input: string,
		allowMissing = false,
		signal?: AbortSignal,
	): Promise<{ env: RemoteExecutionEnv; paths: PlatformPath; path: string }> {
		return this.projectPath(workspace, input, allowMissing, signal);
	}

	private async projectPath(
		workspace: Workspace,
		input: string,
		allowMissing = false,
		signal?: AbortSignal,
		mcpConfig = false,
	): Promise<{ env: RemoteExecutionEnv; paths: PlatformPath; path: string }> {
		const { env, paths } = await this.workspaceEnvironment(workspace);
		const context = fileContext(signal);
		if (input.includes("\0") || (paths === win32 && input.replace(/^[A-Za-z]:/u, "").includes(":"))) {
			throw new HttpError(403, "文件路径无效");
		}
		const root = remoteResult(await env.canonicalPath(workspace.path, context));
		if (root.split(paths.sep).some((part) => isHiddenName(part, paths))) {
			throw new HttpError(403, "不能访问私有配置目录");
		}
		const target = remoteResult(await env.absolutePath(input, context));
		if (!isContained(root, target, paths)) throw new HttpError(403, "文件路径超出远程项目目录");
		const relativePath = paths.relative(root, target);
		const parts = relativePath ? relativePath.split(paths.sep) : [];
		if (
			parts.some(
				(part, index) => isHiddenName(part, paths) && !(mcpConfig && index === 0 && part.toLowerCase() === ".pi"),
			)
		) {
			throw new HttpError(403, "控制台不能访问私有配置路径");
		}
		let current = root;
		const rootInfo = remoteResult(await env.fileInfo(root, context));
		if (rootInfo.kind !== "directory") throw new HttpError(403, "远程项目目录不可用");
		for (const part of parts) {
			current = paths.join(current, part);
			const info = await env.fileInfo(current, context);
			if (!info.ok) {
				if (allowMissing && info.error.code === "not_found") break;
				throw info.error;
			}
			if (info.value.kind === "symlink") throw new HttpError(403, "不允许通过符号链接访问远程文件");
			const canonical = remoteResult(await env.canonicalPath(current, context));
			if (!isContained(root, canonical, paths)) throw new HttpError(403, "文件路径逃逸出远程项目目录");
		}
		return { env, paths, path: target };
	}

	async listFiles(workspace: Workspace, directory: string): Promise<FileEntry[]> {
		const { env, paths, path } = await this.checkedPath(workspace, directory);
		const entries = remoteResult(await env.listDir(path, BACKGROUND_CONTEXT));
		const relativeDirectory = normalizedPath(paths.relative(workspace.path, path), paths);
		return entries
			.filter((entry) => entry.kind !== "symlink" && !isHiddenName(entry.name, paths))
			.map((entry) => ({
				name: entry.name,
				path: relativeDirectory === "" ? entry.name : `${relativeDirectory.replaceAll("\\", "/")}/${entry.name}`,
				directory: entry.kind === "directory",
				size: entry.size,
				modifiedAt: new Date(entry.mtimeMs).toISOString(),
			}))
			.sort(
				(left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name),
			);
	}

	async readFile(
		workspace: Workspace,
		path: string,
		allowLargePreview = false,
		signal?: AbortSignal,
	): Promise<FileContent> {
		const context = fileContext(signal);
		const checked = await this.checkedPath(workspace, path, false, signal);
		const info = remoteResult(await checked.env.fileInfo(checked.path, context));
		if (info.kind !== "file") throw new HttpError(415, "只能预览文本文件");
		if (info.size > maxEditableFileBytes && !allowLargePreview) {
			throw new HttpError(413, "只能编辑 1 MB 以内的文件");
		}
		const truncated = info.size > maxEditableFileBytes;
		let buffer: Buffer;
		if (truncated) {
			const opened = remoteResult(await checked.env.openBinaryReader(checked.path, { noFollow: true }, context));
			try {
				buffer = Buffer.from(remoteResult(await opened.read(0, maxLargeFilePreviewBytes, context)));
			} finally {
				await opened.close(context);
			}
		} else {
			buffer = Buffer.from(remoteResult(await checked.env.readBinaryFile(checked.path, context)));
		}
		if (buffer.includes(0)) throw new HttpError(415, "不支持预览二进制文件");
		return {
			path,
			content: new TextDecoder("utf-8").decode(buffer, { stream: truncated }),
			revision: createHash("sha256").update(buffer).digest("hex"),
			...(truncated ? { truncated: true } : {}),
		};
	}

	async writeFile(workspace: Workspace, path: string, content: string, signal?: AbortSignal): Promise<void> {
		const checked = await this.checkedPath(workspace, path, true, signal);
		remoteResult(await checked.env.writeFile(checked.path, content, fileContext(signal)));
	}

	async readBuffer(workspace: Workspace, path: string, signal?: AbortSignal): Promise<Buffer> {
		const checked = await this.checkedPath(workspace, path, false, signal);
		const context = fileContext(signal);
		const info = remoteResult(await checked.env.fileInfo(checked.path, context));
		if (info.kind !== "file") throw new HttpError(415, "只能读取文件");
		return Buffer.from(remoteResult(await checked.env.readBinaryFile(checked.path, context)));
	}

	async createDirectory(workspace: Workspace, path: string, signal?: AbortSignal): Promise<void> {
		const checked = await this.checkedPath(workspace, path, true, signal);
		remoteResult(await checked.env.createDir(checked.path, { recursive: true }, fileContext(signal)));
	}

	async execute(workspace: Workspace, command: string | readonly string[], cwd = workspace.path): Promise<string> {
		const { env } = await this.workspaceEnvironment(workspace);
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		const result = await env.exec(
			command,
			{
				cwd,
				timeout: 30,
				env: { GIT_OPTIONAL_LOCKS: "0" },
				onOutput: (text, _context, info) => {
					bytes += Buffer.byteLength(text);
					if (bytes > 2 * 1024 * 1024) throw new Error("远程命令输出超过 2 MB");
					if (info.stream === "stderr") stderr += text;
					else stdout += text;
				},
			},
			BACKGROUND_CONTEXT,
		);
		if (!result.ok) throw new HttpError(400, result.error.message);
		if (result.value.exitCode !== 0)
			throw new HttpError(400, stderr.trim() || stdout.trim() || `远程命令退出：${result.value.exitCode}`);
		return stdout;
	}

	async gitOperations(workspace: Workspace): Promise<GitOperations> {
		const { env, paths } = await this.workspaceEnvironment(workspace);
		return {
			run: (root, args) => this.execute(workspace, ["git", "--literal-pathspecs", ...args], root),
			canonicalPath: async (path) => remoteResult(await env.canonicalPath(path, BACKGROUND_CONTEXT)),
			checkedPath: async (root, path, allowMissing) =>
				(await this.checkedPath({ ...workspace, path: root }, path, allowMissing)).path,
			readFile: (path) => this.readBuffer(workspace, path),
			stat: async (path) => remoteResult(await env.fileInfo(path, BACKGROUND_CONTEXT)),
			paths,
			lockPath: (root) => this.mutationKey(workspace, paths.join(root, ".git-console-index"), paths),
		};
	}

	async worktreeTarget(workspace: Workspace, name: string): Promise<string> {
		if (!workspace.remote) throw new HttpError(400, "此工作区不是远程主机项目");
		const { env, paths, home } = await this.environment(workspace.remote.host);
		const target = paths.join(home, ".allweave", "worktrees", workspace.id, name);
		const managed = { ...workspace, path: home };
		await this.checkedPath(managed, target, true);
		const info = await env.fileInfo(target, BACKGROUND_CONTEXT);
		if (info.ok) throw new HttpError(409, "远程工作树目录已存在");
		if (info.error.code !== "not_found") throw info.error;
		remoteResult(await env.createDir(paths.dirname(target), { recursive: true }, BACKGROUND_CONTEXT));
		return target;
	}

	async readMcpConfig(
		workspace: Workspace,
		kind: "adapter" | "extension",
	): Promise<{ path: string; content: string }> {
		const path = kind === "adapter" ? ".mcp.json" : ".pi/mcp.json";
		const checked = await this.projectPath(workspace, path, true, undefined, true);
		const info = await checked.env.fileInfo(checked.path, BACKGROUND_CONTEXT);
		if (!info.ok && info.error.code === "not_found") return { path, content: '{\n  "mcpServers": {}\n}\n' };
		const file = remoteResult(info);
		if (file.kind !== "file") throw new HttpError(400, "MCP 配置路径必须是普通文件");
		if (file.size > 512_000) throw new HttpError(413, "MCP 配置超过 512 KB");
		return { path, content: remoteResult(await checked.env.readTextFile(checked.path, BACKGROUND_CONTEXT)) };
	}

	async writeMcpConfig(workspace: Workspace, kind: "adapter" | "extension", content: string): Promise<void> {
		if (Buffer.byteLength(content) > 512_000) throw new HttpError(413, "MCP 配置超过 512 KB");
		const path = kind === "adapter" ? ".mcp.json" : ".pi/mcp.json";
		const checked = await this.projectPath(workspace, path, true, undefined, true);
		await withFileMutationQueue(this.mutationKey(workspace, checked.path, checked.paths), async () => {
			const parent = await this.projectPath(workspace, checked.paths.dirname(checked.path), true, undefined, true);
			remoteResult(await checked.env.createDir(parent.path, { recursive: true }, BACKGROUND_CONTEXT));
			const temporary = `${checked.path}.${randomUUID()}.tmp`;
			try {
				if (checked.paths !== win32)
					await this.execute(workspace, ["sh", "-c", 'umask 077; set -C; : > "$1"', "mcp-config", temporary]);
				remoteResult(await checked.env.writeFile(temporary, content, BACKGROUND_CONTEXT));
				await this.projectPath(workspace, path, true, undefined, true);
				remoteResult(await checked.env.renameFile(temporary, checked.path, BACKGROUND_CONTEXT));
			} finally {
				remoteResult(await checked.env.remove(temporary, { force: true }, BACKGROUND_CONTEXT));
			}
		});
	}

	async prepareMcpConfigs(workspace: Workspace, directory: string): Promise<void> {
		if (!workspace.remote) return;
		const { paths, home } = await this.environment(workspace.remote.host, workspace.path);
		const target = this.target(workspace.remote.host);
		for (const kind of ["adapter", "extension"] as const) {
			const config = await this.readMcpConfig(workspace, kind);
			const content = await wrapRemoteMcpConfig(config.content, {
				paths,
				home,
				root: workspace.path,
				ssh: target.ssh ?? "ssh",
				sshArgs: sshArguments(target),
				resolveValue: (value) =>
					value.startsWith("!") || value.includes("$")
						? this.execute(workspace, remoteMcpValueCommand(paths, value))
						: Promise.resolve(value),
			});
			const localPath = join(directory, ...config.path.split("/"));
			await mkdir(dirname(localPath), { recursive: true });
			await writeFile(localPath, content, { mode: 0o600 });
		}
	}

	async close(): Promise<void> {
		for (const { connection } of this.connections.values()) connection.close();
		this.connections.clear();
	}
}
