import { createHash } from "node:crypto";
import { access, lstat, mkdir, open as openFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, type PlatformPath, posix, win32 } from "node:path";
import { withPathMutation } from "@pi-console/kernel";
import type { FileContent, FileEntry, Workspace } from "../../../shared/src/protocol.ts";
import { type GitOperations, gitRoot, localGitOperations } from "../git.ts";
import { contained, HttpError, workspacePath } from "../security.ts";
import { officePreview } from "./office-preview.ts";

const maxEditableFileBytes = 1024 * 1024;
const maxLargeFilePreviewBytes = 256 * 1024;
const hiddenFileNames = new Set(["node_modules", ".git", ".pi", ".pi-console", ".env"]);

/** API-level file operations for one workspace. Paths are workspace-relative. */
export interface WorkspaceFiles {
	list(path: string): Promise<FileEntry[]>;
	read(path: string, allowLargePreview?: boolean): Promise<FileContent>;
	readImage(path: string): Promise<{ base64: string; mime: string }>;
	readDocument(path: string): Promise<{ base64: string }>;
	write(path: string, content: string, revision: string): Promise<FileContent>;
}

/** An authorized host path resolved from a workspace-relative or tool-relative input. */
export interface WorkspaceToolPath {
	/** Host-absolute path. */
	path: string;
	/** Path relative to the workspace root, using the host separator. */
	relative: string;
	/** Key for path mutation serialization. */
	mutationKey: string;
	paths: PlatformPath;
}

/** File operations used by Pi tools. Inputs keep the existing tool-relative semantics. */
export interface WorkspaceTools {
	check(path: string, allowMissing?: boolean, signal?: AbortSignal): Promise<WorkspaceToolPath>;
	readBuffer(path: string, signal?: AbortSignal): Promise<Buffer>;
	access(path: string, signal?: AbortSignal): Promise<void>;
	write(path: string, content: string, signal?: AbortSignal): Promise<void>;
	mkdir(path: string, signal?: AbortSignal): Promise<void>;
	imageMimeType(path: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface WorkspaceAccessOptions {
	store: WorkspaceStore;
	roots?: () => string[];
	pluginWorkspace?: () => Workspace | undefined;
}

/** The storage operations the workspace lookup needs. */
export interface WorkspaceStore {
	workspaces(): Workspace[];
}

async function readLocalContent(root: string, path: string, allowLargePreview = false): Promise<FileContent> {
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
}

async function detectImageMimeType(file: string): Promise<string | undefined> {
	const content = await readFile(file).catch(() => undefined);
	if (!content) return undefined;
	if (
		content.length >= 8 &&
		content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	)
		return "image/png";
	if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
	if (content.length >= 6 && content.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
	if (
		content.length >= 12 &&
		content.subarray(0, 4).toString("ascii") === "RIFF" &&
		content.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (content.length >= 2 && content.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	return undefined;
}

function localFiles(workspace: Workspace): WorkspaceFiles {
	const root = workspace.path;
	return {
		async list(path) {
			const target = await workspacePath(root, path);
			const entries = await readdir(target, { withFileTypes: true });
			const files: FileEntry[] = [];
			for (const entry of entries) {
				const protectedName = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
				if (entry.isSymbolicLink() || hiddenFileNames.has(protectedName) || protectedName.startsWith(".env."))
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
		},
		read: (path, allowLargePreview) => readLocalContent(root, path, allowLargePreview),
		async readDocument(path) {
			const target = await workspacePath(root, path);
			const info = await stat(target);
			if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new HttpError(413, "文档必须小于 20 MB");
			return officePreview(await readFile(target), path);
		},
		async readImage(path) {
			const target = await workspacePath(root, path);
			const info = await stat(target);
			if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new HttpError(413, "图片必须小于 10 MB");
			const mime = await detectImageMimeType(target);
			if (!mime) throw new HttpError(415, "不支持此图片格式");
			return { base64: (await readFile(target)).toString("base64"), mime };
		},
		async write(path, content, revision) {
			const target = await workspacePath(root, path);
			return withPathMutation(target, async () => {
				const current = await readLocalContent(root, path);
				if (current.revision !== revision)
					throw new HttpError(409, "The file changed on disk. Reload before saving.");
				await writeFile(await workspacePath(root, path), content, "utf8");
				return readLocalContent(root, path);
			});
		},
	};
}

function localTools(workspace: Workspace, cwd: string): WorkspaceTools {
	const paths = process.platform === "win32" ? win32 : posix;
	return {
		async check(path, allowMissing = false) {
			const target = await workspacePath(cwd, path, allowMissing);
			return {
				path: target,
				relative: paths.relative(workspace.path, target),
				mutationKey: target,
				paths,
			};
		},
		readBuffer: async (path) => readFile(await workspacePath(cwd, path)),
		access: async (path) => {
			await access(await workspacePath(cwd, path));
		},
		write: async (path, content) => {
			await writeFile(await workspacePath(cwd, path, true), content, "utf8");
		},
		mkdir: async (path) => {
			await mkdir(await workspacePath(cwd, path, true), { recursive: true });
		},
		imageMimeType: async (path) => (await detectImageMimeType(await workspacePath(cwd, path))) ?? undefined,
	};
}

export class WorkspaceAccess {
	private store: WorkspaceStore;
	private roots: () => string[];
	private pluginWorkspace: () => Workspace | undefined;

	constructor(options: WorkspaceAccessOptions) {
		this.store = options.store;
		this.roots = options.roots ?? (() => []);
		this.pluginWorkspace = options.pluginWorkspace ?? (() => undefined);
	}

	list(): Workspace[] {
		return this.store.workspaces();
	}

	/** Authorized workspace lookup shared by HTTP routes and agent tools. */
	get(id: string): Workspace {
		const workspace = this.store.workspaces().find((item) => item.id === id);
		const plugin = this.pluginWorkspace();
		const roots = this.roots();
		if (
			!workspace ||
			(!roots.some((root) => contained(root, workspace.path)) &&
				!(
					workspace.kind === "plugin-development" &&
					workspace.id === plugin?.id &&
					workspace.path === plugin?.path
				))
		)
			throw new HttpError(404, "Authorized workspace not found");
		return workspace;
	}

	files(workspace: Workspace): WorkspaceFiles {
		return localFiles(workspace);
	}

	tools(workspace: Workspace, cwd: string): WorkspaceTools {
		return localTools(workspace, cwd);
	}

	async git(workspace: Workspace): Promise<{ root: string; operations: GitOperations }> {
		const operations = localGitOperations;
		return { root: await gitRoot(workspace.path, operations), operations };
	}

	async prepareMcpConfigs(_workspace: Workspace, _directory: string): Promise<void> {}
}
