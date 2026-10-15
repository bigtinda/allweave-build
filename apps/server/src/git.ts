import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { GitChange, GitChanges, GitDiff } from "../../shared/src/protocol.ts";
import { HttpError, workspacePath } from "./security.ts";

function git(root: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["--literal-pathspecs", ...args],
			{
				cwd: root,
				windowsHide: true,
				encoding: "utf8",
				timeout: 30_000,
				maxBuffer: 2 * 1024 * 1024,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			},
			(error, stdout, stderr) => {
				if (error) reject(new HttpError(400, stderr.trim() || error.message));
				else resolve(stdout);
			},
		);
	});
}

export async function gitRoot(workspace: string): Promise<string> {
	const canonical = await realpath(workspace);
	let root: string;
	try {
		root = await realpath((await git(canonical, ["rev-parse", "--show-toplevel"])).trim());
	} catch {
		throw new HttpError(400, "该项目不是 Git 仓库，或本机尚未安装 Git。");
	}
	if (relative(canonical, root) !== "") throw new HttpError(403, "请将 Git 仓库根目录添加为项目，再管理其改动。");
	return root;
}

export interface GitSnapshot {
	root: string;
	head: string;
	files: Map<string, string>;
}

export async function captureGitSnapshot(workspace: string): Promise<GitSnapshot> {
	const root = await gitRoot(workspace);
	const [status, head] = await Promise.all([
		git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
		git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
	]);
	const files = new Map<string, string>();
	for (const entry of status.split("\0").filter(Boolean)) {
		const path = entry.slice(3);
		try {
			const target = await workspacePath(root, path, true);
			const content = await readFile(target).catch((error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return Buffer.from("<deleted>");
				throw error;
			});
			const digest = createHash("sha256").update(content).digest("hex");
			files.set(path, `${entry.slice(0, 2)}:${digest}`);
		} catch {
			// Private files and paths rejected by workspacePath are excluded from summaries.
		}
	}
	return { root, head: head.trim(), files };
}

export async function changedGitFiles(before: GitSnapshot, after: GitSnapshot): Promise<string[]> {
	const changed = new Set<string>();
	for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
		if (before.files.get(path) !== after.files.get(path)) changed.add(path);
	}
	if (before.root === after.root && before.head && after.head && before.head !== after.head) {
		const committed = await git(before.root, [
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			before.head,
			after.head,
		]).catch(() => "");
		for (const path of committed.split("\0").filter(Boolean)) {
			try {
				await workspacePath(before.root, path, true);
				changed.add(path);
			} catch {
				// Keep private configuration paths out of conversation history.
			}
		}
	}
	return [...changed].sort((left, right) => left.localeCompare(right));
}

export async function gitChanges(root: string): Promise<GitChanges> {
	const [status, branch, head, index, branches] = await Promise.all([
		git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
		git(root, ["branch", "--show-current"]),
		git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
		git(root, ["ls-files", "--stage", "-z"]),
		git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]),
	]);
	const files: GitChange[] = [];
	for (const entry of status.split("\0").filter(Boolean)) {
		const path = entry.slice(3);
		// Keep the same private-file and symlink restrictions as the file browser.
		try {
			await workspacePath(root, path, true);
		} catch {
			continue;
		}
		const code = entry.slice(0, 2);
		files.push({
			path,
			index: code[0],
			working: code[1],
			conflict: ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code),
		});
	}
	return {
		branch: branch.trim() || "detached HEAD",
		branches: branches.trim().split(/\r?\n/u).filter(Boolean),
		head: head.trim(),
		indexRevision: createHash("sha256").update(branch).update(head).update(index).digest("hex"),
		files,
	};
}

export async function changeGitBranch(
	root: string,
	action: "create" | "switch" | "delete",
	name: string,
	revision: string,
	base?: string,
): Promise<GitChanges> {
	return withFileMutationQueue(join(root, ".git-console-index"), async () => {
		const state = await gitChanges(root);
		if (state.indexRevision !== revision) throw new HttpError(409, "仓库状态已变化，请刷新后重试。");
		await git(root, ["check-ref-format", "--branch", name]);
		if (action === "create") {
			if (!base || !state.branches.includes(base)) throw new HttpError(400, "请选择现有本地分支作为起点。");
			await git(root, ["branch", name, base]);
		} else {
			if (!state.branches.includes(name)) throw new HttpError(409, "分支已不存在，请刷新。");
			if (action === "switch") {
				// Include protected files in this check, even though they are not previewable.
				if ((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).trim())
					throw new HttpError(409, "工作区存在改动，请先提交或在终端处理后切换分支。");
				await git(root, ["switch", name]);
			} else {
				if (name === state.branch) throw new HttpError(409, "不能删除当前分支，请先切换。");
				await git(root, ["branch", "--delete", name]);
			}
		}
		return gitChanges(root);
	});
}

export async function gitDiff(root: string, path: string, staged: boolean): Promise<GitDiff> {
	const target = await workspacePath(root, path, true);
	const state = await gitChanges(root);
	const file = state.files.find((item) => item.path === path);
	if (!file) throw new HttpError(409, "文件改动已变化，请刷新列表。");
	if (file.index === "?" && !staged) {
		if ((await stat(target)).size > 1024 * 1024) throw new HttpError(413, "新文件超过 1 MB，无法预览。");
		const content = await readFile(target);
		return {
			text: content.includes(0)
				? "二进制文件，无法显示文本差异。"
				: content
						.toString("utf8")
						.split("\n")
						.map((line) => `+${line}`)
						.join("\n"),
			binary: content.includes(0),
		};
	}
	const text = await git(root, [
		"diff",
		...(staged ? ["--cached"] : []),
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		"--",
		path,
	]);
	return {
		text: text || "没有可显示的文本差异。",
		binary: text.startsWith("Binary files") || text.includes("\nBinary files"),
	};
}

export async function changeGitIndex(
	root: string,
	path: string,
	staged: boolean,
	revision: string,
): Promise<GitChanges> {
	return withFileMutationQueue(join(root, ".git-console-index"), async () => {
		await workspacePath(root, path, true);
		const state = await gitChanges(root);
		if (state.indexRevision !== revision) throw new HttpError(409, "暂存区已被其他操作修改，请刷新后重试。");
		const file = state.files.find((item) => item.path === path);
		if (!file || file.conflict) throw new HttpError(409, "文件已变化或存在冲突，请先处理并刷新。");
		await git(
			root,
			staged
				? ["add", "--", path]
				: state.head
					? ["restore", "--staged", "--", path]
					: ["update-index", "--force-remove", "--", path],
		);
		return gitChanges(root);
	});
}

export async function commitGit(root: string, message: string, revision: string): Promise<{ output: string }> {
	return withFileMutationQueue(join(root, ".git-console-index"), async () => {
		const state = await gitChanges(root);
		if (state.indexRevision !== revision) throw new HttpError(409, "暂存区或分支已变化，请重新检查提交文件。");
		if (state.files.some((file) => file.conflict)) throw new HttpError(409, "请先解决合并冲突。");
		const staged = state.files.filter((file) => file.index !== " " && file.index !== "?");
		if (!staged.length) throw new HttpError(400, "请先暂存要提交的文件。");
		// Reject hidden/private staged paths rather than silently committing them.
		const paths = (await git(root, ["diff", "--cached", "--name-only", "-z", "--no-renames"]))
			.split("\0")
			.filter(Boolean);
		for (const path of paths) await workspacePath(root, path, true);
		for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
			const path = (await git(root, ["rev-parse", "--git-path", name])).trim();
			if (await stat(resolve(root, path)).catch(() => undefined))
				throw new HttpError(409, "仓库正在合并、变基或拣选提交，请先在终端完成。");
		}
		return { output: (await git(root, ["commit", "-m", message])).trim() };
	});
}
