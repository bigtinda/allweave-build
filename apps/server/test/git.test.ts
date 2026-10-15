import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changeGitBranch, changeGitIndex, commitGit, gitChanges, gitDiff, gitRoot } from "../src/git.ts";

test("Git panel stages exact paths, preserves other changes and validates commit snapshots", async () => {
	const root = await mkdtemp(join(tmpdir(), "allweave-git-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
	try {
		run("init", "-b", "main");
		run("config", "user.name", "UI test");
		run("config", "user.email", "ui-test@example.invalid");
		await writeFile(join(root, "first file.txt"), "original\n");
		await writeFile(join(root, "other.txt"), "other\n");
		let state = await gitChanges(await gitRoot(root));
		assert.equal(state.files.length, 2);
		assert.match((await gitDiff(root, "first file.txt", false)).text, /\+original/);
		state = await changeGitIndex(root, "first file.txt", true, state.indexRevision);
		assert.equal(state.files.find((file) => file.path === "other.txt")?.index, "?");
		state = await changeGitIndex(root, "first file.txt", false, state.indexRevision);
		assert.equal(state.files.find((file) => file.path === "first file.txt")?.index, "?");
		state = await changeGitIndex(root, "first file.txt", true, state.indexRevision);
		await commitGit(root, "fixture: initial file", state.indexRevision);
		assert.equal(run("ls-files").trim(), "first file.txt");
		await writeFile(join(root, "first file.txt"), "updated\n");
		state = await gitChanges(root);
		assert.match((await gitDiff(root, "first file.txt", false)).text, /-original[\s\S]*\+updated/);
		const revision = state.indexRevision;
		state = await changeGitIndex(root, "first file.txt", true, revision);
		await assert.rejects(commitGit(root, "stale", revision), /暂存区或分支已变化/);
		assert.match((await gitDiff(root, "first file.txt", true)).text, /\+updated/);
		state = await changeGitIndex(root, "first file.txt", false, state.indexRevision);
		assert.equal(state.files.find((file) => file.path === "first file.txt")?.index, " ");
		await assert.rejects(changeGitIndex(root, "../outside", true, state.indexRevision), /outside/);
		await assert.rejects(gitDiff(root, ".git/config", false), /Private/);
		await writeFile(join(root, ".env"), "private\n");
		assert.equal(
			(await gitChanges(root)).files.some((file) => file.path === ".env"),
			false,
		);
		run("add", "--", ".env");
		state = await gitChanges(root);
		state = await changeGitIndex(root, "first file.txt", true, state.indexRevision);
		await assert.rejects(commitGit(root, "private", state.indexRevision), /Private/);
		await mkdir(join(root, "nested"));
		await assert.rejects(gitRoot(join(root, "nested")), /根目录/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("branches require clean switching and refuse deleting unmerged work", async () => {
	const root = await mkdtemp(join(tmpdir(), "allweave-branches-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
	try {
		run("init", "-b", "main");
		run("config", "user.name", "UI test");
		run("config", "user.email", "ui-test@example.invalid");
		await writeFile(join(root, "file.txt"), "base\n");
		let state = await gitChanges(root);
		state = await changeGitIndex(root, "file.txt", true, state.indexRevision);
		await commitGit(root, "fixture: base", state.indexRevision);
		state = await gitChanges(root);
		state = await changeGitBranch(root, "create", "feature", state.indexRevision, "main");
		assert.equal(state.branch, "main");
		assert.ok(state.branches.includes("feature"));
		const oldRevision = state.indexRevision;
		state = await changeGitBranch(root, "switch", "feature", state.indexRevision);
		await assert.rejects(changeGitBranch(root, "delete", "main", oldRevision), /仓库状态已变化/);
		await assert.rejects(changeGitBranch(root, "delete", "feature", state.indexRevision), /当前分支/);
		await writeFile(join(root, "file.txt"), "feature\n");
		await assert.rejects(changeGitBranch(root, "switch", "main", state.indexRevision), /存在改动/);
		state = await changeGitIndex(root, "file.txt", true, state.indexRevision);
		await commitGit(root, "fixture: feature", state.indexRevision);
		state = await gitChanges(root);
		state = await changeGitBranch(root, "switch", "main", state.indexRevision);
		await assert.rejects(changeGitBranch(root, "delete", "feature", state.indexRevision), /not fully merged/);
		state = await changeGitBranch(root, "create", "merged", state.indexRevision, "main");
		state = await changeGitBranch(root, "delete", "merged", state.indexRevision);
		assert.equal(state.branches.includes("merged"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
