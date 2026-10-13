import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contained, tokenMatches, workspacePath } from "../src/security.ts";

test("workspace paths reject traversal, private configuration and directory links", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-security-"));
	try {
		const root = join(directory, "project");
		const outside = join(directory, "outside");
		await mkdir(root);
		await mkdir(outside);
		await writeFile(join(root, "readme.md"), "hello");
		await writeFile(join(root, ".env"), "secret");
		assert.equal(await workspacePath(root, "readme.md"), join(root, "readme.md"));
		assert.equal(await workspacePath(root, "new/nested/file.ts", true), join(root, "new/nested/file.ts"));
		await assert.rejects(workspacePath(root, "../outside"), /outside/);
		await assert.rejects(workspacePath(root, ".env"), /Private/);
		await assert.rejects(workspacePath(root, ".pi/settings.json", true), /Private/);
		if (process.platform === "win32") {
			await assert.rejects(workspacePath(root, ".ENV"), /Private/);
			await assert.rejects(workspacePath(root, ".env ", true), /Private/);
		}
		await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(workspacePath(root, "linked/file.ts", true), /links|escapes/);
		assert.equal(contained(root, `${root}-other`), false);
		assert.equal(tokenMatches("token", "token"), true);
		assert.equal(tokenMatches("bad", "token"), false);
	} finally {
		assert.ok(contained(tmpdir(), directory));
		await rm(directory, { recursive: true, force: true });
	}
});
